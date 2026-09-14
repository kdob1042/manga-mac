// swift-tools-version: 5.9
import PackageDescription
let package = Package(
  name: "MangaEngine", platforms: [.macOS(.v14)],
  products: [.executable(name: "manga-engine", targets: ["MangaEngine"])],
  dependencies: [.package(url: "https://github.com/drawthingsai/media-generation-kit.git", revision: "8868a9685d9c299816f43ef53efd455ffca437f0")],
  targets: [.executableTarget(name: "MangaEngine", dependencies: [.product(name: "MediaGenerationKit", package: "media-generation-kit")])]
)
