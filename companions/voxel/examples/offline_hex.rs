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
use miniquad_voxel::hex::{build_hex_chunk_mesh, HexFace, HEX_MAX_MESH_VERTICES};
use miniquad_voxel::hex_pick::{pick_hex, ray_from_pixel, HexPickParams, HexRay};
use miniquad_voxel::math::{Mat4, Vec3};
use miniquad_voxel::mesh::MeshBuffers;
use miniquad_voxel::terrain::{column_height, PALETTE};
use miniquad_voxel::world::{ChunkCoord, World};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};

/// Deterministic world seed (contract section 3.1).
const WORLD_SEED: u32 = 20261111;
const CHUNK_DIMS: ChunkDims = ChunkDims::new(8, 4, 8);
const MAX_RESIDENT_CHUNKS: usize = 4;
const MIN_LAYER: i32 = 0;
const MAX_LAYER: i32 = 3;

static RELEASE_REQUESTED: AtomicBool = AtomicBool::new(false);
static RESOURCES_LIVE: AtomicU32 = AtomicU32::new(0);
static TRIANGLE_COUNT: AtomicU32 = AtomicU32::new(0);

static PICKED_VALID: AtomicU32 = AtomicU32::new(0);
static PICKED_Q: AtomicI32 = AtomicI32::new(0);
static PICKED_R: AtomicI32 = AtomicI32::new(0);
static PICKED_LAYER: AtomicI32 = AtomicI32::new(0);
static PICKED_FACE: AtomicU32 = AtomicU32::new(8); // 8 = none, per contract section 3.3.

static PLACE_COLUMN: AtomicBool = AtomicBool::new(false);

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

/// Toggles the occlusion-test column between the camera and the
/// sprite (contract section 3.4, "Place column" / "Release" controls
/// in the HTML host). Always returns `0`.
#[no_mangle]
pub extern "C" fn hex_request_place_column() -> i32 {
    PLACE_COLUMN.fetch_xor(true, Ordering::Relaxed);
    0
}

/// Picks a cell at a backing-store pixel. `px`/`py` are passed as
/// `f32` bits (contract section 3.3) so no float ABI widening is
/// needed. Returns `0` on a hit, `1` on no hit, `2` on invalid input.
#[no_mangle]
pub extern "C" fn hex_probe_pick(px_bits: u32, py_bits: u32) -> i32 {
    let px = f32::from_bits(px_bits) as f64;
    let py = f32::from_bits(py_bits) as f64;
    let Some((camera, world, viewport)) = PICK_CONTEXT.with(|cell| cell.borrow().clone()) else {
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
    match pick_hex(&world, &ray, &params) {
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
    /// The current camera, world, and viewport, published by `draw`
    /// each frame so `hex_probe_pick` can run the same analytic
    /// picker the application would use for a real pointer event, with
    /// no `Stage` pointer stored anywhere (contract section 3.3).
    static PICK_CONTEXT: std::cell::RefCell<Option<(OrbitCamera, World, [f64; 2])>> =
        const { std::cell::RefCell::new(None) };
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

    world: World,
    camera: OrbitCamera,
    dragging: bool,
    last_mouse: (f32, f32),
    screen_size: (f32, f32),
    start_time: f64,
    released: bool,
}

/// Builds the two-chunk demo world and its combined world-space mesh.
/// Returns an error status string instead of panicking if the mesh
/// exceeds the checked WebGL1 index limit (contract section 1.8/3.1):
/// no `expect` on this path.
fn build_world_and_mesh() -> Result<(World, MeshBuffers), String> {
    let mut world = World::new(CHUNK_DIMS, MAX_RESIDENT_CHUNKS)
        .map_err(|error| format!("invalid demo world configuration: {error}"))?;
    let coords = [ChunkCoord::new(-1, 0, 0), ChunkCoord::new(0, 0, 0)];
    for coord in coords {
        let mut chunk = miniquad_voxel::chunk::Chunk::new(CHUNK_DIMS)
            .map_err(|error| format!("invalid chunk dims: {error}"))?;
        for r in 0..CHUNK_DIMS.z {
            for q in 0..CHUNK_DIMS.x {
                let world_q = coord.x * CHUNK_DIMS.x as i32 + q as i32;
                let world_r = coord.z * CHUNK_DIMS.z as i32 + r as i32;
                let height = column_height(WORLD_SEED, world_q, world_r, 1, 3)
                    .map_err(|error| format!("terrain generation failed: {error}"))?;
                for layer in 0..=height.min(CHUNK_DIMS.y - 1) {
                    let material = if layer == height { 1 } else { 2 };
                    chunk
                        .set(q, layer, r, material)
                        .map_err(|error| format!("chunk write out of bounds: {error}"))?;
                }
            }
        }
        world
            .insert(coord, chunk)
            .map_err(|error| format!("world insert failed: {error}"))?;
    }

    let mut combined = MeshBuffers::new();
    let mut per_chunk = MeshBuffers::new();
    for coord in coords {
        build_hex_chunk_mesh(&world, coord, &PALETTE, &mut per_chunk)
            .map_err(|error| format!("hex mesh build failed: {error:?}"))?;
        if combined.vertices.len() + per_chunk.vertices.len() > HEX_MAX_MESH_VERTICES {
            return Err(format!(
                "combined hex mesh exceeds HEX_MAX_MESH_VERTICES ({})",
                HEX_MAX_MESH_VERTICES
            ));
        }
        let base = combined.vertices.len() as u32;
        combined.vertices.extend_from_slice(&per_chunk.vertices);
        combined
            .indices
            .extend(per_chunk.indices.iter().map(|index| index + base));
    }
    Ok((world, combined))
}

impl Stage {
    pub fn new() -> Stage {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();

        let (world, combined) = match build_world_and_mesh() {
            Ok(result) => result,
            Err(message) => {
                // No terrain is drawn; the HTML host reports `status:
                // error` per contract section 3.1. This path uses no
                // `expect`/`panic!`, matching the checked-limit rule.
                eprintln!("offline_hex: {message}");
                (
                    World::new(CHUNK_DIMS, MAX_RESIDENT_CHUNKS).expect("fallback world is valid"),
                    MeshBuffers::new(),
                )
            }
        };
        TRIANGLE_COUNT.store((combined.indices.len() / 3) as u32, Ordering::Relaxed);

        let mut resource_count = 0u32;
        let terrain_vertex_buffer = ctx.new_buffer(
            BufferType::VertexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&combined.vertices),
        );
        resource_count += 1;
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
        let terrain_index_buffer = ctx.new_buffer(
            BufferType::IndexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&terrain_indices),
        );
        resource_count += 1;

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

        PICK_CONTEXT.with(|cell| {
            *cell.borrow_mut() = Some((
                self.camera,
                // `World` holds only bounded CPU data (chunk grids);
                // cloning it for the probe keeps no pointer to `Stage`.
                World::new(self.world.dims(), self.world.max_resident_chunks())
                    .map(|mut clone| {
                        for coord in [ChunkCoord::new(-1, 0, 0), ChunkCoord::new(0, 0, 0)] {
                            if let Some(chunk) = self.world.get(coord) {
                                let _ = clone.insert(coord, chunk.clone());
                            }
                        }
                        clone
                    })
                    .unwrap_or_else(|_| World::new(CHUNK_DIMS, MAX_RESIDENT_CHUNKS).unwrap()),
                (self.screen_size.0 as f64, self.screen_size.1 as f64),
            ));
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
        let model = Mat4([
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, sprite_pos.x, sprite_pos.y,
            sprite_pos.z, 1.0,
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
