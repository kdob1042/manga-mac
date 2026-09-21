import Foundation
import CryptoKit
import Darwin
import MediaGenerationKit

struct Reference: Decodable { let id: String; let name: String; let hash: String; let image: String }
struct Output: Decodable { let directory: String; let request_hash: String }
struct MediaSelection: Decodable { let adapter_id: String; let model_id: String }
struct Request: Decodable { let output: Output; let prompt: String; let references: [Reference]; let original: String?; let seed: UInt32; let width: Int?; let height: Int?; let steps: Int?; let media: MediaSelection? }

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
      let model = selection.model_id
      // Missing weights fail locally; only --prepare may download.
      try await MediaGenerationEnvironment.default.ensure(model, offline: true)
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
      let results = try await pipeline.generate(prompt: request.prompt, negativePrompt: "text, lettering, watermark", inputs: inputs)
      guard results.count == 1, let first = results.first else { throw NSError(domain: "No generated image", code: 2) }
      let output = temp.appendingPathComponent("result.png")
      try first.write(to: output, type: .png)
      // Publish durable bytes and a hash receipt before signaling completion.
      // The native process supplies this reserved directory, never a UI path.
      let bytes = try Data(contentsOf: output)
      let destination = URL(fileURLWithPath: request.output.directory, isDirectory: true)
      let image = destination.appendingPathComponent("result.png")
      try bytes.write(to: image, options: .withoutOverwriting)
      let imageHandle = try FileHandle(forWritingTo: image)
      try imageHandle.synchronize(); try imageHandle.close()
      let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
      let receipt = destination.appendingPathComponent("receipt.json")
      let record = try JSONSerialization.data(withJSONObject: ["request_hash": request.output.request_hash, "hash": hash])
      try record.write(to: receipt, options: .atomic)
      let receiptHandle = try FileHandle(forWritingTo: receipt)
      try receiptHandle.synchronize(); try receiptHandle.close()
      let directoryFD = open(destination.path, O_RDONLY)
      guard directoryFD >= 0 else { throw NSError(domain: "Output directory", code: 4) }
      defer { close(directoryFD) }
      guard fsync(directoryFD) == 0 else { throw NSError(domain: "Output sync", code: 5) }
      print("MANGA_RESULT_SAVED")
    } catch {
      FileHandle.standardError.write(Data("Manga engine: \(error)\n".utf8))
      exit(1)
    }
  }
}
