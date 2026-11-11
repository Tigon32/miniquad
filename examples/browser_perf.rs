//! Fixed measurement workload for issue #14 (browser profiling).
//!
//! This fixture is not a game. It runs a deterministic, frame-counter-driven
//! sequence of `buffer_update` calls and alternating texture binds so a
//! browser harness can record real WebGL upload counts/bytes, draw/bind
//! counts, and CPU frame duration, and compare two source-identical builds
//! (baseline vs a `RUSTFLAGS` codegen candidate) for parity and timing.
//!
//! Determinism: animation state advances from an internal frame counter,
//! never from wall-clock time, so repeated runs render the same pixels at
//! the same frame index. See docs/browser-profiling.md for exact semantics.
use miniquad::*;

#[repr(C)]
struct Vec2 {
    x: f32,
    y: f32,
}
#[repr(C)]
struct Vertex {
    pos: Vec2,
    uv: Vec2,
}

/// Known byte count of one `Vertex`: 4 * f32 = 16 bytes.
const VERTEX_SIZE: usize = std::mem::size_of::<Vertex>();
/// Known byte count of the draw-bound vertex buffer: 4 vertices * 16 bytes = 64 bytes.
const QUAD_BYTES: usize = 4 * VERTEX_SIZE;
/// Stress buffer capacity: 64 vertices * 16 bytes = 1024 bytes allocated once.
const STRESS_CAPACITY_VERTICES: usize = 64;
const STRESS_CAPACITY_BYTES: usize = STRESS_CAPACITY_VERTICES * VERTEX_SIZE;
/// Per-frame stress sub-upload sizes in vertices: 4, 16 and 32 (<= capacity).
/// Each reuses the same allocated buffer via `buffer_update`, never a new buffer.
const STRESS_SUB_UPLOADS_VERTICES: [usize; 3] = [4, 16, 32];

fn quad_vertices(frame_index: u64) -> [Vertex; 4] {
    // Pure function of the frame counter: bit-reproducible across runs.
    let phase = (frame_index % 240) as f32 * (std::f32::consts::PI / 120.0);
    let dx = phase.sin() * 0.2;
    let dy = (phase * 1.5).cos() * 0.2;
    [
        Vertex { pos: Vec2 { x: -0.5 + dx, y: -0.5 + dy }, uv: Vec2 { x: 0., y: 0. } },
        Vertex { pos: Vec2 { x: 0.5 + dx, y: -0.5 + dy }, uv: Vec2 { x: 1., y: 0. } },
        Vertex { pos: Vec2 { x: 0.5 + dx, y: 0.5 + dy }, uv: Vec2 { x: 1., y: 1. } },
        Vertex { pos: Vec2 { x: -0.5 + dx, y: 0.5 + dy }, uv: Vec2 { x: 0., y: 1. } },
    ]
}

fn stress_vertices(count: usize, seed: u64) -> Vec<Vertex> {
    (0..count)
        .map(|i| {
            let v = ((seed.wrapping_add(i as u64)) % 1000) as f32 / 1000.0;
            Vertex { pos: Vec2 { x: v, y: v }, uv: Vec2 { x: v, y: 1.0 - v } }
        })
        .collect()
}

struct Stage {
    ctx: Box<dyn RenderingBackend>,
    pipeline: Pipeline,
    bindings: Bindings,
    vertex_buffer: BufferId,
    stress_buffer: BufferId,
    texture_a: TextureId,
    texture_b: TextureId,
    frame_index: u64,
}

fn checkerboard(c1: [u8; 4], c2: [u8; 4]) -> [u8; 4 * 4 * 4] {
    let mut out = [0u8; 4 * 4 * 4];
    for y in 0..4 {
        for x in 0..4 {
            let c = if (x + y) % 2 == 0 { c1 } else { c2 };
            let o = (y * 4 + x) * 4;
            out[o..o + 4].copy_from_slice(&c);
        }
    }
    out
}

impl Stage {
    pub fn new() -> Stage {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();

        let vertex_buffer = ctx.new_buffer(
            BufferType::VertexBuffer,
            BufferUsage::Dynamic,
            BufferSource::empty::<Vertex>(4),
        );
        ctx.buffer_update(vertex_buffer, BufferSource::slice(&quad_vertices(0)));

        let indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
        let index_buffer = ctx.new_buffer(
            BufferType::IndexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&indices),
        );

        // Allocated once; every frame reuses it with sub-uploads of known byte counts.
        let stress_buffer = ctx.new_buffer(
            BufferType::VertexBuffer,
            BufferUsage::Dynamic,
            BufferSource::empty::<Vertex>(STRESS_CAPACITY_VERTICES),
        );

        let texture_a =
            ctx.new_texture_from_rgba8(4, 4, &checkerboard([255, 255, 255, 255], [255, 0, 0, 255]));
        let texture_b =
            ctx.new_texture_from_rgba8(4, 4, &checkerboard([0, 0, 255, 255], [0, 255, 0, 255]));

