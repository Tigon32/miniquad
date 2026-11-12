//! Offline bounded voxel vertical slice.
//!
//! Draws one small bounded voxel terrain (two resident chunks, visible
//! faces only) with a perspective camera (depth test and write
//! enabled), followed by one moving world-space 2D sprite (quad, depth
//! test enabled, depth write disabled, alpha blended). This matches
//! the frame-composition order in MADR 0008: clear, opaque 3D terrain,
//! then the world-space 2D sprite. The screen-space HTML HUD is
//! intentionally **not** drawn here: it lives in the external
//! embedding host, per the issue #29 adoption sequence (see
//! `docs/offline-voxel.md`).
//!
//! This example makes no network request. It is the WASM-only /
//! offline mode from MADR 0008; mode B (mixed WASM + server-side
//! execution) is not implemented and remains open.
//!
//! # Controls
//! - Arrow keys: orbit the camera (Left/Right = yaw, Up/Down = pitch).
//! - Mouse drag (left button): orbit the camera by the drag delta.
//!
//! # Optional app-parameters export surface
//!
//! This example exposes the same small, optional "app parameters"
//! surface as the `miniquad-starter` browser template, so a parent
//! host page can reuse one `setParameters` contract across example
//! applications. It is not part of the Miniquad core ABI.
//!
//!   - `mq_params_version() -> u32`: always `1`.
//!   - `mq_param_set_f32(1, value) -> i32`: sets sprite animation
//!     speed, range `0..=2`. Returns `0` on success, `1` for a
//!     non-finite or out-of-range value, `2` for an unknown `id`.
//!   - `mq_param_set_rgba8(1, color) -> i32`: sets the sprite tint.
//!   - `mq_param_set_rgba8(2, color) -> i32`: sets the clear
//!     (background) color. Returns `0` on success, `2` for an unknown
//!     `id`.
//!
//! `color` is an unsigned 32-bit value packed as `0xRRGGBBAA`, straight
//! alpha, sRGB channel bytes.

use miniquad::*;
use miniquad_voxel::camera::OrbitCamera;
use miniquad_voxel::chunk::ChunkDims;
use miniquad_voxel::math::{Mat4, Vec3};
use miniquad_voxel::mesh::{build_chunk_mesh, MeshBuffers, Vertex as VoxelVertex};
use miniquad_voxel::sim::SCENE_SEED;
use miniquad_voxel::terrain::{generate_chunk, PALETTE};
use miniquad_voxel::world::{ChunkCoord, World};
use std::sync::atomic::{AtomicU32, Ordering};

#[path = "support/scene.rs"]
mod scene;

/// Version of the optional app-parameters surface.
const PARAMS_VERSION: u32 = 1;

const DEFAULT_SPEED_BITS: u32 = 0x3F80_0000; // f32::to_bits(1.0)
const DEFAULT_SPRITE_RGBA8: u32 = 0x3075_C8FF; // opaque blue
const DEFAULT_BACKGROUND_RGBA8: u32 = 0x10_18_24_FF; // opaque near-black blue

static SPEED_BITS: AtomicU32 = AtomicU32::new(DEFAULT_SPEED_BITS);
static SPRITE_RGBA8: AtomicU32 = AtomicU32::new(DEFAULT_SPRITE_RGBA8);
static BACKGROUND_RGBA8: AtomicU32 = AtomicU32::new(DEFAULT_BACKGROUND_RGBA8);

/// Reports the app-parameters surface version.
#[no_mangle]
pub extern "C" fn mq_params_version() -> u32 {
    PARAMS_VERSION
}

/// Sets a float parameter. `id` 1 is sprite animation speed, range
/// `0..=2`. Returns `0` on success, `1` for a non-finite or
/// out-of-range value, `2` for an unknown `id`.
#[no_mangle]
pub extern "C" fn mq_param_set_f32(id: u32, value: f32) -> i32 {
    if !value.is_finite() {
        return 1;
    }
    match id {
        1 => {
            if !(0.0..=2.0).contains(&value) {
                return 1;
            }
            SPEED_BITS.store(value.to_bits(), Ordering::Relaxed);
            0
        }
        _ => 2,
    }
}

/// Sets a packed `0xRRGGBBAA` color parameter. `id` 1 is the sprite
/// tint, `id` 2 is the background clear color. Returns `0` on success,
/// `2` for an unknown `id`.
#[no_mangle]
pub extern "C" fn mq_param_set_rgba8(id: u32, color: u32) -> i32 {
    match id {
        1 => {
            SPRITE_RGBA8.store(color, Ordering::Relaxed);
            0
        }
        2 => {
            BACKGROUND_RGBA8.store(color, Ordering::Relaxed);
            0
        }
        _ => 2,
    }
}

fn unpack_rgba8(packed: u32) -> [f32; 4] {
    let r = ((packed >> 24) & 0xFF) as f32 / 255.0;
    let g = ((packed >> 16) & 0xFF) as f32 / 255.0;
    let b = ((packed >> 8) & 0xFF) as f32 / 255.0;
    let a = (packed & 0xFF) as f32 / 255.0;
    [r, g, b, a]
}

