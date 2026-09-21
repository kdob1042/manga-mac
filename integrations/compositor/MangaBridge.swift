// Only IPC and editing transactions live here. Upstream owns the document, renderer and .comp writer.
import AppKit
import CryptoKit

@MainActor final class MangaBridge {
    let session: EditorSession
    private let directory: URL
    private let token: String
    private let sessionID: String
    private let isCurrent: () -> Bool
    private var owner = "human"
    private var processing = false
    private var timer: Timer?
    private var documentID: UUID?
    private var completed: Set<String> = []
    private var lastActivity = Date()

    init(directory: URL, session: EditorSession, isCurrent: @escaping () -> Bool) throws {
        let info = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard (info[.posixPermissions] as? NSNumber)?.intValue == 0o700,
              (info[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              directory.resolvingSymlinksInPath().standardizedFileURL == directory.standardizedFileURL else { throw BridgeError.invalid }
        let config = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("connection.json"))) as? [String: Any]
        guard let token = config?["token"] as? String, token.count == 64,
              let id = config?["session"] as? String, UUID(uuidString: id) != nil else { throw BridgeError.invalid }
        self.directory = directory; self.token = token; self.sessionID = id
        self.session = session; self.isCurrent = isCurrent
    }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.poll() }
        }
    }
    private func poll() async {
        guard !processing else { return }
        if owner == "app", Date().timeIntervalSince(lastActivity) > 120 {
            owner = "human"; session.isProjectBusy = false
        }
        let requestURL = directory.appendingPathComponent("request.json")
        guard let data = try? Data(contentsOf: requestURL), data.count <= 96 * 1024 * 1024,
              let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = request["id"] as? String, UUID(uuidString: id) != nil,
              request["token"] as? String == token, request["session"] as? String == sessionID,
              request["protocol"] as? Int == 1 else { return }
        let responseURL = directory.appendingPathComponent("\(id).json")
        guard !completed.contains(id), !FileManager.default.fileExists(atPath: responseURL.path) else { return }
        guard completed.count < 512 else { return }
        processing = true
        lastActivity = Date()
        // Never repeat a mutation after an output-write failure. Its ID remains unresolved.
        completed.insert(id)
        defer { processing = false }
        let response: [String: Any]
        do {
            let value = try await perform(request, id: id)
            response = ["id": id, "session": sessionID, "protocol": 1, "ok": true, "value": value]
        } catch {
            response = ["id": id, "session": sessionID, "protocol": 1, "ok": false, "error": String(describing: error)]
        }
        if let encoded = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) {
            try? encoded.write(to: responseURL, options: .atomic)
        }
    }
    private func state() throws -> [String: Any] {
        guard isCurrent(), let document = session.document, document.id == documentID else { throw BridgeError.documentChanged }
        let layers: [[String: Any]] = document.layers.map { layer in
            ["id": layer.id.uuidString, "name": layer.name, "visible": layer.isVisible,
             "x": layer.transform.origin.x, "y": layer.transform.origin.y,
             "width": layer.transform.size.width, "height": layer.transform.size.height,
             "rotation": layer.transform.rotation, "raster": layer.asset != nil,
             "parent": layer.parentID?.uuidString as Any? ?? NSNull()]
        }
        return ["session": sessionID, "document": document.id.uuidString, "revision": session.mangaRevision,
                "owner": owner, "width": document.width, "height": document.height, "layers": layers]
    }
    private func base(_ request: [String: Any]) throws {
        _ = try state()
        guard request["document"] as? String == documentID?.uuidString,
              (request["revision"] as? NSNumber)?.uint64Value == session.mangaRevision else { throw BridgeError.stale }
    }
    private func perform(_ request: [String: Any], id: String) async throws -> [String: Any] {
        guard isCurrent(), let op = request["op"] as? String else { throw BridgeError.documentChanged }
        if op == "open" {
            guard documentID == nil, session.document == nil, session.canStartProjectOperation else { throw BridgeError.busy }
            session.isProjectBusy = true
            do {
                // Native stages this package only before launch. Never writes to the live package.
                let url = directory.appendingPathComponent("working.comp")
                let snapshot = try await ProjectStore.shared.load(from: url)
                session.installProject(snapshot, from: url)
                documentID = session.document?.id
                owner = "app"
                return try state()
            } catch { session.isProjectBusy = false; throw error }
        }
        if op == "state" { return try state() }
        try base(request)
        if op == "claim" {
            guard owner == "human", session.canStartProjectOperation, session.canEditLayers else { throw BridgeError.busy }
            session.isProjectBusy = true
            owner = "app"
            return try state()
        }
        guard owner == "app", session.isProjectBusy else { throw BridgeError.ownership }
        if op == "handoff" {
            owner = "human"
            session.isProjectBusy = false
            NSApplication.shared.activate()
            return try state()
        }
        if op == "transform" {
            guard let raw = request["layer"] as? String, let layerID = UUID(uuidString: raw),
                  let index = session.document?.layers.firstIndex(where: { $0.id == layerID }),
                  let x = request["x"] as? Double, let y = request["y"] as? Double,
                  let width = request["width"] as? Double, let height = request["height"] as? Double,
                  let rotation = request["rotation"] as? Double, let visible = request["visible"] as? Bool,
                  var transform = session.document?.layers[index].transform else { throw BridgeError.invalid }
            transform.origin = CGPoint(x: x, y: y); transform.size = CGSize(width: width, height: height); transform.rotation = rotation
            guard transform.isValid else { throw BridgeError.invalid }
            session.beginEdit("Manga layer placement")
            session.document?.layers[index].transform = transform
            session.document?.layers[index].isVisible = visible
            session.endEdit()
            return try state()
        }
        if op == "snapshot" {
            guard let snapshot = session.projectSnapshot() else { throw BridgeError.invalid }
            let revision = session.mangaRevision
            let package = directory.appendingPathComponent("\(id).comp")
            try await ProjectStore.shared.save(snapshot, to: package)
            let png = try await ImageExporter.shared.pngData(snapshot)
            guard revision == session.mangaRevision else { throw BridgeError.stale }
            var images: [String: [String: String]] = [:]
            for layer in snapshot.manifest.layers {
                for name in [layer.imageFile, layer.maskFile].compactMap({ $0 }) {
                    let bytes = try Data(contentsOf: package.appendingPathComponent("images").appendingPathComponent(name))
                    images[name] = ["image": "data:image/png;base64," + bytes.base64EncodedString()]
                }
            }
            let manifest = try JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot.manifest))
            let savedState = try state()
            owner = "human"
            session.isProjectBusy = false
            return ["state": savedState, "bundle": ["manifest": manifest, "images": images],
                    "image": "data:image/png;base64," + png.base64EncodedString(),
                    "includes_unsaved_changes": true,
                    "upstream_revision": "c39da13b5db11bc8678ec04a7a748e1e0a589244"]
        }
        throw BridgeError.unsupported
    }
}
private enum BridgeError: Error { case invalid, busy, ownership, stale, documentChanged, unsupported }
