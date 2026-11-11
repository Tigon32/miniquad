//! Isolated single-mesher binary for issue #29's WASM compiled-size
//! footprint evidence: exercises ONLY `miniquad-voxel`'s own
//! `build_chunk_mesh`, with no `block-mesh` codepath reachable, so
//! its compiled `wasm32-unknown-unknown` binary size reflects that
//! mesher's own code-size contribution. Paired with
//! `wasm_footprint_block_mesh.rs` for a same-workload comparison. See
//! `docs/performance-evidence/` for the measured sizes. Not built by
//! any core/production/CI path.

use miniquad_voxel::mesh::MeshBuffers;
use voxel_comparison::{miniquad_voxel_quad_count, run_miniquad_voxel_mesher, workload_chunk};

fn main() {
    let chunk = workload_chunk();
    let mut out = MeshBuffers::default();
    run_miniquad_voxel_mesher(&chunk, &mut out);
    println!("quads: {}", miniquad_voxel_quad_count(&out));
}
