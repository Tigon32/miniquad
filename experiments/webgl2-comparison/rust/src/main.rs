use miniquad::*;
use miniquad_draw::batch::Batch;
use miniquad_draw::color::Color;
use miniquad_draw::transform::Transform2D;
use miniquad_voxel::chunk::{Chunk, ChunkDims};
use miniquad_voxel::mesh::{build_chunk_mesh, MeshBuffers};
use miniquad_voxel::world::{ChunkCoord, World};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
#[cfg(target_arch = "wasm32")]
use std::sync::{Mutex, OnceLock};

mod fixture {
    include!("../../fixture.rs");
}

static LAYER_MASK: AtomicU32 = AtomicU32::new(0b111);
static MESH_HASH: AtomicU64 = AtomicU64::new(0);
static KNOWN_BAD: AtomicBool = AtomicBool::new(false);
#[cfg(target_arch = "wasm32")]
static CAPTURE_REQUESTED: AtomicBool = AtomicBool::new(false);
#[cfg(target_arch = "wasm32")]
static CAPTURE_READY: AtomicBool = AtomicBool::new(false);
#[cfg(target_arch = "wasm32")]
static CAPTURE_BUFFER: OnceLock<Mutex<Vec<u8>>> = OnceLock::new();

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct SceneVertex {
    position: [f32; 2],
    color: [f32; 4],
}

#[cfg(target_arch = "wasm32")]
#[repr(C)]
struct DisplayVertex {
    position: [f32; 2],
    uv: [f32; 2],
}

struct SceneMesh {
    vertices: Vec<SceneVertex>,
    indices: Vec<u16>,
}

fn color(rgba: [u8; 4]) -> Color {
    Color::new(
        rgba[0] as f32 / 255.0,
        rgba[1] as f32 / 255.0,
        rgba[2] as f32 / 255.0,
        rgba[3] as f32 / 255.0,
    )
}

fn project(q: f32, r: f32) -> (f32, f32) {
    (
        fixture::WIDTH as f32 / 2.0 + (q - r) * 11.0,
        285.0 - (q + r) * 4.5,
    )
}

fn to_ndc(position: [f32; 2]) -> [f32; 2] {
    [
        (position[0] / fixture::WIDTH as f32) * 2.0 - 1.0,
        1.0 - (position[1] / fixture::HEIGHT as f32) * 2.0,
    ]
}

fn append_batch(
    batch: &Batch,
    vertices: &mut Vec<SceneVertex>,
    indices: &mut Vec<u16>,
) {
    for chunk in batch.chunks() {
        let base = u16::try_from(vertices.len()).expect("fixed comparison mesh fits u16 indices");
        vertices.extend(chunk.vertices.iter().map(|vertex| SceneVertex {
            position: to_ndc(vertex.pos),
            color: vertex.color,
        }));
        indices.extend(chunk.indices.iter().map(|index| {
            base.checked_add(*index)
                .expect("fixed comparison mesh fits u16 indices")
        }));
    }
}

fn append_voxels(
    mesh: &MeshBuffers,
    vertices: &mut Vec<SceneVertex>,
    indices: &mut Vec<u16>,
) {
    for face in mesh.indices.chunks_exact(6) {
        let first = face[0] as usize;
        let normal = mesh.vertices[first].normal;
        let rgba = if normal == [1.0, 0.0, 0.0] {
            [109, 53, 255, 255]
        } else if normal == [0.0, -1.0, 0.0] {
            [8, 124, 186, 255]
        } else if normal == [0.0, 0.0, 1.0] {
            [23, 228, 255, 255]
        } else {
            continue;
        };
        let base = u16::try_from(vertices.len()).expect("fixed comparison mesh fits u16 indices");
        let rgba = color(rgba).to_premultiplied();
        for index in [face[0], face[1], face[2], face[5]] {
            let point = mesh.vertices[index as usize].pos;
            let pixel = [
                fixture::WIDTH as f32 / 2.0 + (point[0] - point[1]) * 11.0,
                393.0 - (point[0] + point[1]) * 4.5 - point[2] * 8.5,
            ];
            vertices.push(SceneVertex {
                position: to_ndc(pixel),
                color: rgba,
            });
        }
        indices.extend_from_slice(&[
            base,
            base + 1,
            base + 2,
            base,
            base + 2,
            base + 3,
        ]);
    }
}

