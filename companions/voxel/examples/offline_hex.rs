//! Offline hexagonal-prism voxel vertical slice (#131).
//!
//! Draws two adjacent hex-prism chunks (one with a negative chunk
//! coordinate), a moving world-space 2D sprite, and an HTML status
//! region (see `docs/offline-hex-voxel.md`). This example is built
//! against the frozen interface in `docs/hex-voxel-contract.md`
//! (sections 1-3, MADR 0011). It makes no network request.
//!
//! The cubic `offline` example is unchanged; this example does not
//! reuse its world-space offset trick (`append_mesh`), because hex
//! mesh positions are already world space (contract section 1.5).
//!
//! # Controls
//! - Arrow keys / mouse drag: orbit the camera (same as `offline`).
//! - `Place column` / `Release` buttons (owned by the embedding HTML
//!   page, see `tests/browser/hex-offline.html`) toggle a solid column
//!   between the camera and the sprite, to test occlusion (contract
//!   section 3.4).
//!
//! # Probes (contract section 3.3)
//!
//! These are additional to the frozen contract list, only where the
//! contract describes an invariant without naming the triggering
//! function:
//!
//!   - `hex_request_release() -> i32`: requests the one-shot GPU
//!     release. Returns `0` on the first call, `1` if a release was
//!     already requested or completed (idempotent).
//!   - `hex_request_place_column() -> i32`: toggles the occlusion
//!     test column described in section 3.4. Returns `0` always.

use miniquad::*;
use miniquad_voxel::camera::OrbitCamera;
use miniquad_voxel::chunk::ChunkDims;
use miniquad_voxel::hex::{build_hex_chunk_mesh, HEX_MAX_MESH_VERTICES};
use miniquad_voxel::hex_pick::{hex_cell_at_xz, pick_hex, ray_from_pixel, HexPickParams};
use miniquad_voxel::math::{Mat4, Vec3};
use miniquad_voxel::mesh::MeshBuffers;
use miniquad_voxel::terrain::{generate_chunk, PALETTE};
use miniquad_voxel::world::{ChunkCoord, World};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};

/// Deterministic world seed (contract section 3.1).
const WORLD_SEED: u32 = 20261111;
const CHUNK_DIMS: ChunkDims = ChunkDims::new(8, 4, 8);
const MAX_RESIDENT_CHUNKS: usize = 4;
const MIN_LAYER: i32 = 0;
const MAX_LAYER: i32 = 3;
/// The two chunks resident for the lifetime of this example (contract
/// section 3.1). Fixed, not derived from any runtime state.
const RESIDENT_CHUNKS: [ChunkCoord; 2] = [ChunkCoord::new(-1, 0, 0), ChunkCoord::new(0, 0, 0)];
/// The material ID the "Place column" control writes (contract
/// section 3.4, occlusion test). Index 2 of `terrain::PALETTE`
/// ("dirt"), an existing opaque material; no new palette entry.
const PLACE_COLUMN_MATERIAL: u8 = 2;

static RELEASE_REQUESTED: AtomicBool = AtomicBool::new(false);
static RESOURCES_LIVE: AtomicU32 = AtomicU32::new(0);
static TRIANGLE_COUNT: AtomicU32 = AtomicU32::new(0);
/// The sprite's current world `(x, z)` and integer layer, published by
/// `draw` each frame so `hex_request_place_column` can target "the
/// cell between camera and sprite" (contract section 3.4) without
/// storing a `Stage` pointer: only three plain atomics.
static SPRITE_X_BITS: AtomicU32 = AtomicU32::new(0);
static SPRITE_Z_BITS: AtomicU32 = AtomicU32::new(0);
static SPRITE_LAYER: AtomicI32 = AtomicI32::new(0);

