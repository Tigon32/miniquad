//! Fresh downstream consumer for issue #131's public contract.
//!
//! This crate depends on `miniquad-voxel` only by path (see
//! `Cargo.toml`) and uses only the public `hex` and `hex_pick` items
//! (plus `World`/`ChunkDims`/`ChunkCoord`, part of the existing cubic
//! public surface that `hex` reuses unchanged). No source from
//! `miniquad-voxel` is copied here. It proves the hexagonal-prism
//! geometry/picker API is consumable from outside the Miniquad tree,
//! and builds for both native and `wasm32-unknown-unknown`.

use miniquad_voxel::camera::OrbitCamera;
use miniquad_voxel::chunk::ChunkDims;
use miniquad_voxel::hex::{build_hex_chunk_mesh, HexCell, HEX_LAYER_HEIGHT};
use miniquad_voxel::hex_pick::{hex_cell_at_xz, pick_hex, ray_from_pixel, HexPickParams};
use miniquad_voxel::math::Vec3;
use miniquad_voxel::mesh::MeshBuffers;
use miniquad_voxel::terrain::{self, PALETTE};
use miniquad_voxel::world::{ChunkCoord, World};

fn build_demo_world() -> World {
    let dims = ChunkDims::new(8, 4, 8);
    let mut world = World::new(dims, 4).expect("non-zero resident-chunk bound");
    for (cq, cr) in [(-1i32, 0i32), (0i32, 0i32)] {
        let coord = ChunkCoord::new(cq, 0, cr);
        let chunk = terrain::generate_chunk(20261111, dims, cq * dims.x as i32, cr * dims.z as i32)
            .expect("fixed demo seed/dims stay within bound");
        world
            .insert(coord, chunk)
            .expect("two resident chunks stay within the bound");
    }
    world
}

fn main() {
    let world = build_demo_world();

    // Use the public hex mesher on one resident chunk.
    let mut buffers = MeshBuffers::new();
    build_hex_chunk_mesh(&world, ChunkCoord::new(0, 0, 0), &PALETTE, &mut buffers)
        .expect("demo chunk/material/color data stay within the mesher's bound");
    println!(
        "built {} hex vertices / {} indices for chunk (0,0,0)",
        buffers.vertices.len(),
        buffers.indices.len()
    );

    // Use the public analytic picker from an orbit camera aimed at
    // the scene, matching the offline_hex example's start values.
    let camera = OrbitCamera::new(Vec3::new(0.0, 1.5, 0.0), 14.0, 0.6, 0.5);
    let viewport = [640.0_f64, 360.0_f64];
    let pixel = [viewport[0] / 2.0, viewport[1] / 2.0];
    let ray = ray_from_pixel(&camera, pixel, viewport).expect("center pixel is a valid input");
    let params = HexPickParams {
        max_distance: 64.0,
        max_steps: 4_096,
        min_layer: 0,
        max_layer: 3,
    };
    match pick_hex(&world, &ray, &params) {
        Ok(Some(hit)) => println!(
            "picked q={} r={} layer={} distance={:.3}",
            hit.cell.q(),
            hit.cell.r(),
            hit.cell.layer(),
            hit.distance
        ),
        Ok(None) => println!("no cell under the center ray"),
        Err(error) => println!("picker rejected the input: {error}"),
    }

    // Use the public point-to-cell lookup directly (same contract
    // the example's "place column" control relies on).
    match hex_cell_at_xz(0.0, 0.0, 0) {
        Ok(cell) => println!(
            "cell at world origin: q={} r={} (layer height {})",
            cell.q(),
            cell.r(),
            HEX_LAYER_HEIGHT
        ),
        Err(error) => println!("origin lookup rejected: {error}"),
    }

    let _ = HexCell::new(0, 0, 0);
}