fn build_grid_batch() -> Batch {
    let mut batch = Batch::new();
    let half_grid = fixture::GRID_SIZE as f32 / 2.0;
    for q in 0..=fixture::GRID_SIZE {
        let q = q as f32 - half_grid;
        batch
            .polyline(
                &[project(q, -half_grid), project(q, half_grid)],
                1.2,
                color([32, 49, 75, 255]),
                Transform2D::IDENTITY,
            )
            .expect("fixed grid lines are valid");
    }
    for r in 0..=fixture::GRID_SIZE {
        let r = r as f32 - half_grid;
        batch
            .polyline(
                &[project(-half_grid, r), project(half_grid, r)],
                1.2,
                color([32, 49, 75, 255]),
                Transform2D::IDENTITY,
            )
            .expect("fixed grid lines are valid");
    }
    batch
}

fn build_vector_batch() -> Batch {
    let points: Vec<_> = fixture::PATH
        .iter()
        .map(|point| (point[0], point[1]))
        .collect();
    let mut batch = Batch::new();
    batch
        .polyline(
            &points,
            3.0,
            color([255, 73, 198, 255]),
            Transform2D::IDENTITY,
        )
        .expect("fixed vector path is valid");

    for &point_index in fixture::ARROW_POINTS {
        let from = fixture::PATH[point_index as usize];
        let to = fixture::PATH[point_index as usize + 1];
        let dx = to[0] - from[0];
        let dy = to[1] - from[1];
        let length = (dx * dx + dy * dy).sqrt();
        let ux = dx / length;
        let uy = dy / length;
        let base = (to[0] - ux * 10.0, to[1] - uy * 10.0);
        let left = (base.0 - uy * 5.0, base.1 + ux * 5.0);
        let right = (base.0 + uy * 5.0, base.1 - ux * 5.0);
        batch
            .triangle(
                (to[0], to[1]),
                left,
                right,
                color([255, 243, 107, 255]),
                Transform2D::IDENTITY,
            )
            .expect("fixed vector arrow is valid");
    }
    batch
}

fn build_scene() -> SceneMesh {
    let dims = ChunkDims::new(fixture::GRID_SIZE, fixture::GRID_SIZE, fixture::LEVEL_LIMIT);
    let coord = ChunkCoord::new(0, 0, 0);
    let mut world = World::new(dims, 1).expect("fixed comparison world is bounded");
    let mut chunk = Chunk::new(dims).expect("fixed comparison chunk is bounded");
    for cell in fixture::CELLS {
        for z in 0..cell.height {
            chunk
                .set(cell.q, cell.r, z, 1)
                .expect("fixture voxel is within the fixed chunk");
        }
    }
    world
        .insert(coord, chunk)
        .expect("fixed comparison chunk fits the world");
    let mut voxel_mesh = MeshBuffers::new();
    build_chunk_mesh(&world, coord, &[[0.0; 4], [1.0; 4]], &mut voxel_mesh)
        .expect("fixed comparison chunk is resident");

    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    let grid_first = 0;
    append_batch(&build_grid_batch(), &mut vertices, &mut indices);
    let grid_count = indices.len();
    let voxel_first = indices.len();
    append_voxels(&voxel_mesh, &mut vertices, &mut indices);
    let voxel_count = indices.len() - voxel_first;
    let vector_first = indices.len();
    append_batch(&build_vector_batch(), &mut vertices, &mut indices);
    let vector_count = indices.len() - vector_first;

    let layers = [
        fixture::Layer {
            first_index: grid_first,
            index_count: i32::try_from(grid_count).expect("fixed layer count fits i32"),
        },
        fixture::Layer {
            first_index: i32::try_from(voxel_first).expect("fixed layer offset fits i32"),
            index_count: i32::try_from(voxel_count).expect("fixed layer count fits i32"),
        },
        fixture::Layer {
            first_index: i32::try_from(vector_first).expect("fixed layer offset fits i32"),
            index_count: i32::try_from(vector_count).expect("fixed layer count fits i32"),
        },
    ];
    let fixture_vertices: Vec<_> = fixture::VERTICES
        .iter()
        .map(|vertex| SceneVertex {
            position: vertex.position,
            color: vertex.color,
        })
        .collect();
    assert_eq!(vertices.len(), fixture_vertices.len(), "companion vertex count changed");
    for (index, (actual, expected)) in vertices.iter().zip(&fixture_vertices).enumerate() {
        assert_eq!(
            actual.position.map(f32::to_bits),
            expected.position.map(f32::to_bits),
            "companion vertex {index} position changed"
        );
        assert_eq!(
            actual.color.map(f32::to_bits),
            expected.color.map(f32::to_bits),
            "companion vertex {index} color changed"
        );
    }
    assert_eq!(indices.len(), fixture::INDICES.len(), "companion index count changed");
    if let Some(index) = indices
        .iter()
        .zip(fixture::INDICES)
        .position(|(actual, expected)| actual != expected)
    {
        assert_eq!(indices[index], fixture::INDICES[index], "companion index {index} changed");
    }
    assert_eq!(layers, fixture::LAYERS, "companion layer ranges changed");

    SceneMesh {
        vertices,
        indices,
    }
}