/// The default demo uses two 8x12x8 chunks placed side by side along X.
/// The measurement feature selects the hex example's 8x4x8 cell grid.
#[cfg(not(feature = "measurement-equal-cells"))]
const CHUNK_DIMS: ChunkDims = ChunkDims::new(8, 12, 8);
#[cfg(feature = "measurement-equal-cells")]
const CHUNK_DIMS: ChunkDims = ChunkDims::new(8, 4, 8);
const MAX_RESIDENT_CHUNKS: usize = 4;
#[cfg(not(feature = "measurement-equal-cells"))]
const CHUNK_COORDS: [ChunkCoord; 2] = [ChunkCoord::new(0, 0, 0), ChunkCoord::new(1, 0, 0)];
#[cfg(feature = "measurement-equal-cells")]
const CHUNK_COORDS: [ChunkCoord; 2] = [ChunkCoord::new(-1, 0, 0), ChunkCoord::new(0, 0, 0)];

struct Stage {
    ctx: Box<dyn RenderingBackend>,

    world: World,
    terrain_pipeline: Pipeline,
    terrain_bindings: Bindings,
    terrain_index_count: i32,

    sprite_pipeline: Pipeline,
    sprite_bindings: Bindings,

    camera: OrbitCamera,
    dragging: bool,
    last_mouse: (f32, f32),
    screen_size: (f32, f32),

    start_time: f64,
}

impl Stage {
    pub fn new() -> Stage {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();

        // --- Build the bounded voxel world and its visible-face mesh. ---
        let mut world = World::new(CHUNK_DIMS, MAX_RESIDENT_CHUNKS)
            .expect("fixed demo world configuration is valid");
        let [coord_a, coord_b] = CHUNK_COORDS;
        let chunk_a = generate_chunk(
            SCENE_SEED,
            CHUNK_DIMS,
            coord_a.x * CHUNK_DIMS.x as i32,
            coord_a.z * CHUNK_DIMS.z as i32,
        )
        .expect("fixed demo chunk dimensions are within bounds");
        let chunk_b = generate_chunk(
            SCENE_SEED,
            CHUNK_DIMS,
            coord_b.x * CHUNK_DIMS.x as i32,
            coord_b.z * CHUNK_DIMS.z as i32,
        )
        .expect("fixed demo chunk dimensions are within bounds");
        world.insert(coord_a, chunk_a).expect("world has room");
        world.insert(coord_b, chunk_b).expect("world has room");

        let mut mesh_buffers = MeshBuffers::new();
        build_chunk_mesh(&world, coord_a, &PALETTE, &mut mesh_buffers)
            .expect("chunk a is resident");
        let mut combined = std::mem::take(&mut mesh_buffers);
        let mut chunk_b_mesh = MeshBuffers::new();
        build_chunk_mesh(&world, coord_b, &PALETTE, &mut chunk_b_mesh)
            .expect("chunk b is resident");
        append_mesh(&mut combined, &chunk_b_mesh, CHUNK_DIMS.x as f32);

        let terrain_vertex_buffer = ctx.new_buffer(
            BufferType::VertexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&combined.vertices),
        );
        let terrain_indices: Vec<u16> = combined
            .indices
            .iter()
            .map(|&index| u16::try_from(index).expect("fixed demo mesh fits WebGL1 indices"))
            .collect();
        let terrain_index_buffer = ctx.new_buffer(
            BufferType::IndexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&terrain_indices),
        );
        let terrain_bindings = Bindings {
            vertex_buffers: vec![terrain_vertex_buffer],
            index_buffer: terrain_index_buffer,
            images: vec![],
        };
        let terrain_index_count = combined.indices.len() as i32;

        let terrain_shader = ctx
            .new_shader(
                match ctx.info().backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: shader::TERRAIN_VERTEX,
                        fragment: shader::TERRAIN_FRAGMENT,
                    },
                    Backend::Metal => {
                        // This example only claims WebGL1 and native
                        // OpenGL compilation/testing. Metal shader
                        // source is intentionally not supplied; see
                        // `docs/offline-voxel.md`.
                        panic!("miniquad-voxel offline example does not supply a Metal shader")
                    }
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
                ..Default::default()
            },
        );

        // --- World-space 2D sprite: a single flat quad, moved and
        // tinted entirely through per-frame uniforms, so no vertex
        // buffer is reallocated or rewritten per frame. ---
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
        let sprite_indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
        let sprite_index_buffer = ctx.new_buffer(
            BufferType::IndexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&sprite_indices),
        );
        let sprite_bindings = Bindings {
            vertex_buffers: vec![sprite_vertex_buffer],
            index_buffer: sprite_index_buffer,
            images: vec![],
        };

        let sprite_shader = ctx
            .new_shader(
                match ctx.info().backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: shader::SPRITE_VERTEX,
                        fragment: shader::SPRITE_FRAGMENT,
                    },
                    Backend::Metal => {
                        panic!("miniquad-voxel offline example does not supply a Metal shader")
                    }
                },
                shader::sprite_meta(),
            )
            .unwrap();
        // Depth policy for the world-space sprite: depth test stays
        // enabled (so terrain in front of the sprite still occludes
        // it), depth write is disabled (so the sprite never blocks
        // terrain drawn later), and alpha blending is enabled. The
        // sprite is drawn after opaque terrain, matching MADR 0008's
        // frame-composition order.
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

        let world_center_x = CHUNK_DIMS.x as f32; // between the two chunks
        let world_center_z = (CHUNK_DIMS.z as f32) * 0.5;
        Stage {
            ctx,
            world,
            terrain_pipeline,
            terrain_bindings,
            terrain_index_count,
            sprite_pipeline,
            sprite_bindings,
            camera: OrbitCamera::new(
                Vec3::new(world_center_x, (CHUNK_DIMS.y as f32) * 0.4, world_center_z),
                22.0,
                0.6,
                0.5,
            ),
            dragging: false,
            last_mouse: (0.0, 0.0),
            screen_size: (800.0, 500.0),
            start_time: date::now(),
        }
    }
}