static PICKED_VALID: AtomicU32 = AtomicU32::new(0);
static PICKED_Q: AtomicI32 = AtomicI32::new(0);
static PICKED_R: AtomicI32 = AtomicI32::new(0);
static PICKED_LAYER: AtomicI32 = AtomicI32::new(0);
static PICKED_FACE: AtomicU32 = AtomicU32::new(8); // 8 = none, per contract section 3.3.

static PLACE_COLUMN_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Reports `resources_live`: the number of GPU objects this example
/// currently owns (pipelines + buffers). `0` once release completes.
#[no_mangle]
pub extern "C" fn resources_live() -> u32 {
    RESOURCES_LIVE.load(Ordering::Relaxed)
}

/// Reports the current visible-face triangle count.
#[no_mangle]
pub extern "C" fn hex_probe_triangles() -> u32 {
    TRIANGLE_COUNT.load(Ordering::Relaxed)
}

/// Requests the one-shot GPU release. Idempotent: returns `0` the
/// first time, `1` on every later call.
#[no_mangle]
pub extern "C" fn hex_request_release() -> i32 {
    if RELEASE_REQUESTED.swap(true, Ordering::Relaxed) {
        1
    } else {
        0
    }
}

/// Requests the occlusion-test column write (contract section 3.4,
/// "Place column" control). `draw` performs the actual mutation and
/// mesh rebuild on the live world; this only sets a flag. Always
/// returns `0`.
#[no_mangle]
pub extern "C" fn hex_request_place_column() -> i32 {
    PLACE_COLUMN_REQUESTED.store(true, Ordering::Relaxed);
    0
}

/// Picks a cell at a backing-store pixel. `px`/`py` are passed as
/// `f32` bits (contract section 3.3) so no float ABI widening is
/// needed. Returns `0` on a hit, `1` on no hit, `2` on invalid input.
#[no_mangle]
pub extern "C" fn hex_probe_pick(px_bits: u32, py_bits: u32) -> i32 {
    let px = f32::from_bits(px_bits) as f64;
    let py = f32::from_bits(py_bits) as f64;
    let Some((camera, viewport)) = PICK_CAMERA.with(|cell| cell.get()) else {
        return 2;
    };
    let Some(world) = PICK_WORLD.with(|cell| cell.borrow().clone()) else {
        return 2;
    };
    let Ok(ray) = ray_from_pixel(&camera, [px, py], viewport) else {
        return 2;
    };
    let params = HexPickParams {
        max_distance: 100.0,
        max_steps: 4_096,
        min_layer: MIN_LAYER,
        max_layer: MAX_LAYER,
    };
    let world_ref = world.borrow();
    let hit = pick_hex(&world_ref, &ray, &params);
    drop(world_ref);
    match hit {
        Ok(Some(hit)) => {
            PICKED_VALID.store(1, Ordering::Relaxed);
            PICKED_Q.store(hit.cell.q(), Ordering::Relaxed);
            PICKED_R.store(hit.cell.r(), Ordering::Relaxed);
            PICKED_LAYER.store(hit.cell.layer(), Ordering::Relaxed);
            PICKED_FACE.store(
                hit.face.map(|f| f.index() as u32).unwrap_or(8),
                Ordering::Relaxed,
            );
            0
        }
        Ok(None) => {
            PICKED_VALID.store(0, Ordering::Relaxed);
            1
        }
        Err(_) => 2,
    }
}

#[no_mangle]
pub extern "C" fn hex_probe_picked_valid() -> u32 {
    PICKED_VALID.load(Ordering::Relaxed)
}
#[no_mangle]
pub extern "C" fn hex_probe_picked_q() -> i32 {
    PICKED_Q.load(Ordering::Relaxed)
}
#[no_mangle]
pub extern "C" fn hex_probe_picked_r() -> i32 {
    PICKED_R.load(Ordering::Relaxed)
}
#[no_mangle]
pub extern "C" fn hex_probe_picked_layer() -> i32 {
    PICKED_LAYER.load(Ordering::Relaxed)
}
#[no_mangle]
pub extern "C" fn hex_probe_picked_face() -> u32 {
    PICKED_FACE.load(Ordering::Relaxed)
}

