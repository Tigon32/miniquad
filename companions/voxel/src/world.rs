//! A bounded grid of resident [`Chunk`]s, keyed by integer chunk
//! coordinate. Enforces a maximum resident-chunk count before
//! insertion and exposes a boundary-aware solidity query so meshing
//! can cull faces across chunk edges.

use crate::chunk::{Chunk, ChunkDims};
use std::collections::HashMap;

/// An integer coordinate of one chunk within the world grid. Distinct
/// from a voxel's local coordinate inside one chunk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ChunkCoord {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

impl ChunkCoord {
    pub const fn new(x: i32, y: i32, z: i32) -> ChunkCoord {
        ChunkCoord { x, y, z }
    }
}

/// An error inserting a chunk into a [`World`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorldError {
    /// The chunk's dimensions do not match the world's configured
    /// chunk dimensions. A world holds uniform chunk sizes so boundary
    /// math stays simple and bounded.
    MismatchedDims,
    /// Inserting this chunk would exceed the configured
    /// `max_resident_chunks` limit.
    TooManyResidentChunks,
}

impl std::fmt::Display for WorldError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            WorldError::MismatchedDims => {
                "chunk dimensions do not match the world's chunk dimensions"
            }
            WorldError::TooManyResidentChunks => {
                "inserting this chunk would exceed max_resident_chunks"
            }
        };
        f.write_str(message)
    }
}

impl std::error::Error for WorldError {}

/// A bounded grid of resident chunks sharing one [`ChunkDims`].
#[derive(Debug)]
pub struct World {
    dims: ChunkDims,
    max_resident_chunks: usize,
    chunks: HashMap<ChunkCoord, Chunk>,
}

impl World {
    /// Creates an empty world. `max_resident_chunks` must be greater
    /// than zero; a world that can hold zero chunks has no use.
    pub fn new(dims: ChunkDims, max_resident_chunks: usize) -> Result<World, WorldError> {
        if max_resident_chunks == 0 {
            return Err(WorldError::TooManyResidentChunks);
        }
        Ok(World {
            dims,
            max_resident_chunks,
            chunks: HashMap::new(),
        })
    }

    pub fn dims(&self) -> ChunkDims {
        self.dims
    }

    pub fn max_resident_chunks(&self) -> usize {
        self.max_resident_chunks
    }

    pub fn resident_chunk_count(&self) -> usize {
        self.chunks.len()
    }

    /// Inserts or replaces the chunk at `coord`. Rejects a chunk whose
    /// dimensions differ from the world's, and rejects adding a *new*
    /// coordinate once the world already holds
    /// [`World::max_resident_chunks`] chunks. Replacing an existing
    /// coordinate's chunk is always permitted.
    pub fn insert(&mut self, coord: ChunkCoord, chunk: Chunk) -> Result<(), WorldError> {
        if chunk.dims() != self.dims {
            return Err(WorldError::MismatchedDims);
        }
        if !self.chunks.contains_key(&coord) && self.chunks.len() >= self.max_resident_chunks {
            return Err(WorldError::TooManyResidentChunks);
        }
        self.chunks.insert(coord, chunk);
        Ok(())
    }

    pub fn get(&self, coord: ChunkCoord) -> Option<&Chunk> {
        self.chunks.get(&coord)
    }

    /// Releases a resident chunk, if any, returning it. This is the
    /// explicit eviction path: the caller holds the returned [`Chunk`]
    /// only as long as it chooses, after which its CPU allocation is
    /// dropped.
    pub fn evict(&mut self, coord: ChunkCoord) -> Option<Chunk> {
        self.chunks.remove(&coord)
    }

    /// Reports whether the voxel at local coordinate `(x, y, z)` in
    /// chunk `coord` is solid, resolving coordinates that fall outside
    /// `[0, dims)` by stepping into the neighboring chunk.
    ///
    /// Boundary policy: if a neighbor chunk is required to resolve the
    /// query and that neighbor is not resident, the voxel is treated as
    /// **not solid** (an exposed boundary is conservatively drawn
    /// rather than silently culled). See `docs/offline-voxel.md` for
    /// the reasoning.
    pub fn is_solid(&self, coord: ChunkCoord, x: i32, y: i32, z: i32) -> bool {
        let (neighbor_coord, local) = self.resolve(coord, x, y, z);
        match self.chunks.get(&neighbor_coord) {
            Some(chunk) => chunk.is_solid(local.0, local.1, local.2),
            None => false,
        }
    }