/// Appends `src`'s mesh into `dst`, offsetting `src`'s vertex
/// positions by `+x_offset` along X (so the second chunk's mesh lines
/// up next to the first) and rebasing its indices.
fn append_mesh(dst: &mut MeshBuffers, src: &MeshBuffers, x_offset: f32) {
    let base = dst.vertices.len() as u32;
    dst.vertices.reserve(src.vertices.len());
    for v in &src.vertices {
        dst.vertices.push(VoxelVertex {
            pos: [v.pos[0] + x_offset, v.pos[1], v.pos[2]],
            normal: v.normal,
            color: v.color,
        });
    }
    dst.indices.reserve(src.indices.len());
    dst.indices.extend(src.indices.iter().map(|i| i + base));
}

fn column_height(world: &World, x: i32, z: i32) -> i32 {
    for y in (0..CHUNK_DIMS.y as i32).rev() {
        if world.is_solid(CHUNK_COORDS[0], x, y, z) {
            return y;
        }
    }
    -1
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
        let speed = f32::from_bits(SPEED_BITS.load(Ordering::Relaxed));
        let sprite_tint = unpack_rgba8(SPRITE_RGBA8.load(Ordering::Relaxed));
        let background = unpack_rgba8(BACKGROUND_RGBA8.load(Ordering::Relaxed));

        let t = (date::now() - self.start_time) * speed as f64;
        let aspect = self.screen_size.0 / self.screen_size.1;
        let view = self.camera.view_matrix();
        let projection = self.camera.projection_matrix(aspect);
        let view_projection = projection.mul(&view);

        // 1. Clear the target and depth buffer.
        self.ctx.begin_default_pass(PassAction::Clear {
            color: Some((background[0], background[1], background[2], background[3])),
            depth: Some(1.0),
            stencil: None,
        });

        // 2. Draw the opaque 3D voxel terrain with depth test/write.
        self.ctx.apply_pipeline(&self.terrain_pipeline);
        self.ctx.apply_bindings(&self.terrain_bindings);
        self.ctx
            .apply_uniforms(UniformsSource::table(&shader::TerrainUniforms {
                view_projection: view_projection.0,
            }));
        self.ctx.draw(0, self.terrain_index_count, 1);

        // 3. Draw the moving world-space 2D sprite: animated height
        // (vertical bob) composed with a slow circling motion so both
        // an "animated height" and a "moving sprite" are demonstrated
        // by the same object, per the issue #29 adoption sequence.
        let sprite_pos = scene::sprite_position(t as f32, CHUNK_DIMS, |x, z| {
            column_height(&self.world, x, z)
        });
        let model = Mat4([
            1.0,
            0.0,
            0.0,
            0.0, //
            0.0,
            1.0,
            0.0,
            0.0, //
            0.0,
            0.0,
            1.0,
            0.0, //
            sprite_pos.x,
            sprite_pos.y,
            sprite_pos.z,
            1.0,
        ]);
        self.ctx.apply_pipeline(&self.sprite_pipeline);
        self.ctx.apply_bindings(&self.sprite_bindings);
        self.ctx
            .apply_uniforms(UniformsSource::table(&shader::SpriteUniforms {
                model_view_projection: view_projection.mul(&model).0,
                tint: sprite_tint,
            }));
        self.ctx.draw(0, 6, 1);

        self.ctx.end_render_pass();
        self.ctx.commit_frame();
    }
}

fn main() {
    let conf = conf::Conf {
        window_title: "miniquad-voxel offline".to_owned(),
        window_width: 800,
        window_height: 500,
        high_dpi: true,
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
        // A fixed, simple directional light so each face shows its
        // own flat shade; not a physically based lighting model.
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
