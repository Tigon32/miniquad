//! Tiny pure-Rust vector and matrix math for the offline voxel demo.
//!
//! This module exists so the `miniquad-voxel` companion adds no external
//! math dependency. It implements only what the demo camera and shaders
//! need: a 3-component vector and a column-major 4x4 matrix with
//! perspective, look-at, and multiply. It is not a general math library.

/// A 3-component float vector.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };

    pub const fn new(x: f32, y: f32, z: f32) -> Vec3 {
        Vec3 { x, y, z }
    }

    pub fn add(self, other: Vec3) -> Vec3 {
        Vec3::new(self.x + other.x, self.y + other.y, self.z + other.z)
    }

    pub fn sub(self, other: Vec3) -> Vec3 {
        Vec3::new(self.x - other.x, self.y - other.y, self.z - other.z)
    }

    pub fn scale(self, s: f32) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }

    pub fn dot(self, other: Vec3) -> f32 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }

    pub fn cross(self, other: Vec3) -> Vec3 {
        Vec3::new(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )
    }

    pub fn length(self) -> f32 {
        self.dot(self).sqrt()
    }

    /// Returns a unit-length vector. Returns [`Vec3::ZERO`] for a
    /// zero-length input instead of dividing by zero.
    pub fn normalize(self) -> Vec3 {
        let len = self.length();
        if len <= f32::EPSILON {
            Vec3::ZERO
        } else {
            self.scale(1.0 / len)
        }
    }
}

/// A column-major 4x4 matrix, stored as 16 `f32` values. This layout
/// matches the `mat4` uniform layout miniquad's GLSL shaders expect.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mat4(pub [f32; 16]);

impl Mat4 {
    pub const IDENTITY: Mat4 = Mat4([
        1.0, 0.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ]);

    /// Builds a right-handed perspective projection matrix with an
    /// OpenGL-style `[-1, 1]` depth range, matching miniquad's GLSL
    /// backends. `fov_y_radians` must be in `(0, PI)`, `aspect` and
    /// `near` must be finite and positive, and `far` must be greater
    /// than `near`. Returns [`Mat4::IDENTITY`] for invalid input so a
    /// caller never receives a matrix with NaN or infinite entries.
    pub fn perspective_rh_gl(fov_y_radians: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
        if !(fov_y_radians.is_finite() && aspect.is_finite() && near.is_finite() && far.is_finite())
            || fov_y_radians <= 0.0
            || fov_y_radians >= std::f32::consts::PI
            || aspect <= 0.0
            || near <= 0.0
            || far <= near
        {
            return Mat4::IDENTITY;
        }
        let f = 1.0 / (fov_y_radians * 0.5).tan();
        let range_inv = 1.0 / (near - far);
        Mat4([
            f / aspect,
            0.0,
            0.0,
            0.0, //
            0.0,
            f,
            0.0,
            0.0, //
            0.0,
            0.0,
            (near + far) * range_inv,
            -1.0, //
            0.0,
            0.0,
            near * far * range_inv * 2.0,
            0.0,
        ])
    }

    /// Builds a right-handed view matrix for an eye at `eye` looking
    /// toward `target`, with `up` as the approximate up direction.
    /// Falls back to [`Mat4::IDENTITY`] if `eye` and `target` coincide
    /// or if `up` is parallel to the view direction (both degenerate
    /// cases that would otherwise divide by a near-zero length).
    pub fn look_at_rh(eye: Vec3, target: Vec3, up: Vec3) -> Mat4 {
        let f = target.sub(eye).normalize();
        if f == Vec3::ZERO {
            return Mat4::IDENTITY;
        }
        let s = f.cross(up).normalize();
        if s == Vec3::ZERO {
            return Mat4::IDENTITY;
        }
        let u = s.cross(f);
        Mat4([
            s.x,
            u.x,
            -f.x,
            0.0, //
            s.y,
            u.y,
            -f.y,
            0.0, //
            s.z,
            u.z,
            -f.z,
            0.0, //
            -s.dot(eye),
            -u.dot(eye),
            f.dot(eye),
            1.0,
        ])
    }

    /// Returns `self * other` using column-major, column-vector
    /// convention (`self` is applied second).
    pub fn mul(&self, other: &Mat4) -> Mat4 {
        let a = &self.0;
        let b = &other.0;
        let mut out = [0.0f32; 16];
        for col in 0..4 {
            for row in 0..4 {
                let mut sum = 0.0;
                for k in 0..4 {
                    sum += a[k * 4 + row] * b[col * 4 + k];
                }
                out[col * 4 + row] = sum;
            }
        }
        Mat4(out)
    }

    /// Transforms a point (implicit `w = 1`) and returns its clip-
    /// space `(x, y, z, w)`, column-major convention. Used by
    /// `examples/mixed.rs` to project the sprite centre into canvas
    /// pixels for `vx_sprite_pixel`.
    pub fn transform_point(&self, p: Vec3) -> (f32, f32, f32, f32) {
        let m = &self.0;
        let x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
        let y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
        let z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
        let w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
        (x, y, z, w)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_multiply_is_identity() {
        let m = Mat4::perspective_rh_gl(1.0, 1.0, 0.1, 100.0);
        let product = m.mul(&Mat4::IDENTITY);
        assert_eq!(product, m);
    }

    #[test]
    fn perspective_rejects_invalid_input() {
        assert_eq!(
            Mat4::perspective_rh_gl(0.0, 1.0, 0.1, 100.0),
            Mat4::IDENTITY
        );
        assert_eq!(Mat4::perspective_rh_gl(1.0, 1.0, 0.1, 0.05), Mat4::IDENTITY);
        assert_eq!(
            Mat4::perspective_rh_gl(f32::NAN, 1.0, 0.1, 100.0),
            Mat4::IDENTITY
        );
    }

    #[test]
    fn look_at_rejects_degenerate_input() {
        let eye = Vec3::new(0.0, 0.0, 0.0);
        assert_eq!(
            Mat4::look_at_rh(eye, eye, Vec3::new(0.0, 1.0, 0.0)),
            Mat4::IDENTITY
        );
    }

    #[test]
    fn normalize_zero_vector_is_zero() {
        assert_eq!(Vec3::ZERO.normalize(), Vec3::ZERO);
    }
}
