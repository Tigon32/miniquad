//! Native (non-browser) measurement helper for issue #131's required
//! "cubic vs hex" measurement condition.
//!
//! This binary builds the same equal-cell, two-chunk inputs for the
//! cubic and hex mesh paths, using the same public library calls,
//! `WORLD_SEED`, `ChunkDims`, and resident `ChunkCoord`s. The default
//! cubic example remains 8x12x8; its private measurement build enables
//! `measurement-equal-cells` to match the hex example's 8x4x8 inputs.
//! See the "Mirrors" doc comments on the `*_once` functions below.
//!
//! Mesh building is deterministic (seeded) and pure Rust, so it needs
//! no WASM, no browser, and no GPU: this gives an EXACT (not
//! estimated) vertex/index count and a real, repeatable native build-
//! time measurement. The helper also asserts equal grid capacity and
//! solid-cell count before it reports mesh statistics.
//!
//! This native build time is NOT a substitute for an in-browser/WASM
//! build-time measurement: neither example exports a build-time probe,
//! so no in-browser mesh-build-time claim is made for either scene.
//! The browser side of the comparison (frame-interval p95/p99, gzip
//! bytes) is measured separately, for real, by
//! `experiments/hex-browser/tests/cubic-vs-hex-measurement.spec.mjs`.
//!
//! Run with: `cargo run --release --example measure_mesh`. Prints one
//! JSON object to stdout.

use std::time::{Duration, Instant};

use miniquad_voxel::chunk::{Chunk, ChunkDims};
use miniquad_voxel::hex::build_hex_chunk_mesh;
use miniquad_voxel::mesh::{build_chunk_mesh, MeshBuffers};
use miniquad_voxel::terrain::{generate_chunk, PALETTE};
use miniquad_voxel::world::{ChunkCoord, World};

/// Number of paired/alternating measurement runs per scene, matching
/// the task's required sample size.
const RUNS: usize = 20;

/// One (vertex_count, index_count, build duration) result.
struct MeshStats {
    grid_cell_capacity: usize,
    solid_cells: usize,
    vertices: usize,
    indices: usize,
    duration: Duration,
}

/// Mirrors the cubic `offline.rs` world and mesh build with the
/// `measurement-equal-cells` feature: same seed, dimensions (8x4x8),
/// chunk coordinates `(-1,0,0)` and `(0,0,0)`, and palette as the hex
/// example. Combining the per-chunk meshes only offsets vertex X
/// positions and rebases indices, so summing their counts gives the
/// exact combined count uploaded by the example.
fn cubic_once() -> MeshStats {
    const WORLD_SEED: u32 = 20261111;
    const CHUNK_DIMS: ChunkDims = ChunkDims::new(8, 4, 8);
    const MAX_RESIDENT_CHUNKS: usize = 4;
    const RESIDENT_CHUNKS: [ChunkCoord; 2] = [ChunkCoord::new(-1, 0, 0), ChunkCoord::new(0, 0, 0)];

    let start = Instant::now();
    let mut world = World::new(CHUNK_DIMS, MAX_RESIDENT_CHUNKS)
        .expect("fixed demo world configuration is valid");
    let mut solid_cells = 0;
    for coord in RESIDENT_CHUNKS {
        let chunk = generate_chunk(
            WORLD_SEED,
            CHUNK_DIMS,
            coord.x * CHUNK_DIMS.x as i32,
            coord.z * CHUNK_DIMS.z as i32,
        )
        .expect("fixed demo chunk dimensions are within bounds");
        solid_cells += count_solid_cells(&chunk);
        world.insert(coord, chunk).expect("world has room");
    }

    let mut mesh_a = MeshBuffers::new();
    build_chunk_mesh(&world, RESIDENT_CHUNKS[0], &PALETTE, &mut mesh_a)
        .expect("chunk a is resident");
    let mut mesh_b = MeshBuffers::new();
    build_chunk_mesh(&world, RESIDENT_CHUNKS[1], &PALETTE, &mut mesh_b)
        .expect("chunk b is resident");
    let duration = start.elapsed();

    MeshStats {
        grid_cell_capacity: CHUNK_DIMS.volume().expect("fixed dimensions have a volume") as usize
            * RESIDENT_CHUNKS.len(),
        solid_cells,
        vertices: mesh_a.vertices.len() + mesh_b.vertices.len(),
        indices: mesh_a.indices.len() + mesh_b.indices.len(),
        duration,
    }
}

