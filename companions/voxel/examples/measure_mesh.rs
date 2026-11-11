//! Native (non-browser) measurement helper for issue #131's required
//! "cubic vs hex" measurement condition.
//!
//! This binary builds EXACTLY the same two-chunk world and visible-
//! face mesh each offline example's `Stage::new` builds, using the
//! same public library calls and, for each scene, the matching
//! `WORLD_SEED`, `ChunkDims`, and resident `ChunkCoord`s. The two
//! scenes use different dimensions. See the "Mirrors" doc comment on
//! each `*_once` function below for source line references. It does
//! not import, run, or change `offline.rs` (the cubic example, which
//! the issue requires to stay unchanged) or `offline_hex.rs`: it is a
//! separate, read-only reproduction of their mesh-build math, in this
//! companion crate only.
//!
//! Mesh building is deterministic (seeded) and pure Rust, so it needs
//! no WASM, no browser, and no GPU: this gives an EXACT (not
//! estimated) vertex/index count and a real, repeatable native build-
//! time measurement. The loop is identical on this host, but the
//! example dimensions and cell counts differ, so this is not an
//! equal-workload performance comparison.
//!
//! This native build time is NOT a substitute for an in-browser/WASM
//! build-time measurement: neither example exports a build-time probe
//! (adding one to the cubic example is not allowed; the issue requires
//! it to stay unchanged), so no in-browser mesh-build-time claim is
//! made for either scene. The browser side of the comparison (frame-
//! interval p95/p99, gzip bytes) is measured separately, for real, by
//! `experiments/hex-browser/tests/cubic-vs-hex-measurement.spec.mjs`.
//!
//! Run with: `cargo run --release --example measure_mesh`. Prints one
//! JSON object to stdout.

use std::time::{Duration, Instant};

use miniquad_voxel::chunk::ChunkDims;
use miniquad_voxel::hex::build_hex_chunk_mesh;
use miniquad_voxel::mesh::{build_chunk_mesh, MeshBuffers};
use miniquad_voxel::terrain::{generate_chunk, PALETTE};
use miniquad_voxel::world::{ChunkCoord, World};

/// Number of paired/alternating measurement runs per scene, matching
/// the task's required sample size.
const RUNS: usize = 20;

/// One (vertex_count, index_count, build duration) result.
struct MeshStats {
    vertices: usize,
    indices: usize,
    duration: Duration,
}

/// Mirrors the cubic world/mesh build in `offline.rs` `Stage::new`
/// (companions/voxel/examples/offline.rs lines 144-162): same
/// `WORLD_SEED` (20261111), same `CHUNK_DIMS` (8x12x8), same two
/// `ChunkCoord`s `(0,0,0)` and `(1,0,0)`, same `PALETTE`. Combining
/// the two per-chunk meshes only offsets vertex X positions and
/// rebases indices (`append_mesh`); it changes neither the vertex nor
/// the index COUNT, so summing the two per-chunk counts here gives the
/// exact combined count `offline.rs` uploads, without reimplementing
/// its GPU buffer code.
fn cubic_once() -> MeshStats {
    const WORLD_SEED: u32 = 20261111;
    const CHUNK_DIMS: ChunkDims = ChunkDims::new(8, 12, 8);
    const MAX_RESIDENT_CHUNKS: usize = 4;

    let start = Instant::now();
    let mut world = World::new(CHUNK_DIMS, MAX_RESIDENT_CHUNKS)
        .expect("fixed demo world configuration is valid");
    let coord_a = ChunkCoord::new(0, 0, 0);
    let coord_b = ChunkCoord::new(1, 0, 0);
    let chunk_a = generate_chunk(WORLD_SEED, CHUNK_DIMS, 0, 0)
        .expect("fixed demo chunk dimensions are within bounds");
    let chunk_b = generate_chunk(WORLD_SEED, CHUNK_DIMS, CHUNK_DIMS.x as i32, 0)
        .expect("fixed demo chunk dimensions are within bounds");
    world.insert(coord_a, chunk_a).expect("world has room");
    world.insert(coord_b, chunk_b).expect("world has room");

    let mut mesh_a = MeshBuffers::new();
    build_chunk_mesh(&world, coord_a, &PALETTE, &mut mesh_a).expect("chunk a is resident");
    let mut mesh_b = MeshBuffers::new();
    build_chunk_mesh(&world, coord_b, &PALETTE, &mut mesh_b).expect("chunk b is resident");
    let duration = start.elapsed();

    MeshStats {
        vertices: mesh_a.vertices.len() + mesh_b.vertices.len(),
        indices: mesh_a.indices.len() + mesh_b.indices.len(),
        duration,
    }
}

