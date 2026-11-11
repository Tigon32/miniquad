//! A bounded 2D affine transform.
//!
//! The transform maps points before the GPU adapter converts them into
//! clip space, so it stays in the same logical-pixel, top-left-origin,
//! Y-down space as the rest of the public geometry API (see
//! `docs/drawing-companion.md`).

/// A 2D affine transform, stored as the matrix
/// `[[a, c, tx], [b, d, ty]]` applied to a column vector `[x, y, 1]`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform2D {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub tx: f32,
    pub ty: f32,
}

impl Transform2D {
    pub const IDENTITY: Transform2D = Transform2D {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        tx: 0.0,
        ty: 0.0,
    };

    pub const fn translation(tx: f32, ty: f32) -> Transform2D {
        Transform2D {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            tx,
            ty,
        }
    }

    pub const fn scaling(sx: f32, sy: f32) -> Transform2D {
        Transform2D {
            a: sx,
            b: 0.0,
            c: 0.0,
            d: sy,
            tx: 0.0,
            ty: 0.0,
        }
    }

    /// A rotation of `radians`, counter-clockwise in a Y-down space
    /// (so the rotation appears clockwise on screen).
    pub fn rotation(radians: f32) -> Transform2D {
        let (s, c) = radians.sin_cos();
        Transform2D {
            a: c,
            b: s,
            c: -s,
            d: c,
            tx: 0.0,
            ty: 0.0,
        }
    }

    /// Compose `self` then `other`: a point is first transformed by
    /// `self`, and the result is transformed by `other`.
    pub fn then(self, other: Transform2D) -> Transform2D {
        Transform2D {
            a: self.a * other.a + self.b * other.c,
            b: self.a * other.b + self.b * other.d,
            c: self.c * other.a + self.d * other.c,
            d: self.c * other.b + self.d * other.d,
            tx: self.tx * other.a + self.ty * other.c + other.tx,
            ty: self.tx * other.b + self.ty * other.d + other.ty,
        }
    }

    /// Apply the transform to a point. Returns `None` if the result is
    /// not finite, so callers never push a non-finite vertex into a batch.
    pub fn apply(self, x: f32, y: f32) -> Option<(f32, f32)> {
        let px = self.a * x + self.c * y + self.tx;
        let py = self.b * x + self.d * y + self.ty;
        if px.is_finite() && py.is_finite() {
            Some((px, py))
        } else {
            None
        }
    }

    /// `true` when every field is finite. A batch rejects a non-finite
    /// transform before using it, instead of producing partial geometry.
    pub fn is_finite(&self) -> bool {
        [self.a, self.b, self.c, self.d, self.tx, self.ty]
            .iter()
            .all(|v| v.is_finite())
    }
}

impl Default for Transform2D {
    fn default() -> Self {
        Transform2D::IDENTITY
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_keeps_point_unchanged() {
        assert_eq!(Transform2D::IDENTITY.apply(3.0, -4.0), Some((3.0, -4.0)));
    }

    #[test]
    fn translation_offsets_point() {
        let t = Transform2D::translation(10.0, -5.0);
        assert_eq!(t.apply(1.0, 1.0), Some((11.0, -4.0)));
    }

    #[test]
    fn scaling_scales_point() {
        let t = Transform2D::scaling(2.0, 3.0);
        assert_eq!(t.apply(2.0, 2.0), Some((4.0, 6.0)));
    }

    #[test]
    fn composition_applies_self_before_other() {
        let scale = Transform2D::scaling(2.0, 2.0);
        let translate = Transform2D::translation(10.0, 0.0);
        let combined = scale.then(translate);
        // (1, 1) scaled to (2, 2), then translated to (12, 2).
        assert_eq!(combined.apply(1.0, 1.0), Some((12.0, 2.0)));
    }

    #[test]
    fn non_finite_input_point_is_rejected() {
        assert_eq!(Transform2D::IDENTITY.apply(f32::NAN, 0.0), None);
        assert_eq!(Transform2D::IDENTITY.apply(0.0, f32::INFINITY), None);
    }

    #[test]
    fn non_finite_transform_field_is_detected() {
        let mut t = Transform2D::IDENTITY;
        t.tx = f32::NAN;
        assert!(!t.is_finite());
    }

    #[test]
    fn finite_identity_transform_is_detected() {
        assert!(Transform2D::IDENTITY.is_finite());
    }
}
