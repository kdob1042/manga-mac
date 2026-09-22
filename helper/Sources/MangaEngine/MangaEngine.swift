import Foundation
import CryptoKit
import Darwin
import MediaGenerationKit

struct Reference: Decodable { let id: String; let name: String; let hash: String; let image: String }
struct Output: Decodable { let directory: String; let request_hash: String }
struct MediaSelection: Decodable { let adapter_id: String; let model_id: String }
struct Request: Decodable { let output: Output; let prompt: String; let references: [Reference]; let original: String?; let seed: UInt32; let width: Int?; let height: Int?; let steps: Int?; let media: MediaSelection?; let output_kind: String?; let layer_count: Int? }

enum MangaEngineError: LocalizedError {
  case modelReferenceUnavailable(String)
  case modelNotPrepared(String)

  var errorDescription: String? {
    switch self {
    case .modelReferenceUnavailable(let model):
      return "画像モデルの登録情報を解決できません: \(model)"
    case .modelNotPrepared(let model):
      return "画像モデルが未準備です: \(model)。設定または確認画面で「画像モデルを準備する」を先に実行してください。生成時の自動ダウンロードは行いません。"
    }
  }
}

@main struct MangaEngine {
  static func main() async {
    do {
      if let index = CommandLine.arguments.firstIndex(of: "--prepare") {
        guard index + 1 < CommandLine.arguments.count else { throw NSError(domain: "Missing model", code: 10) }
        // Native resolves this identifier from the shared registry. No second model list here.
        try await MediaGenerationEnvironment.default.ensure(CommandLine.arguments[index + 1])
        print("ready")
        return
      }
      let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
      guard let selection = request.media, selection.adapter_id == "media-generation-kit",
        selection.model_id.hasSuffix(".ckpt"), !selection.model_id.contains("/"),
        let width = request.width, let height = request.height, let steps = request.steps,
        width > 0, height > 0, steps > 0
      else { throw NSError(domain: "Invalid native image descriptor", code: 11) }
      let layered = request.output_kind == "ordered-rgba-layers"
      guard request.output_kind == nil || request.output_kind == "image" || layered else { throw NSError(domain: "Unknown output kind", code: 12) }
      if layered {
        guard #available(macOS 15, *), request.original != nil, request.references.isEmpty,
              let count = request.layer_count, (2...6).contains(count) else { throw NSError(domain: "Invalid layered inputs", code: 13) }
      }
      let model = selection.model_id
      // Generation runs in a network-denied sandbox. Resolve the local catalog
      // entry first and refuse missing weights; only --prepare may download.
      guard let resolved = await MediaGenerationEnvironment.default.resolveModel(model, offline: true) else {
        throw MangaEngineError.modelReferenceUnavailable(model)
      }
      guard resolved.isDownloaded else {
        throw MangaEngineError.modelNotPrepared(resolved.file)
      }
      let temp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: temp) }
      func writeImage(_ uri: String, _ name: String) throws -> String {
        guard let comma = uri.firstIndex(of: ","), let data = Data(base64Encoded: String(uri[uri.index(after: comma)...])) else { throw NSError(domain: "Invalid image", code: 1) }
        let path = temp.appendingPathComponent(name)
        try data.write(to: path)
        return path.path
      }
      var inputs: [MediaGenerationPipeline.Input] = []
      if let original = request.original { inputs.append(MediaGenerationPipeline.file(try writeImage(original, "original.png"))) }
      for (i, reference) in request.references.enumerated() {
        inputs.append(MediaGenerationPipeline.file(try writeImage(reference.image, "ref-\(i).png")).moodboard())
      }
      // Model downloads are exclusively triggered by --prepare, never a cloud backend.
      var pipeline = try await MediaGenerationPipeline.fromPretrained(model, backend: .local)
      pipeline.configuration.width = width
      pipeline.configuration.height = height
      pipeline.configuration.steps = steps
      pipeline.configuration.seed = request.seed
      if layered { pipeline.configuration.batchSize = request.layer_count! }
      let results = try await pipeline.generate(prompt: request.prompt, negativePrompt: "text, lettering, watermark", inputs: inputs)
      let destination = URL(fileURLWithPath: request.output.directory, isDirectory: true)
      func publish(_ bytes: Data, name: String) throws -> String {
        let image = destination.appendingPathComponent(name)
        try bytes.write(to: image, options: .withoutOverwriting)
        let handle = try FileHandle(forWritingTo: image)
        try handle.synchronize(); try handle.close()
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
      }
      var record: [String: Any] = ["request_hash": request.output.request_hash]
      if layered {
        guard results.count == request.layer_count else { throw NSError(domain: "Layer count mismatch", code: 14) }
        var layers: [[String: Any]] = []
        for (index, result) in results.enumerated() {
          let shape = result.tensor.shape
          guard shape.count == 4, shape[0] == 1, shape[1] == height, shape[2] == width, shape[3] == 4 else {
            throw NSError(domain: "Expected ordered NHWC RGBA layers, not RGB batch or video", code: 15)
          }
          let bytes = try LayerPNG.encode(width: width, height: height) { y, x, c in Float(result.tensor[0, y, x, c]) }
          let filename = "layer-\(index).png"
          layers.append(["index": index, "filename": filename, "hash": try publish(bytes, name: filename)])
        }
        record["kind"] = "ordered-rgba-layers"
        record["layers"] = layers
      } else {
        guard results.count == 1, let first = results.first else { throw NSError(domain: "Expected one RGB image", code: 2) }
        let output = temp.appendingPathComponent("result.png")
        try first.write(to: output, type: .png)
        record["hash"] = try publish(Data(contentsOf: output), name: "result.png")
      }
      let receipt = destination.appendingPathComponent("receipt.json")
      let receiptData = try JSONSerialization.data(withJSONObject: record)
      try receiptData.write(to: receipt, options: .atomic)
      let receiptHandle = try FileHandle(forWritingTo: receipt)
      try receiptHandle.synchronize(); try receiptHandle.close()
      let directoryFD = open(destination.path, O_RDONLY)
      guard directoryFD >= 0 else { throw NSError(domain: "Output directory", code: 4) }
      defer { close(directoryFD) }
      guard fsync(directoryFD) == 0 else { throw NSError(domain: "Output sync", code: 5) }
      print("MANGA_RESULT_SAVED")
    } catch {
      let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
      FileHandle.standardError.write(Data("Manga engine: \(message)\n".utf8))
      exit(1)
    }
  }
}
