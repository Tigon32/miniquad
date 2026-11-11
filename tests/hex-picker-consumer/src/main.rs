use miniquad_voxel::camera::OrbitCamera;
use miniquad_voxel::chunk::{Chunk, ChunkDims};
use miniquad_voxel::hex::{build_hex_chunk_mesh, HexCell, HexFace};
use miniquad_voxel::hex_pick::{hex_cell_at_xz, pick_hex, ray_from_pixel, HexPickParams, HexRay};
use miniquad_voxel::math::Vec3;
use miniquad_voxel::mesh::MeshBuffers;
use miniquad_voxel::terrain::PALETTE;
use miniquad_voxel::world::World;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dims = ChunkDims::new(4, 4, 4);
    let cell = HexCell::new(-1, -1, 1)?;
    let (coord, local) = cell.to_chunk_local(dims)?;
    let mut chunk = Chunk::new(dims)?;
    chunk.set(local[0], local[1], local[2], 1)?;
    let mut world = World::new(dims, 1)?;
    world.insert(coord, chunk)?;
    let mut mesh = MeshBuffers::new();
    build_hex_chunk_mesh(&world, coord, &PALETTE, &mut mesh)?;
    assert_eq!((mesh.vertices.len(), mesh.indices.len()), (36, 60));

    let center = cell.center();
    assert_eq!(hex_cell_at_xz(center[0] as f64, center[2] as f64, 1)?, cell);
    let ray = HexRay {
        origin: [center[0] as f64, 5.0, center[2] as f64],
        dir: [0.0, -1.0, 0.0],
    };
    let params = HexPickParams {
        max_distance: 10.0,
        max_steps: 20,
        min_layer: 0,
        max_layer: 3,
    };
    let hit = pick_hex(&world, &ray, &params)?.expect("ray must reach the isolated prism");
    assert_eq!(hit.cell, cell);
    assert_eq!(hit.face, Some(HexFace::Top));
    assert_eq!(hit.distance, 3.0);
    assert_eq!(
        pick_hex(
            &world,
            &ray,
            &HexPickParams {
                max_distance: 1.0,
                ..params
            }
        )?,
        None
    );

    let camera = OrbitCamera::new(Vec3::new(center[0], center[1], center[2]), 10.0, 0.4, 0.3);
    let ray = ray_from_pixel(&camera, [320.0, 180.0], [640.0, 360.0])?;
    let hit = pick_hex(&world, &ray, &params)?.expect("center ray must reach the prism");
    assert_eq!(hit.cell, cell);
    Ok(())
}
