//! A small, deterministic seeded terrain generator and material
//! palette for the offline demo. This is not a general noise library;
//! it exists so the vertical slice has reproducible, testable content
//! without pulling in an external dependency.

use crate::chunk::{Chunk, ChunkDims, ChunkError, VoxelId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerrainError {
    InvalidHeightRange,
    CoordinateOverflow,
    Chunk(ChunkError),
}

impl std::fmt::Display for TerrainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidHeightRange => f.write_str("maximum height is less than minimum height"),
            Self::CoordinateOverflow => f.write_str("terrain origin exceeds the coordinate range"),
            Self::Chunk(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for TerrainError {}

impl From<ChunkError> for TerrainError {
    fn from(error: ChunkError) -> Self {
        Self::Chunk(error)
    }
}

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
/// for world column `(x, z)` under `seed`. Rejects inverted bounds.
pub fn column_height(
    seed: u32,
    x: i32,
    z: i32,
    min_height: u32,
    max_height: u32,
) -> Result<u32, TerrainError> {
    if max_height < min_height {
        return Err(TerrainError::InvalidHeightRange);
    }
    let span = u64::from(max_height) - u64::from(min_height) + 1;
    Ok((u64::from(min_height) + u64::from(hash2(seed, x, z)) % span) as u32)
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
) -> Result<Chunk, TerrainError> {
    dims.validate()?;
    origin_x
        .checked_add(dims.x as i32 - 1)
        .ok_or(TerrainError::CoordinateOverflow)?;
    origin_z
        .checked_add(dims.z as i32 - 1)
        .ok_or(TerrainError::CoordinateOverflow)?;
    let mut chunk = Chunk::new(dims)?;
    let max_height = dims.y.saturating_sub(1);
    for z in 0..dims.z {
        for x in 0..dims.x {
            let height = column_height(
                seed,
                origin_x + x as i32,
                origin_z + z as i32,
                1.min(max_height),
                max_height,
            )?;
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
        let a = column_height(42, 3, -7, 1, 15).unwrap();
        let b = column_height(42, 3, -7, 1, 15).unwrap();
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
    fn column_height_rejects_inverted_bounds_and_accepts_full_range() {
        assert_eq!(
            column_height(1, 0, 0, 10, 5),
            Err(TerrainError::InvalidHeightRange)
        );
        assert!(column_height(1, 0, 0, 0, u32::MAX).is_ok());
        assert_eq!(column_height(1, 0, 0, u32::MAX, u32::MAX), Ok(u32::MAX));
    }

    #[test]
    fn terrain_rejects_coordinate_overflow_and_accepts_one_layer() {
        assert_eq!(
            generate_chunk(1, ChunkDims::new(2, 1, 1), i32::MAX, 0).unwrap_err(),
            TerrainError::CoordinateOverflow
        );
        assert!(
            generate_chunk(1, ChunkDims::new(1, 1, 1), i32::MAX, i32::MAX)
                .unwrap()
                .is_solid(0, 0, 0)
        );
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
