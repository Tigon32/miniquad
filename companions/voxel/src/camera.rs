//! A small orbit-style perspective camera driven by arrow keys and
//! mouse drag. Pure state and math; no GPU or windowing calls.

use crate::math::{Mat4, Vec3};

/// Smallest permitted pitch, in radians, to avoid the camera flipping
/// past straight up.
const MIN_PITCH: f32 = -1.5;
/// Largest permitted pitch, in radians.
const MAX_PITCH: f32 = 1.5;

/// A camera that orbits a fixed target point at a fixed distance,
/// controlled by yaw and pitch.
#[derive(Clone, Copy, Debug)]
pub struct OrbitCamera {
    pub target: Vec3,
    pub distance: f32,
    pub yaw: f32,
    pub pitch: f32,
}

impl OrbitCamera {
    pub fn new(target: Vec3, distance: f32, yaw: f32, pitch: f32) -> OrbitCamera {
        OrbitCamera {
            target,
            distance: distance.max(0.1),
            yaw,
            pitch: pitch.clamp(MIN_PITCH, MAX_PITCH),
        }
    }

    /// Rotates the camera by a yaw/pitch delta, in radians. Used by
    /// both arrow-key stepping and mouse-drag deltas, so both input
    /// paths share one clamped rotation rule.
    pub fn rotate(&mut self, d_yaw: f32, d_pitch: f32) {
        self.yaw += d_yaw;
        self.pitch = (self.pitch + d_pitch).clamp(MIN_PITCH, MAX_PITCH);
    }

    /// Moves the orbit distance, clamped to stay above a small
    /// positive minimum so the view matrix never degenerates.
    pub fn zoom(&mut self, delta: f32) {
        self.distance = (self.distance + delta).max(0.1);
    }

    fn eye(&self) -> Vec3 {
        let cp = self.pitch.cos();
        let offset = Vec3::new(
            self.distance * cp * self.yaw.sin(),
            self.distance * self.pitch.sin(),
            self.distance * cp * self.yaw.cos(),
        );
        self.target.add(offset)
    }

    pub fn view_matrix(&self) -> Mat4 {
        Mat4::look_at_rh(self.eye(), self.target, Vec3::new(0.0, 1.0, 0.0))
    }

    pub fn projection_matrix(&self, aspect: f32) -> Mat4 {
        Mat4::perspective_rh_gl(45f32.to_radians(), aspect, 0.1, 500.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotate_clamps_pitch() {
        let mut camera = OrbitCamera::new(Vec3::ZERO, 10.0, 0.0, 0.0);
        camera.rotate(0.0, 100.0);
        assert!(camera.pitch <= MAX_PITCH);
        camera.rotate(0.0, -200.0);
        assert!(camera.pitch >= MIN_PITCH);
    }

    #[test]
    fn zoom_never_goes_non_positive() {
        let mut camera = OrbitCamera::new(Vec3::ZERO, 1.0, 0.0, 0.0);
        camera.zoom(-100.0);
        assert!(camera.distance > 0.0);
    }

    #[test]
    fn new_clamps_distance_and_pitch() {
        let camera = OrbitCamera::new(Vec3::ZERO, -5.0, 0.0, 10.0);
        assert!(camera.distance > 0.0);
        assert!(camera.pitch <= MAX_PITCH);
    }
}