fn mesh_hash(mesh: &SceneMesh) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for vertex in &mesh.vertices {
        for value in vertex.position.iter().chain(vertex.color.iter()) {
            for byte in value.to_le_bytes() {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x100000001b3);
            }
        }
    }
    for index in &mesh.indices {
        for byte in index.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash
}

struct Stage {
    ctx: Box<dyn RenderingBackend>,
    scene_pipeline: Pipeline,
    scene_bindings: Bindings,
    control_bindings: Bindings,
    #[cfg(target_arch = "wasm32")]
    display_pipeline: Pipeline,
    #[cfg(target_arch = "wasm32")]
    display_bindings: Bindings,
    target: TextureId,
    pass: RenderPass,
    #[cfg(not(target_arch = "wasm32"))]
    capture_path: Option<String>,
}

impl Stage {
    fn new() -> Self {
        let mesh = build_scene();
        let hash = mesh_hash(&mesh);
        assert_eq!(hash, fixture::MESH_FNV64, "companion geometry hash changed");
        MESH_HASH.store(hash, Ordering::Relaxed);

        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();
        let target = ctx.new_render_texture(TextureParams {
            width: fixture::WIDTH,
            height: fixture::HEIGHT,
            format: TextureFormat::RGBA8,
            min_filter: FilterMode::Nearest,
            mag_filter: FilterMode::Nearest,
            sample_count: 1,
            ..Default::default()
        });
        let pass = ctx.new_render_pass(target, None);
        let vertex_buffer = ctx.new_buffer(
            BufferType::VertexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&mesh.vertices),
        );
        let index_buffer = ctx.new_buffer(
            BufferType::IndexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&mesh.indices),
        );
        let scene_bindings = Bindings {
            vertex_buffers: vec![vertex_buffer],
            index_buffer,
            images: vec![],
        };
        let control_vertices = [
            SceneVertex {
                position: [-1.0, 1.0],
                color: [1.0, 0.0, 1.0, 1.0],
            },
            SceneVertex {
                position: [-0.9, 1.0],
                color: [1.0, 0.0, 1.0, 1.0],
            },
            SceneVertex {
                position: [-0.9, 0.84],
                color: [1.0, 0.0, 1.0, 1.0],
            },
            SceneVertex {
                position: [-1.0, 0.84],
                color: [1.0, 0.0, 1.0, 1.0],
            },
        ];
        let control_vertex_buffer = ctx.new_buffer(
            BufferType::VertexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&control_vertices),
        );
        let control_index_buffer = ctx.new_buffer(
            BufferType::IndexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&[0_u16, 1, 2, 0, 2, 3]),
        );
        let control_bindings = Bindings {
            vertex_buffers: vec![control_vertex_buffer],
            index_buffer: control_index_buffer,
            images: vec![],
        };
        let scene_shader = ctx
            .new_shader(
                match ctx.info().backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: scene_shader::VERTEX,
                        fragment: scene_shader::FRAGMENT,
                    },
                    Backend::Metal => ShaderSource::Msl {
                        program: scene_shader::METAL,
                    },
                },
                scene_shader::meta(),
            )
            .expect("comparison scene shader must compile");
        let scene_pipeline = ctx.new_pipeline(
            &[BufferLayout::default()],
            &[
                VertexAttribute::new("in_pos", VertexFormat::Float2),
                VertexAttribute::new("in_color", VertexFormat::Float4),
            ],
            scene_shader,
            PipelineParams::default(),
        );

        #[cfg(target_arch = "wasm32")]
        let (display_pipeline, display_bindings) = {
            let vertices = [
                DisplayVertex {
                    position: [-1.0, -1.0],
                    uv: [0.0, 0.0],
                },
                DisplayVertex {
                    position: [1.0, -1.0],
                    uv: [1.0, 0.0],
                },
                DisplayVertex {
                    position: [1.0, 1.0],
                    uv: [1.0, 1.0],
                },
                DisplayVertex {
                    position: [-1.0, 1.0],
                    uv: [0.0, 1.0],
                },
            ];
            let display_vertex_buffer = ctx.new_buffer(
                BufferType::VertexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&vertices),
            );
            let display_index_buffer = ctx.new_buffer(
                BufferType::IndexBuffer,
                BufferUsage::Immutable,
                BufferSource::slice(&[0_u16, 1, 2, 0, 2, 3]),
            );
            let display_shader = ctx
                .new_shader(
                    ShaderSource::Glsl {
                        vertex: display_shader::VERTEX,
                        fragment: display_shader::FRAGMENT,
                    },
                    display_shader::meta(),
                )
                .expect("comparison display shader must compile");
            let pipeline = ctx.new_pipeline(
                &[BufferLayout::default()],
                &[
                    VertexAttribute::new("in_pos", VertexFormat::Float2),
                    VertexAttribute::new("in_uv", VertexFormat::Float2),
                ],
                display_shader,
                PipelineParams::default(),
            );
            let bindings = Bindings {
                vertex_buffers: vec![display_vertex_buffer],
                index_buffer: display_index_buffer,
                images: vec![target],
            };
            (pipeline, bindings)
        };

        #[cfg(not(target_arch = "wasm32"))]
        let capture_path = std::env::var("MINIQUAD_CAPTURE_PATH").ok();

        Self {
            ctx,
            scene_pipeline,
            scene_bindings,
            control_bindings,
            #[cfg(target_arch = "wasm32")]
            display_pipeline,
            #[cfg(target_arch = "wasm32")]
            display_bindings,
            target,
            pass,
            #[cfg(not(target_arch = "wasm32"))]
            capture_path,
        }
    }

    fn draw_scene(&mut self, pass: Option<RenderPass>) {
        self.ctx.begin_pass(
            pass,
            PassAction::clear_color(
                fixture::BACKGROUND[0] as f32 / 255.0,
                fixture::BACKGROUND[1] as f32 / 255.0,
                fixture::BACKGROUND[2] as f32 / 255.0,
                fixture::BACKGROUND[3] as f32 / 255.0,
            ),
        );
        self.ctx.apply_pipeline(&self.scene_pipeline);
        self.ctx.apply_bindings(&self.scene_bindings);
        let mask = LAYER_MASK.load(Ordering::Relaxed);
        for (index, layer) in fixture::LAYERS.iter().enumerate() {
            if mask & (1 << index) != 0 {
                self.ctx.draw(layer.first_index, layer.index_count, 1);
            }
        }
        if KNOWN_BAD.load(Ordering::Relaxed) {
            self.ctx.apply_bindings(&self.control_bindings);
            self.ctx.draw(0, 6, 1);
        }
        self.ctx.end_render_pass();
    }
}

