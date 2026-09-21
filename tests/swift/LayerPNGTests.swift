import Foundation
import ImageIO
import CoreGraphics

@main struct LayerPNGTests {
    static func main() throws {
        let argb: [[Float]] = [[0,1,1,1], [1,1,-1,-1], [0.5,-1,1,-1], [1,-1,-1,1]]
        let bytes = try LayerPNG.rgba(width: 2, height: 2) { y,x,c in argb[y*2+x][c] }
        precondition(Array(bytes) == [255,255,255,0, 255,0,0,255, 0,255,0,128, 0,0,255,255])
        let png = try LayerPNG.encode(width: 2,height: 2) { y,x,c in argb[y*2+x][c] }
        let source = CGImageSourceCreateWithData(png as CFData,nil)!
        let image = CGImageSourceCreateImageAtIndex(source,0,nil)!
        precondition(image.width == 2 && image.height == 2)
        precondition(image.alphaInfo == .last || image.alphaInfo == .premultipliedLast)
        let properties = CGImageSourceCopyPropertiesAtIndex(source,0,nil)! as NSDictionary
        precondition(properties[kCGImagePropertyHasAlpha] as? Bool == true)
        // Read the encoded pixels into a known premultiplied sRGB format; verify half-transparent green.
        var rgba = [UInt8](repeating: 0,count: 16)
        rgba.withUnsafeMutableBytes { buffer in
            let ctx = CGContext(data: buffer.baseAddress,width:2,height:2,bitsPerComponent:8,bytesPerRow:8,
                space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.draw(image,in:CGRect(x:0,y:0,width:2,height:2))
        }
        precondition(rgba[11] == 128 && abs(Int(rgba[9])-128) <= 1)
        do { _ = try LayerPNG.rgba(width:1,height:1) { _,_,_ in .nan }; fatalError("NaN accepted") } catch LayerPNG.Failure.sample {}
        print("LayerPNG: straight RGBA / transparent / half alpha / sRGB / dimensions passed")
    }
}
