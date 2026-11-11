//! Color values for the drawing companion.
//!
//! The public API takes **straight alpha**: `a = 0` is fully clear and the
//! `r`, `g`, `b` channels keep their plain meaning. The GPU adapter
//! premultiplies colors before upload, because the batch can draw many
//! overlapping shapes in one frame and the WASM build composites the
//! canvas over a host page. See `docs/drawing-companion.md` for the full
//! rationale.
//!
//! # Range policy
//!
//! A channel must be finite (not `NaN` or infinite): [`Color::validate`]
//! rejects a non-finite channel with an error instead of silently turning
//! it into `0.0`, matching the rest of this crate's deterministic
//! validation. A **finite** out-of-range channel (for example `1.5` or
//! `-0.2`) is clamped to `[0.0, 1.0]`: this is the one explicit,
//! documented normalization this type performs, so a caller computing a
//! color (for example by adding highlights) does not have to clamp by
//! hand. Every `batch::Batch` shape method validates its color this way
//! before building geometry.

use crate::geometry::GeometryError;

/// A straight-alpha RGBA color with channels in `[0.0, 1.0]`.
///
/// See the module docs for the exact range policy: [`Color::validate`]
/// is how a caller (or this crate's shape builders) turns a `Color` into
/// one known to be finite and in range.
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

    /// Validate this color: a non-finite (`NaN` or infinite) channel is
    /// an error, never silently replaced. A finite out-of-range channel
    /// is clamped to `[0.0, 1.0]` (the module's documented range
    /// policy), so the returned `Color` always has every channel in
    /// `[0.0, 1.0]`.
    pub fn validate(self) -> Result<Color, GeometryError> {
        if ![self.r, self.g, self.b, self.a]
            .iter()
            .all(|c| c.is_finite())
        {
            return Err(GeometryError::NonFiniteInput);
        }
        Ok(Color {
            r: self.r.clamp(0.0, 1.0),
            g: self.g.clamp(0.0, 1.0),
            b: self.b.clamp(0.0, 1.0),
            a: self.a.clamp(0.0, 1.0),
        })
    }

    /// Convert to premultiplied-alpha channels, in `[r*a, g*a, b*a, a]`
    /// order. This is a pure numeric transform: call [`Color::validate`]
    /// first (every `batch::Batch` shape method does), or use an
    /// already-valid color such as [`Color::WHITE`]. A non-finite or
    /// out-of-range input channel produces a correspondingly non-finite
    /// or out-of-range result, rather than being fixed up here.
    pub fn to_premultiplied(self) -> [f32; 4] {
        [self.r * self.a, self.g * self.a, self.b * self.a, self.a]
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
    fn validate_clamps_finite_out_of_range_channels() {
        let c = Color::new(2.0, -1.0, 0.5, 1.5).validate().unwrap();
        assert_eq!(c, Color::new(1.0, 0.0, 0.5, 1.0));
    }

    #[test]
    fn validate_rejects_non_finite_channels_instead_of_zeroing_them() {
        let err = Color::new(f32::NAN, 0.0, 0.0, 0.5).validate().unwrap_err();
        assert_eq!(err, GeometryError::NonFiniteInput);
        let err = Color::new(0.0, f32::INFINITY, 0.0, 0.5)
            .validate()
            .unwrap_err();
        assert_eq!(err, GeometryError::NonFiniteInput);
        let err = Color::new(0.0, 0.0, f32::NEG_INFINITY, 0.5)
            .validate()
            .unwrap_err();
        assert_eq!(err, GeometryError::NonFiniteInput);
    }

    #[test]
    fn premultiplies_color_by_alpha() {
        let c = Color::new(1.0, 0.5, 0.25, 0.5);
        assert_eq!(c.to_premultiplied(), [0.5, 0.25, 0.125, 0.5]);
    }
}