impl EventHandler for Stage {
    fn update(&mut self) {}

    fn draw(&mut self) {
        self.draw_scene(Some(self.pass));

        #[cfg(target_arch = "wasm32")]
        if CAPTURE_REQUESTED.swap(false, Ordering::AcqRel) {
            let pixels = CAPTURE_BUFFER.get_or_init(|| Mutex::new(Vec::new()));
            let mut pixels = pixels.lock().expect("comparison capture buffer lock");
            pixels.resize(
                TextureFormat::RGBA8.size(fixture::WIDTH, fixture::HEIGHT) as usize,
                0,
            );
            self.ctx.texture_read_pixels(self.target, &mut pixels);
            let row_bytes = fixture::WIDTH as usize * 4;
            for row in 0..fixture::HEIGHT as usize / 2 {
                let opposite = fixture::HEIGHT as usize - row - 1;
                for byte in 0..row_bytes {
                    pixels.swap(row * row_bytes + byte, opposite * row_bytes + byte);
                }
            }
            CAPTURE_READY.store(true, Ordering::Release);
        }

        #[cfg(not(target_arch = "wasm32"))]
        let captured = self.capture_path.is_some();
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(path) = self.capture_path.take() {
            let mut pixels =
                vec![0; TextureFormat::RGBA8.size(fixture::WIDTH, fixture::HEIGHT) as usize];
            assert!(
                self.ctx.texture_supports_read_pixels(self.target),
                "comparison render target must support pixel read-back"
            );
            self.ctx.texture_read_pixels(self.target, &mut pixels);
            if self.ctx.info().backend == Backend::Metal {
                for pixel in pixels.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                }
            }
            std::fs::write(&path, pixels).expect("write native comparison capture");
            println!("Wrote native comparison capture as top-left RGBA8: {path}");
        }

        #[cfg(target_arch = "wasm32")]
        {
            self.ctx
                .begin_default_pass(PassAction::clear_color(0.0, 0.0, 0.0, 1.0));
            self.ctx.apply_pipeline(&self.display_pipeline);
            self.ctx.apply_bindings(&self.display_bindings);
            self.ctx.draw(0, 6, 1);
            self.ctx.end_render_pass();
        }