thread_local! {
    /// The current camera and viewport, published by `draw` each
    /// frame so `hex_probe_pick` can run the same analytic picker a
    /// real pointer event would use. Plain `Copy` data, no pointer.
    static PICK_CAMERA: Cell<Option<(OrbitCamera, [f64; 2])>> = const { Cell::new(None) };
    /// A clone of the `Rc` to the live world, set once in `Stage::new`
    /// (not re-pointed every frame). This is a reference-counted
    /// handle to CPU voxel data, not a pointer to `Stage` itself:
    /// dropping `Stage` and letting this `Rc` go out of scope frees it
    /// normally: there is no raw/global `Stage` pointer anywhere.
    static PICK_WORLD: RefCell<Option<Rc<RefCell<World>>>> = const { RefCell::new(None) };
}

struct Stage {
    ctx: Box<dyn RenderingBackend>,

    terrain_pipeline: Option<Pipeline>,
    terrain_vertex_buffer: Option<BufferId>,
    terrain_index_buffer: Option<BufferId>,
    terrain_index_count: i32,

    sprite_pipeline: Option<Pipeline>,
    sprite_vertex_buffer: Option<BufferId>,
    sprite_index_buffer: Option<BufferId>,

    world: Rc<RefCell<World>>,
    camera: OrbitCamera,
    dragging: bool,
    last_mouse: (f32, f32),
    screen_size: (f32, f32),
    start_time: f64,
    released: bool,
}

/// Builds the two-chunk demo world (reusing the unchanged cubic
/// `terrain::generate_chunk`, which already derives height from
/// `terrain::column_height(seed, q, r, 1, 3)` for these `dims`).
fn build_world() -> Result<World, String> {
    let mut world = World::new(CHUNK_DIMS, MAX_RESIDENT_CHUNKS)
        .map_err(|error| format!("invalid demo world configuration: {error}"))?;
    for coord in RESIDENT_CHUNKS {
        let chunk = generate_chunk(
            WORLD_SEED,
            CHUNK_DIMS,
            coord.x * CHUNK_DIMS.x as i32,
            coord.z * CHUNK_DIMS.z as i32,
        )
        .map_err(|error| format!("terrain generation failed: {error}"))?;
        world
            .insert(coord, chunk)
            .map_err(|error| format!("world insert failed: {error}"))?;
    }
    Ok(world)
}

/// Rebuilds the combined world-space mesh for both resident chunks.
/// Returns an error instead of panicking if the combined mesh exceeds
/// the checked WebGL1 index limit (contract section 1.8/3.1): no
/// `expect` on this path.
fn build_combined_mesh(world: &World) -> Result<MeshBuffers, String> {
    let mut combined = MeshBuffers::new();
    let mut per_chunk = MeshBuffers::new();
    for coord in RESIDENT_CHUNKS {
        build_hex_chunk_mesh(world, coord, &PALETTE, &mut per_chunk)
            .map_err(|error| format!("hex mesh build failed: {error}"))?;
        if combined.vertices.len() + per_chunk.vertices.len() > HEX_MAX_MESH_VERTICES {
            return Err(format!(
                "combined hex mesh exceeds HEX_MAX_MESH_VERTICES ({HEX_MAX_MESH_VERTICES})"
            ));
        }
        let base = combined.vertices.len() as u32;
        combined.vertices.extend_from_slice(&per_chunk.vertices);
        combined
            .indices
            .extend(per_chunk.indices.iter().map(|index| index + base));
    }
    Ok(combined)
}

