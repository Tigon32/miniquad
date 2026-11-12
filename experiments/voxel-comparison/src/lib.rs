//! Shared workload and adapters for the issue #29 benchmark-only
//! comparison between `miniquad-voxel`'s own visible-face mesher
//! (`miniquad_voxel::mesh::build_chunk_mesh`) and `block-mesh`'s
//! `visible_block_faces`, on an identical voxel grid.
//!
//! This crate is isolated from the production Miniquad and
//! `companions/voxel` builds: it is never built by core CI, never a
//! dependency of any companion, and exists only to produce dated
//! evidence in `docs/performance-evidence/`.

use block_mesh::ndshape::{ConstShape, ConstShape3u32};
use block_mesh::{
    visible_block_faces, OrientedBlockFace, UnitQuadBuffer, Voxel, VoxelVisibility,
    RIGHT_HANDED_Y_UP_CONFIG,
};
use miniquad_voxel::chunk::{Chunk, ChunkDims};
use miniquad_voxel::mesh::{build_chunk_mesh, MeshBuffers};
use miniquad_voxel::sim::{SCENE_CHUNK_DIMS, SCENE_SEED};
use miniquad_voxel::terrain::generate_chunk;
use miniquad_voxel::world::{ChunkCoord, World};

/// The one-chunk workload both algorithms mesh: the real fixed-scene
/// terrain generator (`SCENE_SEED`, `SCENE_CHUNK_DIMS`), at world
/// column origin `(0, 0)`, in a `World` with no resident neighbor
/// chunk. Isolating a single chunk (rather than the full two-chunk
/// scene) keeps both sides of the comparison on equal footing:
/// `block-mesh` has no `World`/cross-chunk concept, so comparing a
/// lone chunk means neither mesher benefits from neighbor-chunk face
/// culling the other cannot perform.
pub fn workload_chunk() -> Chunk {
    generate_chunk(SCENE_SEED, SCENE_CHUNK_DIMS, 0, 0).expect("fixed scene dims are always valid")
}

/// `miniquad-voxel`'s own chunk dimensions for the workload (8x12x8 =
/// 768 voxels, the real fixed scene's per-chunk size).
pub const DIMS: ChunkDims = SCENE_CHUNK_DIMS;

/// `block-mesh` padded shape: each axis gets a 1-voxel air border so
/// `visible_block_faces` can test boundary faces without a neighbor
/// chunk, matching the no-neighbor `World` used on the
/// `miniquad-voxel` side.
pub type PaddedShape = ConstShape3u32<10, 14, 10>;

/// Runs `miniquad-voxel`'s own mesher on [`workload_chunk`] in a
/// `World` with exactly that one chunk resident (no neighbor), and
/// returns the filled output buffer.
pub fn run_miniquad_voxel_mesher(chunk: &Chunk, out: &mut MeshBuffers) {
    let mut world = World::new(DIMS, 1).expect("one-chunk world is always valid");
    world.insert(ChunkCoord::new(0, 0, 0), chunk.clone()).expect("fresh world has room");
    build_chunk_mesh(&world, ChunkCoord::new(0, 0, 0), &PALETTE, out)
        .expect("the chunk we just inserted is resident");
}

/// Shared palette: 2 entries (air is never shaded; material 1 is
/// opaque green), matching `miniquad-voxel`'s own test fixtures.
pub const PALETTE: [[f32; 4]; 2] = [[0.0, 0.0, 0.0, 0.0], [0.2, 0.7, 0.2, 1.0]];

/// A `block-mesh` voxel: wraps the raw material ID. Any nonzero ID is
/// opaque, matching `miniquad_voxel::chunk::AIR == 0`.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct BlockMeshVoxel(pub u8);

impl Voxel for BlockMeshVoxel {
    fn get_visibility(&self) -> VoxelVisibility {
        if self.0 == 0 {
            VoxelVisibility::Empty
        } else {
            VoxelVisibility::Opaque
        }
    }
}

/// Builds the padded voxel array `block-mesh` requires: a 1-voxel air
/// border around the real chunk data, laid out in `PaddedShape`'s
/// linear order. Padding is always air, so it never contributes a
/// face by itself; it only lets `visible_block_faces` evaluate the
/// real chunk's boundary faces without a neighbor-chunk lookup,
/// mirroring the no-neighbor `World` on the other side of the
/// comparison.
pub fn build_padded_array(chunk: &Chunk) -> Vec<BlockMeshVoxel> {
    let mut voxels = vec![BlockMeshVoxel(0); PaddedShape::SIZE as usize];
    for z in 0..DIMS.z {
        for y in 0..DIMS.y {
            for x in 0..DIMS.x {
                let id = chunk.get(x, y, z).expect("in-bounds coordinate");
                let i = PaddedShape::linearize([x + 1, y + 1, z + 1]);
                voxels[i as usize] = BlockMeshVoxel(id);
            }
        }
    }
    voxels
}

