//! Lossless colour-only compositing: no Canvas premultiplication of untouched pixels.
use super::{err, Result};
use std::io::Cursor;

fn decode(bytes: &[u8]) -> Result<(u32, u32, png::ColorType, Vec<u8>)> {
    let mut reader = png::Decoder::new(Cursor::new(bytes))
        .read_info()
        .map_err(err)?;
    let info = reader.info();
    if info.width == 0
        || info.height == 0
        || info.width > 4096
        || info.height > 4096
        || info.bit_depth != png::BitDepth::Eight
        || info.animation_control.is_some()
        || !matches!(info.color_type, png::ColorType::Rgb | png::ColorType::Rgba)
    {
        return Err("Expected bounded 8-bit RGB/RGBA PNG".into());
    }
    let mut pixels = vec![0; reader.output_buffer_size().ok_or("PNG output size")?];
    let output = reader.next_frame(&mut pixels).map_err(err)?;
    pixels.truncate(output.buffer_size());
    Ok((output.width, output.height, output.color_type, pixels))
}
fn encode(width: u32, height: u32, pixels: &[u8]) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        let mut writer = encoder.write_header().map_err(err)?;
        writer.write_image_data(pixels).map_err(err)?;
    }
    Ok(bytes)
}
pub fn compose(original: &[u8], generated: &[u8], rect: [f64; 4]) -> Result<Vec<u8>> {
    let (width, height, colour, mut target) = decode(original)?;
    let (w, h, _, changed) = decode(generated)?;
    if colour != png::ColorType::Rgba
        || width != w
        || height != h
        || rect.iter().any(|v| !v.is_finite() || *v < 0.0 || *v > 1.0)
        || rect[2] <= 0.0
        || rect[3] <= 0.0
        || rect[0] + rect[2] > 1.0
        || rect[1] + rect[3] > 1.0
    {
        return Err("Invalid colour-only dimensions, alpha or region".into());
    }
    let channels = changed.len() / (width as usize * height as usize);
    for y in (rect[1] * height as f64).floor() as usize
        ..((rect[1] + rect[3]) * height as f64).ceil() as usize
    {
        for x in (rect[0] * width as f64).floor() as usize
            ..((rect[0] + rect[2]) * width as f64).ceil() as usize
        {
            let pixel = y * width as usize + x;
            if target[pixel * 4 + 3] != 0 {
                target[pixel * 4..pixel * 4 + 3]
                    .copy_from_slice(&changed[pixel * channels..pixel * channels + 3]);
            }
        }
    }
    encode(width, height, &target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn png_roundtrip_keeps_low_alpha_hidden_rgb_and_outside_pixels_exact() {
        let original = [20, 40, 60, 1, 90, 80, 70, 0, 10, 30, 50, 128, 1, 2, 3, 255];
        let generated = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 8, 7, 255];
        let result = compose(
            &encode(2, 2, &original).unwrap(),
            &encode(2, 2, &generated).unwrap(),
            [0.0, 0.0, 1.0, 0.5],
        )
        .unwrap();
        assert_eq!(
            decode(&result).unwrap().3,
            [255, 0, 0, 1, 90, 80, 70, 0, 10, 30, 50, 128, 1, 2, 3, 255]
        );
    }
}
