import Foundation
import MediaGenerationKit

struct Reference: Decodable { let id: String; let name: String; let hash: String; let image: String }
struct Request: Decodable { let prompt: String; let references: [Reference]; let original: String?; let seed: UInt32 }

@main struct MangaEngine {
  static func main() async {
    do {
      let model = "flux_2_klein_4b_q8p.ckpt"
      if CommandLine.arguments.contains("--prepare") {
        try await MediaGenerationEnvironment.default.ensure(model)
        print("ready")
        return
      }
      let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
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
      pipeline.configuration.width = 768
      pipeline.configuration.height = 768
      pipeline.configuration.steps = 4
      pipeline.configuration.seed = request.seed
      let results = try await pipeline.generate(prompt: request.prompt, negativePrompt: "text, lettering, watermark", inputs: inputs)
      guard let first = results.first else { throw NSError(domain: "No generated image", code: 2) }
      let output = temp.appendingPathComponent("result.png")
      try first.write(to: output, type: .png)
      // Prefix makes engine logs distinguishable from the result protocol.
      print("MANGA_RESULT:" + (try Data(contentsOf: output)).base64EncodedString())
    } catch {
      FileHandle.standardError.write(Data("Manga engine: \(error)\n".utf8))
      exit(1)
    }
  }
}
