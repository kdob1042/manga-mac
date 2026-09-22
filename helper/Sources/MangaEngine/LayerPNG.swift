import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// Qwen transparent decoder at pinned SDK d473a2f: A[0,1], RGB[-1,1], NHWC.
// Do not call the SDK's RGB-only PNG writer or apply alpha a second time.
enum LayerPNG {
    enum Failure: Error { case dimensions, sample, encode }
    static func rgba(width: Int, height: Int, sample: (Int, Int, Int) -> Float) throws -> Data {
        guard width > 0, height > 0, width <= 4096, height <= 4096 else { throw Failure.dimensions }
        var bytes = Data(count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let a = sample(y, x, 0)
                let rgb = (1...3).map { sample(y, x, $0) }
                guard a.isFinite, rgb.allSatisfy({ $0.isFinite }) else { throw Failure.sample }
                let offset = (y * width + x) * 4
                for c in 0..<3 { bytes[offset + c] = UInt8(min(255, max(0, ((rgb[c] + 1) * 127.5).rounded()))) }
                bytes[offset + 3] = UInt8(min(255, max(0, (a * 255).rounded())))
            }
        }
        return bytes
    }
    static func encode(width: Int, height: Int, sample: (Int, Int, Int) -> Float) throws -> Data {
        let bytes = try rgba(width: width, height: height, sample: sample)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let provider = CGDataProvider(data: bytes as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                bytesPerRow: width * 4, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { throw Failure.encode }
        let data = NSMutableData()
        guard let output = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw Failure.encode }
        CGImageDestinationAddImage(output, image, nil)
        guard CGImageDestinationFinalize(output) else { throw Failure.encode }
        return data as Data
    }
}
