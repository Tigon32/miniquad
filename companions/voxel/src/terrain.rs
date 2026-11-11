//! A small, deterministic seeded terrain generator and material
//! palette for the offline demo. This is not a general noise library;
//! it exists so the vertical slice has reproducible, testable content
//! without pulling in an external dependency.

use crate::chunk::{Chunk, ChunkDims, ChunkError, VoxelId};

/// Material IDs used by the demo palette (index 0 is [`crate::chunk::AIR`]).
pub const MATERIAL_GRASS: VoxelId = 1;
pub const MATERIAL_DIRT: VoxelId = 2;
pub const MATERIAL_STONE: VoxelId = 3;

/// Straight-alpha RGBA colors for [`MATERIAL_GRASS`], [`MATERIAL_DIRT`],
/// and [`MATERIAL_STONE`], indexed by material ID (index 0 is unused
/// air and kept fully transparent for clarity).
pub const PALETTE: [[f32; 4]; 4] = [
    [0.0, 0.0, 0.0, 0.0],
    [0.30, 0.65, 0.25, 1.0],
    [0.45, 0.33, 0.20, 1.0],
    [0.55, 0.55, 0.58, 1.0],
];

/// A small deterministic integer hash (xorshift-style). The same
/// `(seed, x, z)` always produces the same output, on every target.
fn hash2(seed: u32, x: i32, z: i32) -> u32 {
    let mut h = seed ^ (x as u32).wrapping_mul(0x9E37_79B9) ^ (z as u32).wrapping_mul(0x85EB_CA6B);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297A_2D39);
    h ^= h >> 15;
    h
}

/// Returns a deterministic column height in `[min_height, max_height]`
/// for world column `(x, z)` under `seed`. Returns `min_height` if
/// `max_height < min_height` (an explicit, bounded fallback instead of
/// an underflow panic).
pub fn column_height(seed: u32, x: i32, z: i32, min_height: u32, max_height: u32) -> u32 {
    if max_height < min_height {
        return min_height;
    }
    let span = max_height - min_height + 1;
    min_height + hash2(seed, x, z) % span
}

/// Builds one bounded chunk of deterministic terrain: solid below the
/// column height (stone, then dirt near the surface, then grass on
/// top), air above. `origin_x`/`origin_z` are the chunk's world-space
/// column offset, so adjacent chunks line up into one continuous
/// heightmap.
pub fn generate_chunk(
    seed: u32,
    dims: ChunkDims,
    origin_x: i32,
    origin_z: i32,
) -> Result<Chunk, ChunkError> {
    let mut chunk = Chunk::new(dims)?;
    let max_height = dims.y.saturating_sub(1);
    for z in 0..dims.z {
        for x in 0..dims.x {
            let height = column_height(
                seed,
                origin_x + x as i32,
                origin_z + z as i32,
                1,
                max_height,
            );
            for y in 0..=height.min(dims.y.saturating_sub(1)) {
                let material = if y == height {
                    MATERIAL_GRASS
                } else if y + 2 >= height {
                    MATERIAL_DIRT
                } else {
                    MATERIAL_STONE
                };
                chunk.set(x, y, z, material)?;
            }
        }
    }
    Ok(chunk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_height_is_deterministic_for_same_seed() {
        let a = column_height(42, 3, -7, 1, 15);
        let b = column_height(42, 3, -7, 1, 15);
        assert_eq!(a, b);
        assert!((1..=15).contains(&a));
    }

    #[test]
    fn column_height_differs_across_seeds_for_at_least_one_sample() {
        // Not a statistical claim, only a smoke check that the seed
        // actually participates in the hash.
        let differs =
            (0..8).any(|x| column_height(1, x, 0, 1, 1000) != column_height(2, x, 0, 1, 1000));
        assert!(differs);
    }

    #[test]
    fn column_height_handles_inverted_bounds() {
        assert_eq!(column_height(1, 0, 0, 10, 5), 10);
    }

    #[test]
    fn generate_chunk_is_deterministic() {
        let dims = ChunkDims::new(4, 8, 4);
        let a = generate_chunk(7, dims, 0, 0).unwrap();
        let b = generate_chunk(7, dims, 0, 0).unwrap();
        for z in 0..dims.z {
            for y in 0..dims.y {
                for x in 0..dims.x {
                    assert_eq!(a.get(x, y, z), b.get(x, y, z));
                }
            }
        }
    }

    #[test]
    fn generate_chunk_rejects_oversized_dims() {
        let dims = ChunkDims::new(crate::chunk::MAX_CHUNK_DIM + 1, 1, 1);
        assert!(generate_chunk(1, dims, 0, 0).is_err());
    }
}
