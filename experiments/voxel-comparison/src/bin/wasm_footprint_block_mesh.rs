//! Isolated single-mesher binary for issue #29's WASM compiled-size
//! footprint evidence: exercises ONLY `block-mesh`'s
//! `visible_block_faces`, with no `miniquad-voxel` mesher codepath
//! reachable (only its `Chunk`/terrain types, needed to build the
//! identical workload), so its compiled `wasm32-unknown-unknown`
//! binary size reflects that dependency's own code-size contribution.
//! Paired with `wasm_footprint_miniquad.rs` for a same-workload
//! comparison. See `docs/performance-evidence/` for the measured
//! sizes. Not built by any core/production/CI path.

use block_mesh::UnitQuadBuffer;
use voxel_comparison::{block_mesh_quad_count, build_padded_array, run_block_mesh, workload_chunk};

fn main() {
    let chunk = workload_chunk();
    let padded = build_padded_array(&chunk);
    let mut out = UnitQuadBuffer::new();
    run_block_mesh(&padded, &mut out);
    println!("quads: {}", block_mesh_quad_count(&out));
}
