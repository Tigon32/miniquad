use miniquad_voxel::chunk::ChunkDims;
use miniquad_voxel::math::Vec3;

const SPRITE_RADIUS: f32 = 6.146_543_7;
const SPRITE_PHASE_OFFSET: f32 = 2.758_065_1;
const SPRITE_HEIGHT_MARGIN: f32 = 1.5;

pub(super) fn sprite_position(
    t: f32,
    dims: ChunkDims,
    mut column_height: impl FnMut(i32, i32) -> i32,
) -> Vec3 {
    let angle = t + SPRITE_PHASE_OFFSET;
    let x = dims.x as f32 + angle.cos() * SPRITE_RADIUS;
    let z = dims.z as f32 * 0.5 + angle.sin() * SPRITE_RADIUS;
    Vec3::new(
        x,
        column_height(x.round() as i32, z.round() as i32) as f32
            + SPRITE_HEIGHT_MARGIN
            + (t * 1.7).sin() * 0.6,
        z,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sprite_position_uses_the_same_terrain_relative_column() {
        let position = sprite_position(0.0, ChunkDims::new(8, 12, 8), |x, z| {
            assert_eq!((x, z), (2, 6));
            5
        });

        assert!((position.y - 6.5).abs() < f32::EPSILON);
    }
}
