//! Converts a mapped readback buffer (with `bytesPerRow` padding and the
//! canvas pixel format) into the RGBA samples the contract defines
//! (section 6: "Rust removes the padding and converts the pixel order.").

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasFormat {
    Bgra8Unorm,
    Rgba8Unorm,
}

impl CanvasFormat {
    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            0 => Some(CanvasFormat::Bgra8Unorm),
            1 => Some(CanvasFormat::Rgba8Unorm),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            CanvasFormat::Bgra8Unorm => "bgra8unorm",
            CanvasFormat::Rgba8Unorm => "rgba8unorm",
        }
    }
}

/// Reads one RGBA pixel at `(x, y)` from a row-padded mapped buffer.
/// Returns `None` if the coordinates or the buffer are out of bounds.
pub fn read_pixel(
    bytes: &[u8],
    bytes_per_row: u32,
    width: u32,
    height: u32,
    format: CanvasFormat,
    x: u32,
    y: u32,
) -> Option<[u8; 4]> {
    if x >= width || y >= height {
        return None;
    }
    let row_start = (y as usize).checked_mul(bytes_per_row as usize)?;
    let pixel_start = row_start.checked_add((x as usize).checked_mul(4)?)?;
    let pixel_end = pixel_start.checked_add(4)?;
    if pixel_end > bytes.len() {
        return None;
    }
    let p = &bytes[pixel_start..pixel_end];
    Some(match format {
        CanvasFormat::Bgra8Unorm => [p[2], p[1], p[0], p[3]],
        CanvasFormat::Rgba8Unorm => [p[0], p[1], p[2], p[3]],
    })
}

/// The contract's `center` sample: `(floor(width / 2), floor(height / 2))`.
pub fn center_coord(width: u32, height: u32) -> (u32, u32) {
    (width / 2, height / 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn padded_buffer(width: u32, height: u32, bytes_per_row: u32, fill: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let mut bytes = vec![0u8; (bytes_per_row * height) as usize];
        for y in 0..height {
            for x in 0..width {
                let px = fill(x, y);
                let start = (y * bytes_per_row + x * 4) as usize;
                bytes[start..start + 4].copy_from_slice(&px);
            }
        }
        bytes
    }

    #[test]
    fn center_and_corner_at_256_square_match_the_contract() {
        let width = 256u32;
        let height = 256u32;
        let bytes_per_row = 256 * 4; // already a multiple of 256
        let bytes = padded_buffer(width, height, bytes_per_row, |x, y| {
            let (cx, cy) = center_coord(width, height);
            if x == cx && y == cy {
                [255, 0, 0, 255] // stored BGRA: B=255,G=0,R=0,A=255 -> red after conversion
            } else if x == 0 && y == 0 {
                [0, 0, 255, 255] // stored BGRA for blue
            } else {
                [255, 0, 0, 255] // blue clear colour stored as BGRA
            }
        });
        let (cx, cy) = center_coord(width, height);
        let center = read_pixel(&bytes, bytes_per_row, width, height, CanvasFormat::Bgra8Unorm, cx, cy).unwrap();
        assert_eq!(center, [0, 0, 255, 255], "BGRA [255,0,0,255] must convert to RGBA red");
        let corner = read_pixel(&bytes, bytes_per_row, width, height, CanvasFormat::Bgra8Unorm, 0, 0).unwrap();
        assert_eq!(corner, [255, 0, 0, 255], "BGRA [0,0,255,255] must convert to RGBA blue");
    }

    #[test]
    fn resize_320x200_uses_a_padded_bytes_per_row() {
        // 320 * 4 = 1280, already a multiple of 256; use an odd width to
        // force padding and confirm the reader skips the pad bytes.
        let width = 321u32;
        let height = 200u32;
        let unpadded = width * 4; // 1284, rounds up to 1536
        let bytes_per_row = ((unpadded + 255) / 256) * 256;
        assert_eq!(bytes_per_row, 1536);
        let bytes = padded_buffer(width, height, bytes_per_row, |x, y| {
            if x == width / 2 && y == height / 2 {
                [0, 0, 255, 255] // BGRA red
            } else if x == 0 && y == 0 {
                [255, 0, 0, 255] // BGRA blue
            } else {
                [0, 0, 0, 0]
            }
        });
        let (cx, cy) = center_coord(width, height);
        let center = read_pixel(&bytes, bytes_per_row, width, height, CanvasFormat::Bgra8Unorm, cx, cy).unwrap();
        assert_eq!(center, [255, 0, 0, 255]);
        let corner = read_pixel(&bytes, bytes_per_row, width, height, CanvasFormat::Bgra8Unorm, 0, 0).unwrap();
        assert_eq!(corner, [0, 0, 255, 255]);
    }

    #[test]
    fn rgba_format_is_not_byte_swapped() {
        let width = 2u32;
        let height = 2u32;
        let bytes_per_row = 256;
        let bytes = padded_buffer(width, height, bytes_per_row, |_, _| [9, 8, 7, 6]);
        let px = read_pixel(&bytes, bytes_per_row, width, height, CanvasFormat::Rgba8Unorm, 0, 0).unwrap();
        assert_eq!(px, [9, 8, 7, 6]);
    }

    #[test]
    fn out_of_bounds_coordinates_return_none() {
        let bytes = vec![0u8; 256];
        assert!(read_pixel(&bytes, 256, 2, 2, CanvasFormat::Rgba8Unorm, 5, 5).is_none());
    }

    #[test]
    fn a_truncated_buffer_returns_none_instead_of_panicking() {
        let bytes = vec![0u8; 4];
        assert!(read_pixel(&bytes, 256, 2, 2, CanvasFormat::Rgba8Unorm, 1, 1).is_none());
    }
}
