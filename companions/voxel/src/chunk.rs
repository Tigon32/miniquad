//! Bounded voxel chunk storage.
//!
//! A chunk is a dense 3D grid of voxel material IDs. This module bounds
//! chunk dimensions and total voxel count before any allocation, so an
//! oversized or overflowed request is rejected instead of allocating an
//! unbounded buffer. See `docs/offline-voxel.md` for the resource
//! contract this implements (MADR 0008, "Domain and resource
//! contracts").

/// Largest permitted length of any single chunk axis.
pub const MAX_CHUNK_DIM: u32 = 64;

/// Largest permitted total voxel count in one chunk
/// (`MAX_CHUNK_DIM` cubed).
pub const MAX_CHUNK_VOLUME: u64 = (MAX_CHUNK_DIM as u64).pow(3);

/// A voxel material ID. `0` means empty (air). Nonzero values select a
/// palette entry; see [`crate::terrain`].
pub type VoxelId = u8;

/// The empty (air) voxel ID.
pub const AIR: VoxelId = 0;

/// Explicit, bounded chunk dimensions along each axis.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkDims {
    pub x: u32,
    pub y: u32,
    pub z: u32,
}

impl ChunkDims {
    pub const fn new(x: u32, y: u32, z: u32) -> ChunkDims {
        ChunkDims { x, y, z }
    }

    /// Returns the total voxel count, or `None` if the multiplication
    /// would overflow `u64`. Overflow is checked explicitly because
    /// `wasm32-unknown-unknown` and other 32-bit targets must not be
    /// able to reach undefined behavior from a crafted huge input.
    pub fn volume(&self) -> Option<u64> {
        (self.x as u64)
            .checked_mul(self.y as u64)?
            .checked_mul(self.z as u64)
    }

    /// Validates the dimensions against the bounded limits. Rejects a
    /// zero axis (an empty chunk has no useful meaning here), an axis
    /// over [`MAX_CHUNK_DIM`], an overflowed volume, and a volume over
    /// [`MAX_CHUNK_VOLUME`].
    pub fn validate(&self) -> Result<(), ChunkError> {
        if self.x == 0 || self.y == 0 || self.z == 0 {
            return Err(ChunkError::ZeroDimension);
        }
        if self.x > MAX_CHUNK_DIM || self.y > MAX_CHUNK_DIM || self.z > MAX_CHUNK_DIM {
            return Err(ChunkError::DimensionTooLarge);
        }
        match self.volume() {
            Some(volume) if volume <= MAX_CHUNK_VOLUME => Ok(()),
            _ => Err(ChunkError::VolumeTooLarge),
        }
    }

    fn index(&self, x: u32, y: u32, z: u32) -> Option<usize> {
        if x >= self.x || y >= self.y || z >= self.z {
            return None;
        }
        // Validated dimensions keep this product within `MAX_CHUNK_VOLUME`,
        // which fits in `usize` on every target this crate supports
        // (including 32-bit wasm32).
        let index = (z as u64) * (self.y as u64) * (self.x as u64)
            + (y as u64) * (self.x as u64)
            + (x as u64);
        Some(index as usize)
    }
}

/// An error building or indexing a [`Chunk`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChunkError {
    /// One axis was zero.
    ZeroDimension,
    /// One axis exceeded [`MAX_CHUNK_DIM`].
    DimensionTooLarge,
    /// The total voxel count overflowed, or exceeded
    /// [`MAX_CHUNK_VOLUME`].
    VolumeTooLarge,
    /// A coordinate was outside the chunk's own dimensions.
    OutOfBounds,
}

impl std::fmt::Display for ChunkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            ChunkError::ZeroDimension => "chunk dimension must not be zero",
            ChunkError::DimensionTooLarge => "chunk dimension exceeds MAX_CHUNK_DIM",
            ChunkError::VolumeTooLarge => "chunk volume exceeds MAX_CHUNK_VOLUME",
            ChunkError::OutOfBounds => "voxel coordinate is outside chunk dimensions",
        };
        f.write_str(message)
    }
}