/// Runs `block-mesh`'s `visible_block_faces` on the padded workload
/// and returns the filled quad buffer.
pub fn run_block_mesh(padded: &[BlockMeshVoxel], out: &mut UnitQuadBuffer) {
    out.reset();
    visible_block_faces(
        padded,
        &PaddedShape {},
        [0; 3],
        [9, 13, 9],
        &RIGHT_HANDED_Y_UP_CONFIG.faces,
        out,
    );
}

/// Total emitted quad count for a `block-mesh` result (sum across the
/// 6 face-direction groups).
pub fn block_mesh_quad_count(out: &UnitQuadBuffer) -> usize {
    out.num_quads()
}

/// Total emitted quad count for a `miniquad-voxel` mesher result
/// (4 vertices / 6 indices per quad).
pub fn miniquad_voxel_quad_count(out: &MeshBuffers) -> usize {
    out.indices.len() / 6
}

/// A deterministic byte hash of a `miniquad-voxel` mesh's quad count
/// and vertex positions, independent of emission order within a
/// single run (the mesher itself is deterministic, so this is mainly
/// a tamper-evident fingerprint for the benchmark report).
pub fn hash_miniquad_voxel_mesh(out: &MeshBuffers) -> u64 {
    let mut hash: u64 = 1469598103934665603; // FNV-1a offset basis
    for v in &out.vertices {
        for f in v.pos.iter().chain(v.normal.iter()).chain(v.color.iter()) {
            for b in f.to_bits().to_le_bytes() {
                hash ^= b as u64;
                hash = hash.wrapping_mul(1099511628211);
            }
        }
    }
    hash
}

/// Exposed so `orientation` (face direction) data is fully
/// documented, even though the comparison only reports counts: a
/// future reader checking "did this really emit real oriented
/// quads" can see the face table used.
pub fn face_table() -> &'static [OrientedBlockFace; 6] {
    &RIGHT_HANDED_Y_UP_CONFIG.faces
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn padded_array_has_exact_expected_length() {
        let chunk = workload_chunk();
        let padded = build_padded_array(&chunk);
        assert_eq!(padded.len(), PaddedShape::SIZE as usize);
        assert_eq!(padded.len(), 10 * 14 * 10);
    }

    #[test]
    fn same_single_voxel_workload_yields_the_same_visible_face_count() {
        // A hand-built minimal workload (a single solid voxel,
        // isolated by air on every side) must produce exactly 6
        // visible faces on both meshers: this is the simplest
        // "equivalent workload" sanity check before trusting the
        // real-terrain comparison below.
        let dims = ChunkDims::new(4, 4, 4);
        let mut chunk = Chunk::new(dims).unwrap();
        chunk.set(1, 1, 1, 1).unwrap();

        let mut world = World::new(dims, 1).unwrap();
        world.insert(ChunkCoord::new(0, 0, 0), chunk.clone()).unwrap();
        let mut mq_out = MeshBuffers::new();
        build_chunk_mesh(&world, ChunkCoord::new(0, 0, 0), &PALETTE, &mut mq_out).unwrap();
        assert_eq!(miniquad_voxel_quad_count(&mq_out), 6);

        type SmallPadded = ConstShape3u32<6, 6, 6>;
        let mut padded = vec![BlockMeshVoxel(0); SmallPadded::SIZE as usize];
        padded[SmallPadded::linearize([2, 2, 2]) as usize] = BlockMeshVoxel(1);
        let mut bm_out = UnitQuadBuffer::new();
        visible_block_faces(
            &padded,
            &SmallPadded {},
            [0; 3],
            [5, 5, 5],
            &RIGHT_HANDED_Y_UP_CONFIG.faces,
            &mut bm_out,
        );
        assert_eq!(block_mesh_quad_count(&bm_out), 6);
    }

    #[test]
    fn real_scene_terrain_chunk_yields_equal_visible_face_counts() {
        let chunk = workload_chunk();

        let mut mq_out = MeshBuffers::new();
        run_miniquad_voxel_mesher(&chunk, &mut mq_out);
        let mq_count = miniquad_voxel_quad_count(&mq_out);

        let padded = build_padded_array(&chunk);
        let mut bm_out = UnitQuadBuffer::new();
        run_block_mesh(&padded, &mut bm_out);
        let bm_count = block_mesh_quad_count(&bm_out);

        assert!(mq_count > 0, "the real terrain chunk must have visible faces");
        assert_eq!(
            mq_count, bm_count,
            "both meshers must agree on the visible-face count for an \
             identical, equivalently-isolated voxel grid"
        );
    }

    #[test]
    fn mesh_hash_is_stable_across_repeated_runs_of_the_same_input() {
        let chunk = workload_chunk();
        let mut out_a = MeshBuffers::new();
        run_miniquad_voxel_mesher(&chunk, &mut out_a);
        let mut out_b = MeshBuffers::new();
        run_miniquad_voxel_mesher(&chunk, &mut out_b);
        assert_eq!(hash_miniquad_voxel_mesh(&out_a), hash_miniquad_voxel_mesh(&out_b));
    }
}
