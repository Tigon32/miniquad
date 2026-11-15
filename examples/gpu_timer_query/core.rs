// Shared `Stage`/`EventHandler` core for the issue #145 GPU timer-query
// acceptance test. `include!`-d by `gpu_timer_query_webgl1.rs` and
// `gpu_timer_query_webgl2.rs` (same pattern as `examples/browser_perf.rs`'s
// `alloc_profile` module), so the two context-specific example binaries
// share one timer-query lifecycle and differ only in `conf.platform.webgl_version`.
//
// This file is not a standalone example; it has no `fn main`. The two
// entry files supply `main` and set the WebGL version before calling
// `miniquad::start`.
//
// Status codes exported to the Playwright harness via
// `gpu_timer_query_status()`, matching MADR 0023's `ElapsedQueryError`
// states plus a timeout guard the harness needs so a stalled query does
// not hang the test:
#[repr(i32)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum HarnessStatus {
    /// The query is running or waiting for a result; poll again.
    Pending = 0,
    /// `ElapsedQuery::is_supported` reported `false` for the active backend
    /// or context; this is the explicit non-panic unsupported path.
    Unsupported = 1,
    /// The browser reported `GPU_DISJOINT_EXT` while the query ran.
    Disjoint = 2,
    /// A real, nonzero-or-zero measured result is ready; read it with
    /// `gpu_timer_query_result_lo`/`gpu_timer_query_result_hi`.
    Ready = 3,
    /// No result became available within `TIMEOUT_FRAMES`; the harness
    /// must report this as blocked, not as a measured zero.
    Timeout = 4,
}

/// Generous bound for a browser frame loop; real hardware timer queries
/// usually resolve within a handful of frames.
const TIMEOUT_FRAMES: u32 = 600;

enum QueryPhase {
    NotStarted,
    Running { frames_waited: u32 },
    Done,
}

struct Stage {
    ctx: Box<dyn RenderingBackend>,
    pipeline: Pipeline,
    bindings: Bindings,
    backend: Backend,
    supported: bool,
    query: ElapsedQuery,
    phase: QueryPhase,
    status: HarnessStatus,
    result: u64,
}

impl Stage {
    pub fn new() -> Stage {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();
        let backend = ctx.info().backend;
        let supported = ElapsedQuery::is_supported(backend);

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

        #[rustfmt::skip]
        let vertices: [Vertex; 4] = [
            Vertex { pos : Vec2 { x: -0.5, y: -0.5 }, uv: Vec2 { x: 0., y: 0. } },
            Vertex { pos : Vec2 { x:  0.5, y: -0.5 }, uv: Vec2 { x: 1., y: 0. } },
            Vertex { pos : Vec2 { x:  0.5, y:  0.5 }, uv: Vec2 { x: 1., y: 1. } },
            Vertex { pos : Vec2 { x: -0.5, y:  0.5 }, uv: Vec2 { x: 0., y: 1. } },
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

        let pixels: [u8; 4 * 4 * 4] = [0xFF; 64];
        let texture = ctx.new_texture_from_rgba8(4, 4, &pixels);

        let bindings = Bindings {
            vertex_buffers: vec![vertex_buffer],
            index_buffer,
            images: vec![texture],
        };

        let shader = ctx
            .new_shader(
                match backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: gpu_timer_shader::VERTEX,
                        fragment: gpu_timer_shader::FRAGMENT,
                    },
                    Backend::Metal => ShaderSource::Msl {
                        program: gpu_timer_shader::METAL,
                    },
                },
                gpu_timer_shader::meta(),
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
            backend,
            supported,
            query: ElapsedQuery::new(),
            phase: QueryPhase::NotStarted,
            status: if supported {
                HarnessStatus::Pending
            } else {
                HarnessStatus::Unsupported
            },
            result: 0,
        }
    }
}

impl EventHandler for Stage {
    fn update(&mut self) {}