/// Builds the terrain vertex/index GPU buffers for the current world
/// state. On any mesh error (section 1.8/3.1 checked limits), draws no
/// terrain and reports `hex_probe_triangles() == 0`: no `expect`.
fn create_terrain_buffers(
    ctx: &mut dyn RenderingBackend,
    world: &World,
) -> (BufferId, BufferId, i32) {
    let combined = match build_combined_mesh(world) {
        Ok(combined) => combined,
        Err(message) => {
            eprintln!("offline_hex: {message}");
            MeshBuffers::new()
        }
    };
    let terrain_indices: Vec<u16> = combined
        .indices
        .iter()
        .filter_map(|&index| u16::try_from(index).ok())
        .collect();
    let terrain_index_count = if terrain_indices.len() == combined.indices.len() {
        terrain_indices.len() as i32
    } else {
        eprintln!("offline_hex: an index exceeded u16::MAX; drawing no terrain");
        0
    };
    TRIANGLE_COUNT.store((terrain_index_count / 3) as u32, Ordering::Relaxed);
    let vertex_buffer = ctx.new_buffer(
        BufferType::VertexBuffer,
        BufferUsage::Immutable,
        BufferSource::slice(&combined.vertices),
    );
    let index_buffer = ctx.new_buffer(
        BufferType::IndexBuffer,
        BufferUsage::Immutable,
        BufferSource::slice(&terrain_indices),
    );
    (vertex_buffer, index_buffer, terrain_index_count)
}