    /// Translates a possibly out-of-range local coordinate into the
    /// chunk coordinate that owns it and that chunk's local
    /// coordinate. Assumes `x`, `y`, `z` are within one chunk width of
    /// `[0, dims)`, which is always true for the 6-direction neighbor
    /// offsets meshing uses.
    fn resolve(&self, coord: ChunkCoord, x: i32, y: i32, z: i32) -> (ChunkCoord, (u32, u32, u32)) {
        let (cx, lx) = wrap_axis(x, self.dims.x);
        let (cy, ly) = wrap_axis(y, self.dims.y);
        let (cz, lz) = wrap_axis(z, self.dims.z);
        (
            ChunkCoord::new(coord.x + cx, coord.y + cy, coord.z + cz),
            (lx, ly, lz),
        )
    }
}

/// Maps a local axis coordinate that may be one step outside
/// `[0, dim)` to a `(chunk offset, wrapped local coordinate)` pair.
fn wrap_axis(value: i32, dim: u32) -> (i32, u32) {
    if value < 0 {
        (-1, dim - 1)
    } else if value >= dim as i32 {
        (1, 0)
    } else {
        (0, value as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::Chunk;

    fn dims() -> ChunkDims {
        ChunkDims::new(4, 4, 4)
    }

    #[test]
    fn new_rejects_zero_max_resident_chunks() {
        assert_eq!(
            World::new(dims(), 0).unwrap_err(),
            WorldError::TooManyResidentChunks
        );
    }

    #[test]
    fn insert_rejects_mismatched_dims() {
        let mut world = World::new(dims(), 4).unwrap();
        let other = Chunk::new(ChunkDims::new(2, 2, 2)).unwrap();
        assert_eq!(
            world.insert(ChunkCoord::new(0, 0, 0), other).unwrap_err(),
            WorldError::MismatchedDims
        );
    }

    #[test]
    fn insert_rejects_exceeding_max_resident_chunks() {
        let mut world = World::new(dims(), 1).unwrap();
        world
            .insert(ChunkCoord::new(0, 0, 0), Chunk::new(dims()).unwrap())
            .unwrap();
        let err = world
            .insert(ChunkCoord::new(1, 0, 0), Chunk::new(dims()).unwrap())
            .unwrap_err();
        assert_eq!(err, WorldError::TooManyResidentChunks);
    }

    #[test]
    fn insert_allows_replacing_resident_coordinate() {
        let mut world = World::new(dims(), 1).unwrap();
        let coord = ChunkCoord::new(0, 0, 0);
        world.insert(coord, Chunk::new(dims()).unwrap()).unwrap();
        // Replacing the same coordinate must not be rejected as "too many".
        world.insert(coord, Chunk::new(dims()).unwrap()).unwrap();
        assert_eq!(world.resident_chunk_count(), 1);
    }

    #[test]
    fn is_solid_crosses_chunk_boundary_when_neighbor_present() {
        let mut world = World::new(dims(), 2).unwrap();
        let mut a = Chunk::new(dims()).unwrap();
        a.set(3, 0, 0, 1).unwrap();
        let mut b = Chunk::new(dims()).unwrap();
        b.set(0, 0, 0, 1).unwrap();
        world.insert(ChunkCoord::new(0, 0, 0), a).unwrap();
        world.insert(ChunkCoord::new(1, 0, 0), b).unwrap();

        // From chunk (0,0,0)'s perspective, local x=4 is chunk (1,0,0)'s x=0.
        assert!(world.is_solid(ChunkCoord::new(0, 0, 0), 4, 0, 0));
        // From chunk (1,0,0)'s perspective, local x=-1 is chunk (0,0,0)'s x=3.
        assert!(world.is_solid(ChunkCoord::new(1, 0, 0), -1, 0, 0));
    }

    #[test]
    fn is_solid_treats_missing_neighbor_as_not_solid() {
        let mut world = World::new(dims(), 2).unwrap();
        world
            .insert(ChunkCoord::new(0, 0, 0), Chunk::new(dims()).unwrap())
            .unwrap();
        assert!(!world.is_solid(ChunkCoord::new(0, 0, 0), 4, 0, 0));
    }

    #[test]
    fn evict_removes_resident_chunk() {
        let mut world = World::new(dims(), 1).unwrap();
        let coord = ChunkCoord::new(0, 0, 0);
        world.insert(coord, Chunk::new(dims()).unwrap()).unwrap();
        assert!(world.evict(coord).is_some());
        assert_eq!(world.resident_chunk_count(), 0);
        assert!(world.evict(coord).is_none());
    }
}