    fn draw(&mut self) {
        self.ctx.begin_default_pass(Default::default());

        if self.supported {
            if let QueryPhase::NotStarted = self.phase {
                self.query.begin_query(self.backend);
            }
        }

        self.ctx.apply_pipeline(&self.pipeline);
        self.ctx.apply_bindings(&self.bindings);
        // Repeat the draw call so the spanned GPU work is large enough for
        // a timer query to resolve a measurable, real nonzero duration.
        for i in 0..200 {
            let t = i as f32 * 0.01;
            self.ctx
                .apply_uniforms(UniformsSource::table(&gpu_timer_shader::Uniforms {
                    offset: (t.sin() * 0.5, (t * 3.).cos() * 0.5),
                }));
            self.ctx.draw(0, 6, 1);
        }

        if self.supported {
            if let QueryPhase::NotStarted = self.phase {
                self.query.end_query(self.backend);
                self.phase = QueryPhase::Running { frames_waited: 0 };
            }
        }

        self.ctx.end_render_pass();
        self.ctx.commit_frame();

        if self.supported {
            if let QueryPhase::Running { frames_waited } = self.phase {
                match self.query.is_available(self.backend) {
                    Ok(true) => match self.query.get_result(self.backend) {
                        Ok(value) => {
                            self.result = value;
                            self.status = HarnessStatus::Ready;
                            self.phase = QueryPhase::Done;
                        }
                        Err(ElapsedQueryError::Disjoint) => {
                            self.status = HarnessStatus::Disjoint;
                            self.phase = QueryPhase::Done;
                        }
                        Err(_) => {
                            // Unsupported/NotReady cannot happen here: this
                            // branch already confirmed `is_available` gave
                            // `Ok(true)` on a supported backend.
                            self.status = HarnessStatus::Timeout;
                            self.phase = QueryPhase::Done;
                        }
                    },
                    Ok(false) => {
                        if frames_waited + 1 >= TIMEOUT_FRAMES {
                            self.status = HarnessStatus::Timeout;
                            self.phase = QueryPhase::Done;
                        } else {
                            self.phase = QueryPhase::Running {
                                frames_waited: frames_waited + 1,
                            };
                        }
                    }
                    Err(ElapsedQueryError::Disjoint) => {
                        self.status = HarnessStatus::Disjoint;
                        self.phase = QueryPhase::Done;
                    }
                    Err(_) => {
                        self.status = HarnessStatus::Unsupported;
                        self.phase = QueryPhase::Done;
                    }
                }
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn gpu_timer_query_status() -> i32 {
    // Safety note: this reads a value last written on the main/render
    // thread's own frame callback; the WASM target this example builds for
    // is single-threaded, so no synchronization is needed here.
    unsafe { STAGE_STATUS }
}

#[no_mangle]
pub extern "C" fn gpu_timer_query_result_lo() -> u32 {
    unsafe { (STAGE_RESULT & 0xFFFF_FFFF) as u32 }
}

#[no_mangle]
pub extern "C" fn gpu_timer_query_result_hi() -> u32 {
    unsafe { (STAGE_RESULT >> 32) as u32 }
}

static mut STAGE_STATUS: i32 = HarnessStatus::Pending as i32;
static mut STAGE_RESULT: u64 = 0;

/// Mirrors `Stage`'s private status/result into the exported statics above
/// once per frame. A thin wrapper keeps `Stage`'s `EventHandler` impl free
/// of export bookkeeping.
struct ExportingStage(Stage);

impl EventHandler for ExportingStage {
    fn update(&mut self) {
        self.0.update();
    }

    fn draw(&mut self) {
        self.0.draw();
        unsafe {
            STAGE_STATUS = self.0.status as i32;
            STAGE_RESULT = self.0.result;
        }
    }
}

mod gpu_timer_shader {
    use miniquad::*;

    pub const VERTEX: &str = r#"#version 100
    attribute vec2 in_pos;
    attribute vec2 in_uv;

    varying lowp vec2 texcoord;

    uniform vec2 offset;

    void main() {
        gl_Position = vec4(in_pos + offset, 0, 1);
        texcoord = in_uv;
    }
    "#;

    pub const FRAGMENT: &str = r#"#version 100
    varying lowp vec2 texcoord;

    uniform sampler2D tex;

    void main() {
        gl_FragColor = texture2D(tex, texcoord);
    }
    "#;

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