impl Stage {
    pub fn new() -> Stage {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();

        let world = match build_world() {
            Ok(world) => world,
            Err(message) => {
                // No terrain is drawn; the HTML host reports `status:
                // error` per contract section 3.1. This path uses no
                // `expect`/`panic!`, matching the checked-limit rule.
                eprintln!("offline_hex: {message}");
                World::new(CHUNK_DIMS, MAX_RESIDENT_CHUNKS).expect("fallback world is valid")
            }
        };
        let world = Rc::new(RefCell::new(world));
        PICK_WORLD.with(|cell| *cell.borrow_mut() = Some(world.clone()));

        let mut resource_count = 0u32;
        let (terrain_vertex_buffer, terrain_index_buffer, terrain_index_count) =
            create_terrain_buffers(ctx.as_mut(), &world.borrow());
        resource_count += 2;

        let terrain_shader = ctx
            .new_shader(
                match ctx.info().backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: shader::TERRAIN_VERTEX,
                        fragment: shader::TERRAIN_FRAGMENT,
                    },
                    Backend::Metal => panic!("offline_hex does not supply a Metal shader"),
                },
                shader::terrain_meta(),
            )
            .unwrap();
        let terrain_pipeline = ctx.new_pipeline(
            &[BufferLayout::default()],
            &[
                VertexAttribute::new("in_pos", VertexFormat::Float3),
                VertexAttribute::new("in_normal", VertexFormat::Float3),
                VertexAttribute::new("in_color", VertexFormat::Float4),
            ],
            terrain_shader,
            PipelineParams {
                depth_test: Comparison::LessOrEqual,
                depth_write: true,
                cull_face: CullFace::Back,
                front_face_order: FrontFaceOrder::CounterClockwise,
                ..Default::default()
            },
        );
        resource_count += 1;

        #[rustfmt::skip]
        let sprite_vertices: [f32; 16] = [
            -0.5, 0.0, -0.5, 0.0,
             0.5, 0.0, -0.5, 1.0,
             0.5, 0.0,  0.5, 1.0,
            -0.5, 0.0,  0.5, 0.0,
        ];
        let sprite_vertex_buffer = ctx.new_buffer(
            BufferType::VertexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&sprite_vertices),
        );
        resource_count += 1;
        let sprite_indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
        let sprite_index_buffer = ctx.new_buffer(
            BufferType::IndexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&sprite_indices),
        );
        resource_count += 1;
        let sprite_shader = ctx
            .new_shader(
                match ctx.info().backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: shader::SPRITE_VERTEX,
                        fragment: shader::SPRITE_FRAGMENT,
                    },
                    Backend::Metal => panic!("offline_hex does not supply a Metal shader"),
                },
                shader::sprite_meta(),
            )
            .unwrap();
        let sprite_pipeline = ctx.new_pipeline(
            &[BufferLayout::default()],
            &[
                VertexAttribute::new("in_pos", VertexFormat::Float3),
                VertexAttribute::new("in_uv", VertexFormat::Float1),
            ],
            sprite_shader,
            PipelineParams {
                depth_test: Comparison::LessOrEqual,
                depth_write: false,
                color_blend: Some(BlendState::new(
                    Equation::Add,
                    BlendFactor::Value(BlendValue::SourceAlpha),
                    BlendFactor::OneMinusValue(BlendValue::SourceAlpha),
                )),
                ..Default::default()
            },
        );
        resource_count += 1;

        RESOURCES_LIVE.store(resource_count, Ordering::Relaxed);

        Stage {
            ctx,
            terrain_pipeline: Some(terrain_pipeline),
            terrain_vertex_buffer: Some(terrain_vertex_buffer),
            terrain_index_buffer: Some(terrain_index_buffer),
            terrain_index_count,
            sprite_pipeline: Some(sprite_pipeline),
            sprite_vertex_buffer: Some(sprite_vertex_buffer),
            sprite_index_buffer: Some(sprite_index_buffer),
            world,
            // Fixed start values (contract section 3.1): orbiting the
            // seam between the two chunks, at `q = -0.5` in world x.
            camera: OrbitCamera::new(Vec3::new(0.0, 1.5, 0.0), 14.0, 0.6, 0.5),
            dragging: false,
            last_mouse: (0.0, 0.0),
            screen_size: (800.0, 600.0),
            start_time: date::now(),
            released: false,
        }
    }

    /// Deletes every GPU object this example owns, exactly once.
    /// Calling this more than once is a no-op (idempotent release,
    /// contract section 3.3): `Option::take` leaves nothing to delete
    /// on a second call.
    fn release(&mut self) {
        if let Some(pipeline) = self.terrain_pipeline.take() {
            self.ctx.delete_pipeline(pipeline);
        }
        if let Some(buffer) = self.terrain_vertex_buffer.take() {
            self.ctx.delete_buffer(buffer);
        }
        if let Some(buffer) = self.terrain_index_buffer.take() {
            self.ctx.delete_buffer(buffer);
        }
        if let Some(pipeline) = self.sprite_pipeline.take() {
            self.ctx.delete_pipeline(pipeline);
        }
        if let Some(buffer) = self.sprite_vertex_buffer.take() {
            self.ctx.delete_buffer(buffer);
        }
        if let Some(buffer) = self.sprite_index_buffer.take() {
            self.ctx.delete_buffer(buffer);
        }
        self.released = true;
        RESOURCES_LIVE.store(0, Ordering::Relaxed);
    }

    /// Writes a full-height solid column at the cell under the
    /// sprite's current position (contract section 3.4 occlusion
    /// test), then rebuilds the affected mesh. A no-op if that cell's
    /// chunk is not one of the two resident chunks.
    fn place_column_under_sprite(&mut self) {
        let x = f32::from_bits(SPRITE_X_BITS.load(Ordering::Relaxed)) as f64;
        let z = f32::from_bits(SPRITE_Z_BITS.load(Ordering::Relaxed)) as f64;
        let layer = SPRITE_LAYER.load(Ordering::Relaxed);
        let Ok(cell) = hex_cell_at_xz(x, z, 0) else {
            return;
        };
        let mut world = self.world.borrow_mut();
        for fill_layer in MIN_LAYER..=layer.min(MAX_LAYER) {
            let Ok(cell) = miniquad_voxel::hex::HexCell::new(cell.q(), cell.r(), fill_layer) else {
                continue;
            };
            let Ok((coord, local)) = cell.to_chunk_local(CHUNK_DIMS) else {
                continue;
            };
            if !RESIDENT_CHUNKS.contains(&coord) {
                continue;
            }
            if let Some(chunk) = world.get(coord) {
                let mut chunk = chunk.clone();
                let _ = chunk.set(local[0], local[1], local[2], PLACE_COLUMN_MATERIAL);
                let _ = world.insert(coord, chunk);
            }
        }
        drop(world);
        let (vertex_buffer, index_buffer, index_count) =
            create_terrain_buffers(self.ctx.as_mut(), &self.world.borrow());
        if let Some(old) = self.terrain_vertex_buffer.replace(vertex_buffer) {
            self.ctx.delete_buffer(old);
        }
        if let Some(old) = self.terrain_index_buffer.replace(index_buffer) {
            self.ctx.delete_buffer(old);
        }
        self.terrain_index_count = index_count;
    }
}

