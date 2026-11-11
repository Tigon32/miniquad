//! Visible-face meshing for one resident chunk.
//!
//! Only faces that border an empty voxel (inside the chunk or, when a
//! neighbor chunk is resident, across the chunk boundary) are emitted.
//! [`MeshBuffers`] is reused across calls: [`MeshBuffers::clear`] keeps
//! the underlying `Vec` allocations and truncates their length, so
//! rebuilding a chunk's mesh does not allocate a new buffer every call.

use crate::chunk::ChunkDims;
use crate::world::{ChunkCoord, World};

/// One mesh vertex: position, face normal (for flat shading), and a
/// straight-alpha RGBA color selected from the voxel's material.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vertex {
    pub pos: [f32; 3],
    pub normal: [f32; 3],
    pub color: [f32; 4],
}

/// An error building a chunk mesh.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeshError {
    /// The requested chunk coordinate has no resident chunk.
    ChunkNotResident,
}

impl std::fmt::Display for MeshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the requested chunk coordinate has no resident chunk")
    }
}

impl std::error::Error for MeshError {}

/// The six axis-aligned face directions, as `(dx, dy, dz, normal)`.
const FACE_DIRECTIONS: [(i32, i32, i32, [f32; 3]); 6] = [
    (1, 0, 0, [1.0, 0.0, 0.0]),
    (-1, 0, 0, [-1.0, 0.0, 0.0]),
    (0, 1, 0, [0.0, 1.0, 0.0]),
    (0, -1, 0, [0.0, -1.0, 0.0]),
    (0, 0, 1, [0.0, 0.0, 1.0]),
    (0, 0, -1, [0.0, 0.0, -1.0]),
];

/// Reusable, growable mesh output buffers. Create once per mesh slot
/// and reuse across rebuilds via [`MeshBuffers::clear`].
#[derive(Default)]
pub struct MeshBuffers {
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
}

impl MeshBuffers {
    pub fn new() -> MeshBuffers {
        MeshBuffers::default()
    }

    /// Truncates both buffers to empty without releasing their
    /// allocated capacity, so the next build reuses the existing
    /// memory instead of allocating fresh `Vec`s.
    pub fn clear(&mut self) {
        self.vertices.clear();
        self.indices.clear();
    }