/// Mirrors the hex world/mesh build in `offline_hex.rs`'s
/// `build_world`/`build_combined_mesh` (companions/voxel/examples/
/// offline_hex.rs lines 46-53, 316-355): same `WORLD_SEED` (20261111),
/// same `CHUNK_DIMS` (8x4x8), same two `ChunkCoord`s `(-1,0,0)` and
/// `(0,0,0)`, same `PALETTE`. As in `cubic_once`, combining only
/// offsets/rebases, so summing per-chunk counts gives the exact
/// combined count.
fn hex_once() -> MeshStats {
    const WORLD_SEED: u32 = 20261111;
    const CHUNK_DIMS: ChunkDims = ChunkDims::new(8, 4, 8);
    const MAX_RESIDENT_CHUNKS: usize = 4;
    const RESIDENT_CHUNKS: [ChunkCoord; 2] = [ChunkCoord::new(-1, 0, 0), ChunkCoord::new(0, 0, 0)];

    let start = Instant::now();
    let mut world = World::new(CHUNK_DIMS, MAX_RESIDENT_CHUNKS)
        .expect("fixed demo world configuration is valid");
    for coord in RESIDENT_CHUNKS {
        let chunk = generate_chunk(
            WORLD_SEED,
            CHUNK_DIMS,
            coord.x * CHUNK_DIMS.x as i32,
            coord.z * CHUNK_DIMS.z as i32,
        )
        .expect("fixed demo chunk dimensions are within bounds");
        world.insert(coord, chunk).expect("world has room");
    }

    let mut vertices = 0usize;
    let mut indices = 0usize;
    let mut per_chunk = MeshBuffers::new();
    for coord in RESIDENT_CHUNKS {
        build_hex_chunk_mesh(&world, coord, &PALETTE, &mut per_chunk).expect("chunk is resident");
        vertices += per_chunk.vertices.len();
        indices += per_chunk.indices.len();
    }
    let duration = start.elapsed();

    MeshStats {
        vertices,
        indices,
        duration,
    }
}

fn percentile(sorted_ns: &[u128], p: f64) -> u128 {
    let index = ((sorted_ns.len() as f64 - 1.0) * p).round() as usize;
    sorted_ns[index.min(sorted_ns.len() - 1)]
}

fn summarize(name: &str, stats: &[MeshStats]) -> String {
    let mut vertex_counts: Vec<usize> = stats.iter().map(|s| s.vertices).collect();
    vertex_counts.dedup();
    let mut index_counts: Vec<usize> = stats.iter().map(|s| s.indices).collect();
    index_counts.dedup();
    assert_eq!(
        vertex_counts.len(),
        1,
        "{name}: vertex count must be identical (deterministic, seeded) across all {} runs, got {:?}",
        stats.len(),
        vertex_counts
    );
    assert_eq!(
        index_counts.len(),
        1,
        "{name}: index count must be identical (deterministic, seeded) across all {} runs, got {:?}",
        stats.len(),
        index_counts
    );

    let mut durations_ns: Vec<u128> = stats.iter().map(|s| s.duration.as_nanos()).collect();
    durations_ns.sort_unstable();
    let min_ns = *durations_ns.first().unwrap();
    let max_ns = *durations_ns.last().unwrap();
    let mean_ns = (durations_ns.iter().sum::<u128>()) / durations_ns.len() as u128;
    let p95_ns = percentile(&durations_ns, 0.95);
    let p99_ns = percentile(&durations_ns, 0.99);

    format!(
        concat!(
            "  \"{name}\": {{\n",
            "    \"vertices\": {vertices},\n",
            "    \"indices\": {indices},\n",
            "    \"runCount\": {run_count},\n",
            "    \"buildTimeNs\": {{ \"min\": {min_ns}, \"mean\": {mean_ns}, \"p95\": {p95_ns}, \"p99\": {p99_ns}, \"max\": {max_ns} }}\n",
            "  }}"
        ),
        name = name,
        vertices = vertex_counts[0],
        indices = index_counts[0],
        run_count = stats.len(),
        min_ns = min_ns,
        mean_ns = mean_ns,
        p95_ns = p95_ns,
        p99_ns = p99_ns,
        max_ns = max_ns
    )
}

fn main() {
    let mut cubic_stats = Vec::with_capacity(RUNS);
    let mut hex_stats = Vec::with_capacity(RUNS);

    // Alternate scene order every run (cubic, hex, cubic, hex, ...) so
    // neither scene systematically goes first/warms the allocator
    // first.
    for i in 0..RUNS {
        if i % 2 == 0 {
            cubic_stats.push(cubic_once());
            hex_stats.push(hex_once());
        } else {
            hex_stats.push(hex_once());
            cubic_stats.push(cubic_once());
        }
    }

    println!("{{");
    println!("{},", summarize("cubic", &cubic_stats));
    println!("{}", summarize("hex", &hex_stats));
    println!("}}");
}