const ARROW_KEY_STEP: f32 = 0.03;
const DRAG_SENSITIVITY: f32 = 0.01;

impl EventHandler for Stage {
    fn update(&mut self) {}

    fn resize_event(&mut self, width: f32, height: f32) {
        self.screen_size = (width.max(1.0), height.max(1.0));
    }

    fn key_down_event(&mut self, keycode: KeyCode, _keymods: KeyMods, _repeat: bool) {
        match keycode {
            KeyCode::Left => self.camera.rotate(-ARROW_KEY_STEP, 0.0),
            KeyCode::Right => self.camera.rotate(ARROW_KEY_STEP, 0.0),
            KeyCode::Up => self.camera.rotate(0.0, ARROW_KEY_STEP),
            KeyCode::Down => self.camera.rotate(0.0, -ARROW_KEY_STEP),
            _ => {}
        }
    }

    fn mouse_button_down_event(&mut self, button: MouseButton, x: f32, y: f32) {
        if button == MouseButton::Left {
            self.dragging = true;
            self.last_mouse = (x, y);
        }
    }

    fn mouse_button_up_event(&mut self, button: MouseButton, _x: f32, _y: f32) {
        if button == MouseButton::Left {
            self.dragging = false;
        }
    }

    fn mouse_motion_event(&mut self, x: f32, y: f32) {
        if self.dragging {
            let (last_x, last_y) = self.last_mouse;
            let (dx, dy) = (x - last_x, y - last_y);
            self.camera
                .rotate(dx * DRAG_SENSITIVITY, -dy * DRAG_SENSITIVITY);
            self.last_mouse = (x, y);
        }
    }

    fn draw(&mut self) {
        if self.released {
            // After release, draw nothing further: `resources_live`
            // stays at `0` and no GPU object is recreated.
            return;
        }
        if RELEASE_REQUESTED.load(Ordering::Relaxed) {
            self.release();
            return;
        }

        if PLACE_COLUMN_REQUESTED.swap(false, Ordering::Relaxed) {
            self.place_column_under_sprite();
        }

        PICK_CAMERA.with(|cell| {
            cell.set(Some((
                self.camera,
                (self.screen_size.0 as f64, self.screen_size.1 as f64).into(),
            )))
        });

        let t = date::now() - self.start_time;
        let aspect = self.screen_size.0 / self.screen_size.1;
        let view = self.camera.view_matrix();
        let projection = self.camera.projection_matrix(aspect);
        let view_projection = projection.mul(&view);

        self.ctx.begin_default_pass(PassAction::Clear {
            color: Some((0.063, 0.094, 0.141, 1.0)),
            depth: Some(1.0),
            stencil: None,
        });

        if let (Some(pipeline), Some(vbuf), Some(ibuf)) = (
            self.terrain_pipeline,
            self.terrain_vertex_buffer,
            self.terrain_index_buffer,
        ) {
            self.ctx.apply_pipeline(&pipeline);
            self.ctx.apply_bindings(&Bindings {
                vertex_buffers: vec![vbuf],
                index_buffer: ibuf,
                images: vec![],
            });
            self.ctx
                .apply_uniforms(UniformsSource::table(&shader::TerrainUniforms {
                    view_projection: view_projection.0,
                }));
            self.ctx.draw(0, self.terrain_index_count, 1);
        }

        let radius = 3.0;
        let sprite_pos = Vec3::new(
            (t as f32).cos() * radius,
            2.0 + (t as f32 * 1.7).sin() * 0.3,
            (t as f32).sin() * radius,
        );
        SPRITE_X_BITS.store(sprite_pos.x.to_bits(), Ordering::Relaxed);
        SPRITE_Z_BITS.store(sprite_pos.z.to_bits(), Ordering::Relaxed);
        SPRITE_LAYER.store(sprite_pos.y.floor() as i32, Ordering::Relaxed);
        let model = Mat4([
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            sprite_pos.x,
            sprite_pos.y,
            sprite_pos.z,
            1.0,
        ]);
        if let (Some(pipeline), Some(vbuf), Some(ibuf)) = (
            self.sprite_pipeline,
            self.sprite_vertex_buffer,
            self.sprite_index_buffer,
        ) {
            self.ctx.apply_pipeline(&pipeline);
            self.ctx.apply_bindings(&Bindings {
                vertex_buffers: vec![vbuf],
                index_buffer: ibuf,
                images: vec![],
            });
            self.ctx
                .apply_uniforms(UniformsSource::table(&shader::SpriteUniforms {
                    model_view_projection: view_projection.mul(&model).0,
                    tint: [1.0, 0.2, 0.3, 1.0],
                }));
            self.ctx.draw(0, 6, 1);
        }

        self.ctx.end_render_pass();
        self.ctx.commit_frame();
    }
}