/// Mirrors `offline_hex.rs`'s world and mesh build: same seed,
/// dimensions (8x4x8), chunk coordinates `(-1,0,0)` and `(0,0,0)`,
/// and palette. The generated voxel IDs match `cubic_once`; only the
/// mesh topology differs.
fn hex_once() -> MeshStats {
    const WORLD_SEED: u32 = 20261111;
    const CHUNK_DIMS: ChunkDims = ChunkDims::new(8, 4, 8);
    const MAX_RESIDENT_CHUNKS: usize = 4;
    const RESIDENT_CHUNKS: [ChunkCoord; 2] = [ChunkCoord::new(-1, 0, 0), ChunkCoord::new(0, 0, 0)];

    let start = Instant::now();
    let mut world = World::new(CHUNK_DIMS, MAX_RESIDENT_CHUNKS)
        .expect("fixed demo world configuration is valid");
    let mut solid_cells = 0;
    for coord in RESIDENT_CHUNKS {
        let chunk = generate_chunk(
            WORLD_SEED,
            CHUNK_DIMS,
            coord.x * CHUNK_DIMS.x as i32,
            coord.z * CHUNK_DIMS.z as i32,
        )
        .expect("fixed demo chunk dimensions are within bounds");
        solid_cells += count_solid_cells(&chunk);
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
        grid_cell_capacity: CHUNK_DIMS.volume().expect("fixed dimensions have a volume") as usize
            * RESIDENT_CHUNKS.len(),
        solid_cells,
        vertices,
        indices,
        duration,
    }
}

fn count_solid_cells(chunk: &Chunk) -> usize {
    let dims = chunk.dims();
    let mut count = 0;
    for x in 0..dims.x {
        for y in 0..dims.y {
            for z in 0..dims.z {
                count += usize::from(chunk.is_solid(x, y, z));
            }
        }
    }
    count
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
    let mut grid_cell_capacities: Vec<usize> = stats.iter().map(|s| s.grid_cell_capacity).collect();
    grid_cell_capacities.dedup();
    let mut solid_cell_counts: Vec<usize> = stats.iter().map(|s| s.solid_cells).collect();
    solid_cell_counts.dedup();
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
    assert_eq!(
        grid_cell_capacities.len(),
        1,
        "{name}: grid capacity must be identical across all {} runs, got {:?}",
        stats.len(),
        grid_cell_capacities
    );
    assert_eq!(
        solid_cell_counts.len(),
        1,
        "{name}: solid-cell count must be identical across all {} runs, got {:?}",
        stats.len(),
        solid_cell_counts
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
            "    \"gridCellCapacity\": {grid_cells},\n",
            "    \"solidCells\": {solid_cells},\n",
            "    \"vertices\": {vertices},\n",
            "    \"indices\": {indices},\n",
            "    \"runCount\": {run_count},\n",
            "    \"buildTimeNs\": {{ \"min\": {min_ns}, \"mean\": {mean_ns}, \"p95\": {p95_ns}, \"p99\": {p99_ns}, \"max\": {max_ns} }}\n",
            "  }}"
        ),
        name = name,
        grid_cells = grid_cell_capacities[0],
        solid_cells = solid_cell_counts[0],
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
    assert_eq!(
        cubic_stats[0].grid_cell_capacity, hex_stats[0].grid_cell_capacity,
        "cubic and hex measurement inputs must have equal grid capacity"
    );
    assert_eq!(
        cubic_stats[0].solid_cells, hex_stats[0].solid_cells,
        "cubic and hex measurement inputs must have equal solid-cell counts"
    );

    println!("{{");
    println!("{},", summarize("cubic", &cubic_stats));
    println!("{}", summarize("hex", &hex_stats));
    println!("}}");
}
