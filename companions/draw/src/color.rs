//! Color values for the drawing companion.
//!
//! The public API takes **straight alpha**: `a = 0` is fully clear and the
//! `r`, `g`, `b` channels keep their plain meaning. The GPU adapter
//! premultiplies colors before upload, because the batch can draw many
//! overlapping shapes in one frame and the WASM build composites the
//! canvas over a host page. See `docs/drawing-companion.md` for the full
//! rationale.

/// A straight-alpha RGBA color with channels in `[0.0, 1.0]`.
///
/// Values outside `[0.0, 1.0]` are clamped when the color is read by a
/// batch method, so a caller cannot submit a non-finite or out-of-range
/// color into GPU state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Color {
    pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
        Color { r, g, b, a }
    }

    pub const BLACK: Color = Color::new(0.0, 0.0, 0.0, 1.0);
    pub const WHITE: Color = Color::new(1.0, 1.0, 1.0, 1.0);
    pub const TRANSPARENT: Color = Color::new(0.0, 0.0, 0.0, 0.0);

    /// Clamp each channel to `[0.0, 1.0]`. A non-finite channel becomes `0.0`.
    pub fn clamped(self) -> Color {
        let fix = |v: f32| {
            if v.is_finite() {
                v.clamp(0.0, 1.0)
            } else {
                0.0
            }
        };
        Color {
            r: fix(self.r),
            g: fix(self.g),
            b: fix(self.b),
            a: fix(self.a),
        }
    }

    /// Convert to premultiplied-alpha channels, in `[r*a, g*a, b*a, a]` order.
    /// The input is clamped first, so the result is always finite and in
    /// `[0.0, 1.0]`.
    pub fn to_premultiplied(self) -> [f32; 4] {
        let c = self.clamped();
        [c.r * c.a, c.g * c.a, c.b * c.a, c.a]
    }
}

impl Default for Color {
    fn default() -> Self {
        Color::WHITE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_out_of_range_channels() {
        let c = Color::new(2.0, -1.0, 0.5, 1.5).clamped();
        assert_eq!(c, Color::new(1.0, 0.0, 0.5, 1.0));
    }

    #[test]
    fn replaces_non_finite_channels_with_zero() {
        let c = Color::new(f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.5).clamped();
        assert_eq!(c, Color::new(0.0, 0.0, 0.0, 0.5));
    }

    #[test]
    fn premultiplies_color_by_alpha() {
        let c = Color::new(1.0, 0.5, 0.25, 0.5);
        assert_eq!(c.to_premultiplied(), [0.5, 0.25, 0.125, 0.5]);
    }

    #[test]
    fn premultiplied_output_is_always_finite() {
        let c = Color::new(f32::NAN, f32::INFINITY, 3.0, f32::NAN);
        let p = c.to_premultiplied();
        assert!(p.iter().all(|v| v.is_finite()));
    }
}