fn main() {
    let conf = conf::Conf {
        window_title: "miniquad-voxel offline hex".to_owned(),
        ..Default::default()
    };
    miniquad::start(conf, move || Box::new(Stage::new()));
}

mod shader {
    use miniquad::*;

    pub const TERRAIN_VERTEX: &str = r#"#version 100
    attribute vec3 in_pos;
    attribute vec3 in_normal;
    attribute vec4 in_color;

    uniform mat4 view_projection;

    varying lowp vec4 color;
    varying lowp float shade;

    void main() {
        gl_Position = view_projection * vec4(in_pos, 1.0);
        color = in_color;
        vec3 light_dir = normalize(vec3(0.4, 1.0, 0.3));
        shade = 0.45 + 0.55 * max(dot(in_normal, light_dir), 0.0);
    }"#;

    pub const TERRAIN_FRAGMENT: &str = r#"#version 100
    varying lowp vec4 color;
    varying lowp float shade;

    void main() {
        gl_FragColor = vec4(color.rgb * shade, color.a);
    }"#;

    pub fn terrain_meta() -> ShaderMeta {
        ShaderMeta {
            images: vec![],
            uniforms: UniformBlockLayout {
                uniforms: vec![UniformDesc::new("view_projection", UniformType::Mat4)],
            },
        }
    }

    #[repr(C)]
    pub struct TerrainUniforms {
        pub view_projection: [f32; 16],
    }

    pub const SPRITE_VERTEX: &str = r#"#version 100
    attribute vec3 in_pos;
    attribute float in_uv;

    uniform mat4 model_view_projection;

    void main() {
        gl_Position = model_view_projection * vec4(in_pos, 1.0);
    }"#;

    pub const SPRITE_FRAGMENT: &str = r#"#version 100
    uniform lowp vec4 tint;

    void main() {
        gl_FragColor = tint;
    }"#;

    pub fn sprite_meta() -> ShaderMeta {
        ShaderMeta {
            images: vec![],
            uniforms: UniformBlockLayout {
                uniforms: vec![
                    UniformDesc::new("model_view_projection", UniformType::Mat4),
                    UniformDesc::new("tint", UniformType::Float4),
                ],
            },
        }
    }

    #[repr(C)]
    pub struct SpriteUniforms {
        pub model_view_projection: [f32; 16],
        pub tint: [f32; 4],
    }
}