        let bindings = Bindings {
            vertex_buffers: vec![vertex_buffer],
            index_buffer,
            images: vec![texture_a],
        };

        let shader = ctx
            .new_shader(
                match ctx.info().backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: shader::VERTEX,
                        fragment: shader::FRAGMENT,
                    },
                    Backend::Metal => ShaderSource::Msl { program: shader::METAL },
                },
                shader::meta(),
            )
            .unwrap();

        let pipeline = ctx.new_pipeline(
            &[BufferLayout::default()],
            &[
                VertexAttribute::new("in_pos", VertexFormat::Float2),
                VertexAttribute::new("in_uv", VertexFormat::Float2),
            ],
            shader,
            PipelineParams::default(),
        );

        Stage {
            ctx,
            pipeline,
            bindings,
            vertex_buffer,
            stress_buffer,
            texture_a,
            texture_b,
            frame_index: 0,
        }
    }
}

impl EventHandler for Stage {
    fn update(&mut self) {}

    fn draw(&mut self) {
        // Dynamic buffer upload: full 64-byte rewrite of the draw-bound buffer.
        self.ctx.buffer_update(
            self.vertex_buffer,
            BufferSource::slice(&quad_vertices(self.frame_index)),
        );
        debug_assert_eq!(
            self.ctx.buffer_size(self.vertex_buffer),
            QUAD_BYTES,
            "quad vertex buffer must stay at its allocated 64-byte size"
        );

        // Upload stress run: reuse the same allocated buffer with sub-uploads.
        // Each size is <= STRESS_CAPACITY_BYTES, per buffer_update's contract.
        for (i, count) in STRESS_SUB_UPLOADS_VERTICES.iter().enumerate() {
            let data = stress_vertices(*count, self.frame_index.wrapping_add(i as u64));
            debug_assert!(count * VERTEX_SIZE <= STRESS_CAPACITY_BYTES);
            self.ctx
                .buffer_update(self.stress_buffer, BufferSource::slice(&data));
        }

        // Alternating textures: rebind every frame, no re-upload.
        self.bindings.images[0] = if self.frame_index % 2 == 0 {
            self.texture_a
        } else {
            self.texture_b
        };

        self.ctx.begin_default_pass(Default::default());
        self.ctx.apply_pipeline(&self.pipeline);
        self.ctx.apply_bindings(&self.bindings);
        self.ctx
            .apply_uniforms(UniformsSource::table(&shader::Uniforms { offset: (0.0, 0.0) }));
        self.ctx.draw(0, 6, 1);
        self.ctx.end_render_pass();

        self.ctx.commit_frame();
        self.frame_index = self.frame_index.wrapping_add(1);
    }
}

fn main() {
    let mut conf = conf::Conf::default();
    let metal = std::env::args().nth(1).as_deref() == Some("metal");
    conf.platform.apple_gfx_api = if metal {
        conf::AppleGfxApi::Metal
    } else {
        conf::AppleGfxApi::OpenGl
    };

    miniquad::start(conf, move || Box::new(Stage::new()));
}

mod shader {
    use miniquad::*;

    pub const VERTEX: &str = r#"#version 100
    attribute vec2 in_pos;
    attribute vec2 in_uv;

    uniform vec2 offset;

    varying lowp vec2 texcoord;

    void main() {
        gl_Position = vec4(in_pos + offset, 0, 1);
        texcoord = in_uv;
    }"#;

    pub const FRAGMENT: &str = r#"#version 100
    varying lowp vec2 texcoord;

    uniform sampler2D tex;

    void main() {
        gl_FragColor = texture2D(tex, texcoord);
    }"#;

    pub const METAL: &str = r#"
    #include <metal_stdlib>

    using namespace metal;

    struct Uniforms
    {
        float2 offset;
    };

    struct Vertex
    {
        float2 in_pos   [[attribute(0)]];
        float2 in_uv    [[attribute(1)]];
    };

    struct RasterizerData
    {
        float4 position [[position]];
        float2 uv       [[user(locn0)]];
    };

    vertex RasterizerData vertexShader(
      Vertex v [[stage_in]],
      constant Uniforms& uniforms [[buffer(0)]])
    {
        RasterizerData out;

        out.position = float4(v.in_pos.xy + uniforms.offset, 0.0, 1.0);
        out.uv = v.in_uv;

        return out;
    }

    fragment float4 fragmentShader(RasterizerData in [[stage_in]], texture2d<float> tex [[texture(0)]], sampler texSmplr [[sampler(0)]])
    {
        return tex.sample(texSmplr, in.uv);
    }"#;

    pub fn meta() -> ShaderMeta {
        ShaderMeta {
            images: vec!["tex".to_string()],
            uniforms: UniformBlockLayout {
                uniforms: vec![UniformDesc::new("offset", UniformType::Float2)],
            },
        }
    }

    #[repr(C)]
    pub struct Uniforms {
        pub offset: (f32, f32),
    }
}