    fn push_quad(&mut self, corners: [[f32; 3]; 4], normal: [f32; 3], color: [f32; 4]) {
        let base = self.vertices.len() as u32;
        for corner in corners {
            self.vertices.push(Vertex {
                pos: corner,
                normal,
                color,
            });
        }
        self.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

/// Appends the visible-face mesh for the resident chunk at `coord`
/// into `out`. `out` is cleared first, so a caller does not need to
/// call [`MeshBuffers::clear`] separately. `palette` maps a voxel
/// material ID (as `usize`) to a straight-alpha RGBA color; an ID
/// outside `palette`'s bounds falls back to opaque white.
pub fn build_chunk_mesh(
    world: &World,
    coord: ChunkCoord,
    palette: &[[f32; 4]],
    out: &mut MeshBuffers,
) -> Result<(), MeshError> {
    out.clear();
    let chunk = world.get(coord).ok_or(MeshError::ChunkNotResident)?;
    let dims: ChunkDims = chunk.dims();

    for z in 0..dims.z {
        for y in 0..dims.y {
            for x in 0..dims.x {
                let id = match chunk.get(x, y, z) {
                    Some(id) if id != crate::chunk::AIR => id,
                    _ => continue,
                };
                let color = palette
                    .get(id as usize)
                    .copied()
                    .unwrap_or([1.0, 1.0, 1.0, 1.0]);

                for (dx, dy, dz, normal) in FACE_DIRECTIONS {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    let nz = z as i32 + dz;
                    if world.is_solid(coord, nx, ny, nz) {
                        continue;
                    }
                    out.push_quad(face_corners(x, y, z, normal), normal, color);
                }
            }
        }
    }
    Ok(())
}

/// Returns the four corners of one unit-voxel face in
/// counter-clockwise winding as seen from outside the voxel, offset by
/// the voxel's integer position.
fn face_corners(x: u32, y: u32, z: u32, normal: [f32; 3]) -> [[f32; 3]; 4] {
    let (ox, oy, oz) = (x as f32, y as f32, z as f32);
    let local: [[f32; 3]; 4] = match normal {
        [1.0, 0.0, 0.0] => [[1., 0., 0.], [1., 1., 0.], [1., 1., 1.], [1., 0., 1.]],
        [-1.0, 0.0, 0.0] => [[0., 0., 1.], [0., 1., 1.], [0., 1., 0.], [0., 0., 0.]],
        [0.0, 1.0, 0.0] => [[0., 1., 0.], [0., 1., 1.], [1., 1., 1.], [1., 1., 0.]],
        [0.0, -1.0, 0.0] => [[0., 0., 1.], [0., 0., 0.], [1., 0., 0.], [1., 0., 1.]],
        [0.0, 0.0, 1.0] => [[1., 0., 1.], [1., 1., 1.], [0., 1., 1.], [0., 0., 1.]],
        _ => [[0., 0., 0.], [0., 1., 0.], [1., 1., 0.], [1., 0., 0.]],
    };
    local.map(|[lx, ly, lz]| [ox + lx, oy + ly, oz + lz])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::{Chunk, ChunkDims};

    const PALETTE: [[f32; 4]; 2] = [[0.0, 0.0, 0.0, 0.0], [0.2, 0.7, 0.2, 1.0]];

    fn small_world(max_resident: usize) -> (World, ChunkDims) {
        let dims = ChunkDims::new(4, 4, 4);
        (World::new(dims, max_resident).unwrap(), dims)
    }

    #[test]
    fn empty_chunk_has_no_faces() {
        let (mut world, dims) = small_world(1);
        let coord = ChunkCoord::new(0, 0, 0);
        world.insert(coord, Chunk::new(dims).unwrap()).unwrap();

        let mut out = MeshBuffers::new();
        build_chunk_mesh(&world, coord, &PALETTE, &mut out).unwrap();
        assert!(out.vertices.is_empty());
        assert!(out.indices.is_empty());
    }

    #[test]
    fn single_voxel_produces_six_faces() {
        let (mut world, dims) = small_world(1);
        let coord = ChunkCoord::new(0, 0, 0);
        let mut chunk = Chunk::new(dims).unwrap();
        chunk.set(1, 1, 1, 1).unwrap();
        world.insert(coord, chunk).unwrap();

        let mut out = MeshBuffers::new();
        build_chunk_mesh(&world, coord, &PALETTE, &mut out).unwrap();
        assert_eq!(out.vertices.len(), 6 * 4);
        assert_eq!(out.indices.len(), 6 * 6);
    }

    #[test]
    fn adjacent_voxels_cull_shared_interior_faces() {
        let (mut world, dims) = small_world(1);
        let coord = ChunkCoord::new(0, 0, 0);
        let mut chunk = Chunk::new(dims).unwrap();
        chunk.set(1, 1, 1, 1).unwrap();
        chunk.set(2, 1, 1, 1).unwrap();
        world.insert(coord, chunk).unwrap();

        let mut out = MeshBuffers::new();
        build_chunk_mesh(&world, coord, &PALETTE, &mut out).unwrap();
        // 12 naive faces minus 2 shared faces (one per voxel) = 10 visible faces.
        assert_eq!(out.vertices.len(), 10 * 4);
        assert_eq!(out.indices.len(), 10 * 6);
    }

    #[test]
    fn resident_neighbor_chunk_culls_boundary_face() {
        let (mut world, dims) = small_world(2);
        let a = ChunkCoord::new(0, 0, 0);
        let b = ChunkCoord::new(1, 0, 0);
        let mut chunk_a = Chunk::new(dims).unwrap();
        chunk_a.set(3, 0, 0, 1).unwrap();
        let mut chunk_b = Chunk::new(dims).unwrap();
        chunk_b.set(0, 0, 0, 1).unwrap();
        world.insert(a, chunk_a).unwrap();
        world.insert(b, chunk_b).unwrap();

        let mut out = MeshBuffers::new();
        build_chunk_mesh(&world, a, &PALETTE, &mut out).unwrap();
        // The +x face (toward chunk b) is culled; the other 5 remain.
        assert_eq!(out.vertices.len(), 5 * 4);
    }

    #[test]
    fn missing_neighbor_chunk_leaves_boundary_face_visible() {
        let (mut world, dims) = small_world(2);
        let a = ChunkCoord::new(0, 0, 0);
        let mut chunk_a = Chunk::new(dims).unwrap();
        chunk_a.set(3, 0, 0, 1).unwrap();
        world.insert(a, chunk_a).unwrap();

        let mut out = MeshBuffers::new();
        build_chunk_mesh(&world, a, &PALETTE, &mut out).unwrap();
        // No neighbor chunk at (1,0,0): all 6 faces stay visible.
        assert_eq!(out.vertices.len(), 6 * 4);
    }

    #[test]
    fn build_chunk_mesh_rejects_non_resident_coordinate() {
        let (world, _dims) = small_world(1);
        let mut out = MeshBuffers::new();
        let err =
            build_chunk_mesh(&world, ChunkCoord::new(9, 9, 9), &PALETTE, &mut out).unwrap_err();
        assert_eq!(err, MeshError::ChunkNotResident);
    }

    #[test]
    fn reused_buffer_matches_fresh_build_after_clear() {
        let (mut world, dims) = small_world(1);
        let coord = ChunkCoord::new(0, 0, 0);
        let mut chunk = Chunk::new(dims).unwrap();
        chunk.set(1, 1, 1, 1).unwrap();
        world.insert(coord, chunk).unwrap();

        let mut out = MeshBuffers::new();
        build_chunk_mesh(&world, coord, &PALETTE, &mut out).unwrap();
        let first_len = out.vertices.len();
        let first_capacity = out.vertices.capacity();

        // Rebuild into the same buffer; capacity must not shrink, and
        // content must match the first build (reuse, not reallocation).
        build_chunk_mesh(&world, coord, &PALETTE, &mut out).unwrap();
        assert_eq!(out.vertices.len(), first_len);
        assert!(out.vertices.capacity() >= first_capacity);
    }
}