impl std::error::Error for ChunkError {}

/// A dense, bounded 3D grid of voxel material IDs.
#[derive(Clone, Debug)]
pub struct Chunk {
    dims: ChunkDims,
    voxels: Vec<VoxelId>,
}

impl Chunk {
    /// Allocates a chunk filled with [`AIR`]. Rejects `dims` that fail
    /// [`ChunkDims::validate`] before allocating.
    pub fn new(dims: ChunkDims) -> Result<Chunk, ChunkError> {
        dims.validate()?;
        // `validate` already proved `volume() <= MAX_CHUNK_VOLUME`, which
        // fits in `usize` on every supported target.
        let volume = dims.volume().expect("validated dims have a volume") as usize;
        Ok(Chunk {
            dims,
            voxels: vec![AIR; volume],
        })
    }

    pub fn dims(&self) -> ChunkDims {
        self.dims
    }

    /// Reads the voxel at a local coordinate. Returns `None` for a
    /// coordinate outside the chunk's own dimensions.
    pub fn get(&self, x: u32, y: u32, z: u32) -> Option<VoxelId> {
        self.dims.index(x, y, z).map(|i| self.voxels[i])
    }

    /// Writes the voxel at a local coordinate. Returns
    /// [`ChunkError::OutOfBounds`] for a coordinate outside the
    /// chunk's own dimensions.
    pub fn set(&mut self, x: u32, y: u32, z: u32, id: VoxelId) -> Result<(), ChunkError> {
        let index = self.dims.index(x, y, z).ok_or(ChunkError::OutOfBounds)?;
        self.voxels[index] = id;
        Ok(())
    }

    /// Returns `true` if the voxel at a local coordinate is present
    /// and nonzero. A coordinate outside the chunk's own dimensions is
    /// treated as not solid; callers that need chunk-boundary
    /// awareness should use [`crate::world::World::is_solid`] instead.
    pub fn is_solid(&self, x: u32, y: u32, z: u32) -> bool {
        self.get(x, y, z).map(|id| id != AIR).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_rejects_zero_dimension() {
        assert_eq!(
            Chunk::new(ChunkDims::new(0, 4, 4)).unwrap_err(),
            ChunkError::ZeroDimension
        );
    }

    #[test]
    fn new_rejects_dimension_too_large() {
        assert_eq!(
            Chunk::new(ChunkDims::new(MAX_CHUNK_DIM + 1, 1, 1)).unwrap_err(),
            ChunkError::DimensionTooLarge
        );
    }

    #[test]
    fn new_accepts_max_dimensions() {
        let dims = ChunkDims::new(MAX_CHUNK_DIM, MAX_CHUNK_DIM, MAX_CHUNK_DIM);
        assert!(Chunk::new(dims).is_ok());
    }

    #[test]
    fn volume_is_overflow_safe_for_huge_dimensions() {
        // `u32::MAX` cubed overflows `u64`; `volume()` must report that
        // with `None` instead of panicking, even on a 32-bit target.
        let dims = ChunkDims::new(u32::MAX, u32::MAX, u32::MAX);
        assert_eq!(dims.volume(), None);
        assert_eq!(dims.validate().unwrap_err(), ChunkError::DimensionTooLarge);
    }

    #[test]
    fn get_set_round_trip() {
        let mut chunk = Chunk::new(ChunkDims::new(2, 2, 2)).unwrap();
        assert_eq!(chunk.get(1, 1, 1), Some(AIR));
        chunk.set(1, 1, 1, 7).unwrap();
        assert_eq!(chunk.get(1, 1, 1), Some(7));
        assert!(chunk.is_solid(1, 1, 1));
    }

    #[test]
    fn get_set_out_of_bounds() {
        let mut chunk = Chunk::new(ChunkDims::new(2, 2, 2)).unwrap();
        assert_eq!(chunk.get(2, 0, 0), None);
        assert_eq!(chunk.set(0, 0, 2, 1).unwrap_err(), ChunkError::OutOfBounds);
    }
}
