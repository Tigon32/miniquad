//! Minimal Miniquad browser starter application.
//!
//! This file draws one animated quad. It owns a small, optional
//! "app parameters" export surface. The surface is not part of the
//! Miniquad core ABI. A host page can call it through the embedding
//! module `miniquad.mjs` and its `setParameters` function.
//!
//! Parameter IDs (stable for this starter):
//!   - `mq_param_set_f32(1, value)`   sets animation speed, range 0..2.
//!   - `mq_param_set_rgba8(1, color)` sets the foreground tint color.
//!   - `mq_param_set_rgba8(2, color)` sets the clear (background) color.
//!
//! `color` is an unsigned 32-bit value packed as `0xRRGGBBAA`,
//! straight alpha, sRGB channel bytes. Each function returns `0` on
//! success. A nonzero return rejects the call; state does not change.

use miniquad::*;
use std::sync::atomic::{AtomicU32, Ordering};

/// Version of the optional app-parameters surface. Bump this constant
/// only when a caller must change its decoding logic.
const PARAMS_VERSION: u32 = 1;

/// Default animation speed multiplier (1.0 = original speed).
const DEFAULT_SPEED_BITS: u32 = 0x3F80_0000; // f32::to_bits(1.0)
/// Default foreground tint: opaque white.
const DEFAULT_FOREGROUND: u32 = 0xFFFFFFFF;
/// Default background clear color: opaque near-black.
const DEFAULT_BACKGROUND: u32 = 0x10_10_18_FF;

static SPEED_BITS: AtomicU32 = AtomicU32::new(DEFAULT_SPEED_BITS);
static FOREGROUND_RGBA8: AtomicU32 = AtomicU32::new(DEFAULT_FOREGROUND);
static BACKGROUND_RGBA8: AtomicU32 = AtomicU32::new(DEFAULT_BACKGROUND);

/// Reports the app-parameters surface version. A host reads this once
/// after startup to decide whether `setParameters` calls are safe.
#[no_mangle]
pub extern "C" fn mq_params_version() -> u32 {
    PARAMS_VERSION
}

/// Sets a float parameter. `id` 1 is animation speed, range `0..=2`.
/// Returns `0` on success, `1` for a non-finite or out-of-range value,
/// `2` for an unknown `id`.
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

/// Sets a packed `0xRRGGBBAA` color parameter. `id` 1 is the quad
/// foreground tint, `id` 2 is the background clear color. Returns `0`
/// on success, `2` for an unknown `id`.
#[no_mangle]
pub extern "C" fn mq_param_set_rgba8(id: u32, color: u32) -> i32 {
    match id {
        1 => {
            FOREGROUND_RGBA8.store(color, Ordering::Relaxed);
            0
        }
        2 => {
            BACKGROUND_RGBA8.store(color, Ordering::Relaxed);
            0
        }
        _ => 2,
    }
}

/// Unpacks a `0xRRGGBBAA` color into straight-alpha float channels in
/// range `0..=1`.
fn unpack_rgba8(packed: u32) -> [f32; 4] {
    let r = ((packed >> 24) & 0xFF) as f32 / 255.0;
    let g = ((packed >> 16) & 0xFF) as f32 / 255.0;
    let b = ((packed >> 8) & 0xFF) as f32 / 255.0;
    let a = (packed & 0xFF) as f32 / 255.0;
    [r, g, b, a]
}

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

struct Stage {
    ctx: Box<dyn RenderingBackend>,
    pipeline: Pipeline,
    bindings: Bindings,
}

impl Stage {
    pub fn new() -> Stage {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();

        #[rustfmt::skip]
        let vertices: [Vertex; 4] = [
            Vertex { pos: Vec2 { x: -0.5, y: -0.5 }, uv: Vec2 { x: 0., y: 0. } },
            Vertex { pos: Vec2 { x:  0.5, y: -0.5 }, uv: Vec2 { x: 1., y: 0. } },
            Vertex { pos: Vec2 { x:  0.5, y:  0.5 }, uv: Vec2 { x: 1., y: 1. } },
            Vertex { pos: Vec2 { x: -0.5, y:  0.5 }, uv: Vec2 { x: 0., y: 1. } },
        ];
        let vertex_buffer = ctx.new_buffer(
            BufferType::VertexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&vertices),
        );

        let indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
        let index_buffer = ctx.new_buffer(
            BufferType::IndexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&indices),
        );

        // One flat white pixel. The fragment shader multiplies it by
        // the foreground parameter, so the quad shows that color.
        let pixels: [u8; 4] = [0xFF, 0xFF, 0xFF, 0xFF];
        let texture = ctx.new_texture_from_rgba8(1, 1, &pixels);

        let bindings = Bindings {
            vertex_buffers: vec![vertex_buffer],
            index_buffer,
            images: vec![texture],
        };

        let shader = ctx
            .new_shader(
                match ctx.info().backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: shader::VERTEX,
                        fragment: shader::FRAGMENT,
                    },
                    Backend::Metal => ShaderSource::Msl {
                        program: shader::METAL,
                    },
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
            pipeline,
            bindings,
            ctx,
        }
    }
}

impl EventHandler for Stage {
    fn update(&mut self) {}

    fn draw(&mut self) {
        let speed = f32::from_bits(SPEED_BITS.load(Ordering::Relaxed));
        let foreground = unpack_rgba8(FOREGROUND_RGBA8.load(Ordering::Relaxed));
        let background = unpack_rgba8(BACKGROUND_RGBA8.load(Ordering::Relaxed));

        let t = date::now() * speed as f64;

        self.ctx.begin_default_pass(PassAction::clear_color(
            background[0],
            background[1],
            background[2],
            background[3],
        ));

        self.ctx.apply_pipeline(&self.pipeline);
        self.ctx.apply_bindings(&self.bindings);
        self.ctx
            .apply_uniforms(UniformsSource::table(&shader::Uniforms {
                offset: (t.sin() as f32 * 0.4, (t * 1.3).cos() as f32 * 0.4),
                tint: foreground,
            }));
        self.ctx.draw(0, 6, 1);
        self.ctx.end_render_pass();

        self.ctx.commit_frame();
    }
}

fn main() {
    let conf = conf::Conf::default();
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
    uniform lowp vec4 tint;

    void main() {
        gl_FragColor = texture2D(tex, texcoord) * tint;
    }"#;

    pub const METAL: &str = r#"
    #include <metal_stdlib>

    using namespace metal;

    struct Uniforms
    {
        float2 offset;
        float4 tint;
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

    fragment float4 fragmentShader(RasterizerData in [[stage_in]], constant Uniforms& uniforms [[buffer(0)]], texture2d<float> tex [[texture(0)]], sampler texSmplr [[sampler(0)]])
    {
        return tex.sample(texSmplr, in.uv) * uniforms.tint;
    }"#;

    pub fn meta() -> ShaderMeta {
        ShaderMeta {
            images: vec!["tex".to_string()],
            uniforms: UniformBlockLayout {
                uniforms: vec![
                    UniformDesc::new("offset", UniformType::Float2),
                    UniformDesc::new("tint", UniformType::Float4),
                ],
            },
        }
    }

    #[repr(C)]
    pub struct Uniforms {
        pub offset: (f32, f32),
        pub tint: [f32; 4],
    }
}