        #[cfg(not(target_arch = "wasm32"))]
        if captured {
            std::process::exit(0);
        }
        self.ctx.commit_frame();
    }
}

#[no_mangle]
pub extern "C" fn comparison_occupied_cells() -> u32 {
    fixture::OCCUPIED_CELLS
}

#[no_mangle]
pub extern "C" fn comparison_voxel_levels() -> u32 {
    fixture::VOXEL_LEVELS
}

#[no_mangle]
pub extern "C" fn comparison_path_points() -> u32 {
    fixture::PATH_POINTS
}

#[no_mangle]
pub extern "C" fn comparison_arrows() -> u32 {
    fixture::ARROWS
}

#[no_mangle]
pub extern "C" fn comparison_vector_items() -> u32 {
    fixture::VECTOR_ITEMS
}

#[no_mangle]
pub extern "C" fn comparison_set_layer_mask(mask: u32) {
    LAYER_MASK.store(mask & 0b111, Ordering::Relaxed);
}

#[no_mangle]
pub extern "C" fn comparison_set_known_bad(enabled: u32) {
    KNOWN_BAD.store(enabled != 0, Ordering::Relaxed);
}

#[no_mangle]
pub extern "C" fn comparison_mesh_hash64() -> u64 {
    MESH_HASH.load(Ordering::Relaxed)
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn comparison_request_capture() {
    CAPTURE_READY.store(false, Ordering::Relaxed);
    CAPTURE_REQUESTED.store(true, Ordering::Release);
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn comparison_capture_ready() -> u32 {
    u32::from(CAPTURE_READY.load(Ordering::Acquire))
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn comparison_capture_ptr() -> u32 {
    CAPTURE_BUFFER
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("comparison capture buffer lock")
        .as_ptr() as usize as u32
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn comparison_capture_len() -> u32 {
    CAPTURE_BUFFER
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .expect("comparison capture buffer lock")
        .len() as u32
}
fn main() {
    let mut conf = conf::Conf::default();
    conf.window_title = "Miniquad/WebGL2 comparison".to_owned();
    conf.window_width = fixture::WIDTH as i32;
    conf.window_height = fixture::HEIGHT as i32;
    conf.high_dpi = false;
    conf.platform.webgl_version = conf::WebGLVersion::WebGL2;
    conf.platform.apple_gfx_api = conf::AppleGfxApi::Metal;
    miniquad::start(conf, || Box::new(Stage::new()));
}

mod scene_shader {
    use miniquad::*;

    pub const VERTEX: &str = r#"#version 100
    attribute vec2 in_pos;
    attribute vec4 in_color;
    varying lowp vec4 color;
    void main() {
        gl_Position = vec4(in_pos, 0.0, 1.0);
        color = in_color;
    }"#;

    pub const FRAGMENT: &str = r#"#version 100
    varying lowp vec4 color;
    void main() {
        gl_FragColor = color;
    }"#;

    pub const METAL: &str = r#"
    #include <metal_stdlib>
    using namespace metal;
    struct Vertex {
        float2 position [[attribute(0)]];
        float4 color [[attribute(1)]];
    };
    struct RasterizerData {
        float4 position [[position]];
        float4 color [[user(locn0)]];
    };
    vertex RasterizerData vertexShader(Vertex in [[stage_in]]) {
        RasterizerData out;
        out.position = float4(in.position, 0.0, 1.0);
        out.color = in.color;
        return out;
    }
    fragment float4 fragmentShader(RasterizerData in [[stage_in]]) {
        return in.color;
    }"#;

    pub fn meta() -> ShaderMeta {
        ShaderMeta {
            images: vec![],
            uniforms: UniformBlockLayout { uniforms: vec![] },
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod display_shader {
    use miniquad::*;

    pub const VERTEX: &str = r#"#version 100
    attribute vec2 in_pos;
    attribute vec2 in_uv;
    varying lowp vec2 uv;
    void main() {
        gl_Position = vec4(in_pos, 0.0, 1.0);
        uv = in_uv;
    }"#;

    pub const FRAGMENT: &str = r#"#version 100
    varying lowp vec2 uv;
    uniform sampler2D tex;
    void main() {
        gl_FragColor = texture2D(tex, uv);
    }"#;

    pub fn meta() -> ShaderMeta {
        ShaderMeta {
            images: vec!["tex".to_owned()],
            uniforms: UniformBlockLayout { uniforms: vec![] },
        }
    }
}
