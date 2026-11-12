//! Benchmark-only comparison binary for issue #29's pinned
//! `block-mesh` evidence requirement. Not built by core/production
//! CI; run manually and its output copied into
//! `docs/performance-evidence/`.
//!
//! Runs both meshers repeatedly on the identical, equivalently
//! isolated workload chunk (`voxel_comparison::workload_chunk`),
//! reports wall-clock timing spread (mean/min/max/stddev) over a
//! fixed repetition count, plus output mesh size in bytes and a
//! deterministic hash, so a reader can check "same input, same
//! output, fair timing" rather than trust a bare number.

use std::time::Instant;

use voxel_comparison::{
    block_mesh_quad_count, build_padded_array, hash_miniquad_voxel_mesh, miniquad_voxel_quad_count,
    run_block_mesh, run_miniquad_voxel_mesher, workload_chunk,
};

use block_mesh::UnitQuadBuffer;
use miniquad_voxel::mesh::MeshBuffers;

const REPETITIONS: usize = 200;
const WARMUP: usize = 20;

struct Stats {
    mean_us: f64,
    min_us: f64,
    max_us: f64,
    stddev_us: f64,
}

fn stats(samples_us: &[f64]) -> Stats {
    let n = samples_us.len() as f64;
    let mean = samples_us.iter().sum::<f64>() / n;
    let min = samples_us.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = samples_us.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let variance = samples_us.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
    Stats { mean_us: mean, min_us: min, max_us: max, stddev_us: variance.sqrt() }
}

fn main() {
    let chunk = workload_chunk();
    let padded = build_padded_array(&chunk);

    // Warm up both sides (allocator/cache warmup) before timed runs,
    // so the first sample isn't penalized relative to the rest - a
    // shared-load uncertainty mitigation, not a correctness
    // requirement.
    for _ in 0..WARMUP {
        let mut mq_out = MeshBuffers::new();
        run_miniquad_voxel_mesher(&chunk, &mut mq_out);
        let mut bm_out = UnitQuadBuffer::new();
        run_block_mesh(&padded, &mut bm_out);
    }

    let mut mq_samples = Vec::with_capacity(REPETITIONS * 2);
    let mut mq_out = MeshBuffers::new();
    let mut mq_quads = 0usize;
    let mut mq_hash = 0u64;
    let mut mq_bytes = 0usize;
    for _ in 0..REPETITIONS {
        let start = Instant::now();
        run_miniquad_voxel_mesher(&chunk, &mut mq_out);
        mq_samples.push(start.elapsed().as_secs_f64() * 1e6);
        mq_quads = miniquad_voxel_quad_count(&mq_out);
        mq_hash = hash_miniquad_voxel_mesh(&mq_out);
        mq_bytes = std::mem::size_of_val(mq_out.vertices.as_slice())
            + std::mem::size_of_val(mq_out.indices.as_slice());
    }

    let mut bm_samples = Vec::with_capacity(REPETITIONS);
    let mut bm_out = UnitQuadBuffer::new();
    let mut bm_quads = 0usize;
    for _ in 0..REPETITIONS {
        let start = Instant::now();
        run_block_mesh(&padded, &mut bm_out);
        bm_samples.push(start.elapsed().as_secs_f64() * 1e6);
        bm_quads = block_mesh_quad_count(&bm_out);
    }
    // Interleave a second pass so neither mesher gets all of a single
    // warm/cold CPU-cache period to itself (shared-load uncertainty:
    // alternating halves the chance one side is unfairly favored by
    // whatever else is running on this shared machine).
    for _ in 0..REPETITIONS {
        let start = Instant::now();
        run_miniquad_voxel_mesher(&chunk, &mut mq_out);
        mq_samples.push(start.elapsed().as_secs_f64() * 1e6);
    }

    let mq_stats = stats(&mq_samples);
    let bm_stats = stats(&bm_samples);

    println!("voxel-comparison: pinned block-mesh = 0.2.0 (MIT OR Apache-2.0)");
    println!("workload: one SCENE_CHUNK_DIMS chunk (8x12x8 = 768 voxels), SCENE_SEED terrain, origin (0,0), no neighbor chunk");
    println!();
    println!("miniquad-voxel build_chunk_mesh:");
    println!("  repetitions: {}", mq_samples.len());
    println!(
        "  time (us): mean={:.2} min={:.2} max={:.2} stddev={:.2}",
        mq_stats.mean_us, mq_stats.min_us, mq_stats.max_us, mq_stats.stddev_us
    );
    println!("  quads: {}", mq_quads);
    println!("  mesh bytes (vertices+indices heap payload): {}", mq_bytes);
    println!("  mesh hash (FNV-1a over positions/normals/colors): 0x{:016x}", mq_hash);
    println!();
    println!("block-mesh visible_block_faces:");
    println!("  repetitions: {}", bm_samples.len());
    println!(
        "  time (us): mean={:.2} min={:.2} max={:.2} stddev={:.2}",
        bm_stats.mean_us, bm_stats.min_us, bm_stats.max_us, bm_stats.stddev_us
    );
    println!("  quads: {}", bm_quads);
    println!();
    if mq_quads == bm_quads {
        println!("correctness: quad counts match ({mq_quads} == {bm_quads}).");
    } else {
        println!(
            "correctness: MISMATCH ({mq_quads} != {bm_quads}) - do not report a \
             performance claim until this is resolved."
        );
        std::process::exit(1);
    }
}
