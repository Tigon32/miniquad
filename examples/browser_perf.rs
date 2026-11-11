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
//!
//! `#![allow(unexpected_cfgs)]`: this file uses `--cfg miniquad_alloc_profile`
//! (an ad hoc rustc `--cfg`, not a Cargo `[features]` entry; see the
//! `alloc_profile` module doc) instead of editing the root `Cargo.toml`.
#![allow(unexpected_cfgs)]
use miniquad::*;

/// Benchmark-only allocation profiling for issue #14, compiled in only with
/// `RUSTFLAGS="--cfg miniquad_alloc_profile"` (a rustc `--cfg`, not a Cargo
/// feature: the root `Cargo.toml` is out of scope for this change, so this
/// cannot be a `[features]` entry without a parent edit; a maintainer can
/// promote it to a real Cargo feature later if useful). With no such
/// `--cfg`, this entire module and its `#[global_allocator]` are absent:
/// the build exposes zero `alloc_profile_*` exports (confirmed via
/// `WebAssembly.Module.exports`, see `docs/browser-profiling.md`) and
/// `std::alloc::System` is the default allocator, because no
/// `#[global_allocator]` is installed anywhere else in this crate. That is
/// a source-level non-presence guarantee, not a verified byte-identical
/// binary: rebuilding after unrelated source/doc edits elsewhere in this
/// file changes the default build's hash for reasons unrelated to this
/// module (normal codegen churn), so no byte-for-byte claim is made here.
///
/// The counting-allocator/churn/reuse core is `include!`-d from
/// `experiments/allocation-profile/src/core.rs` (see that file's module
/// doc for the full `unsafe` contract) rather than duplicated by hand, so
/// this module and the independently unit-tested experiment crate always
/// share the exact same allocator logic. `include!` splices source tokens
/// at compile time; it is not a Cargo dependency and needs no root
/// `Cargo.toml` edit.
#[cfg(miniquad_alloc_profile)]
mod alloc_profile {
    include!("../experiments/allocation-profile/src/core.rs");

    // One-shot snapshot taken at the end of `Stage::new()`, before the
    // first frame: a cold-start baseline, not a "steady phase" (startup
    // allocation is typically heavier and not representative of repeated
    // per-frame behavior; see the `current_*`/`reset_peak` exports below
    // for phase-scoped measurement).
    static INIT_ALLOC_CALLS: AtomicU64 = AtomicU64::new(0);
    static INIT_REALLOC_CALLS: AtomicU64 = AtomicU64::new(0);
    static INIT_DEALLOC_CALLS: AtomicU64 = AtomicU64::new(0);
    static INIT_LIVE_BYTES: AtomicI64 = AtomicI64::new(0);
    static INIT_PEAK_BYTES: AtomicU64 = AtomicU64::new(0);

    // Result of the one-shot self-test run from `mark_init_done`: 1 = pass,
    // 0 = fail, -1 = not yet run. Exported so the harness can assert on it
    // without trusting unexported internal state.
    static SELFTEST_RESULT: AtomicI64 = AtomicI64::new(-1);

    /// Isolated, self-contained proof, run once during init: a known
    /// allocator call is detected (churn allocates once per frame), a
    /// no-op control is exactly zero, and repeated reuse of one buffer
    /// produces the identical functional output as repeated churn while
    /// making strictly fewer allocation calls. Never changes production
    /// behavior: `stress_vertices` in `Stage` is untouched; this exercises
    /// only `churn_frame`/`reuse_frame` from the shared `core.rs`.
    fn run_selftest() -> bool {
        // No-op control: a read-only snapshot pair with no allocation
        // between them must show exactly zero of everything.
        let before_noop = (
            ALLOC_CALLS.load(Ordering::Relaxed),
            DEALLOC_CALLS.load(Ordering::Relaxed),
        );
        let after_noop = (
            ALLOC_CALLS.load(Ordering::Relaxed),
            DEALLOC_CALLS.load(Ordering::Relaxed),
        );
        if before_noop != after_noop {
            return false;
        }

        const FRAMES: usize = 8;
        const COUNT: usize = 32;
        const SEED: u64 = 7;
        let mut churn_checksums = [0f32; FRAMES];
        let mut reuse_checksums = [0f32; FRAMES];

        let before_churn = ALLOC_CALLS.load(Ordering::Relaxed);
        for (frame, slot) in churn_checksums.iter_mut().enumerate() {
            let output = churn_frame(COUNT, SEED + frame as u64);
            *slot = checksum(&output);
        }
        let churn_allocs = ALLOC_CALLS.load(Ordering::Relaxed) - before_churn;

        let mut scratch = Vec::new();
        let before_reuse = ALLOC_CALLS.load(Ordering::Relaxed);
        for (frame, slot) in reuse_checksums.iter_mut().enumerate() {
            reuse_frame(&mut scratch, COUNT, SEED + frame as u64);
            *slot = checksum(&scratch);
        }
        let reuse_allocs = ALLOC_CALLS.load(Ordering::Relaxed) - before_reuse;

        churn_checksums == reuse_checksums // same functional output ...
            && churn_allocs == FRAMES as u64 // ... one real alloc call per churn frame ...
            && reuse_allocs <= 1 // ... and at most one alloc call total for reuse.
    }

    /// Call once, at the end of `Stage::new()`: runs the self-test and
    /// snapshots every counter as the cold-start baseline.
    pub fn mark_init_done() {
        let pass = run_selftest();
        SELFTEST_RESULT.store(if pass { 1 } else { 0 }, Ordering::Relaxed);
        INIT_ALLOC_CALLS.store(ALLOC_CALLS.load(Ordering::Relaxed), Ordering::Relaxed);
        INIT_REALLOC_CALLS.store(REALLOC_CALLS.load(Ordering::Relaxed), Ordering::Relaxed);
        INIT_DEALLOC_CALLS.store(DEALLOC_CALLS.load(Ordering::Relaxed), Ordering::Relaxed);
        INIT_LIVE_BYTES.store(LIVE_BYTES.load(Ordering::Relaxed), Ordering::Relaxed);
        INIT_PEAK_BYTES.store(PEAK_BYTES.load(Ordering::Relaxed), Ordering::Relaxed);
    }

    macro_rules! export_getter {
        ($export_name:ident, $atomic:expr, $cast:ty) => {
            #[no_mangle]
            pub extern "C" fn $export_name() -> i64 {
                $atomic.load(Ordering::Relaxed) as $cast as i64
            }
        };
    }
    // Absolute, point-in-time readings (never a diff of two watermarks):
    // `current_peak_bytes` is the process-wide maximum live-byte total
    // since the last `alloc_profile_reset_peak()` call (or process start,
    // if never reset).
    export_getter!(alloc_profile_current_alloc_calls, ALLOC_CALLS, u64);
    export_getter!(alloc_profile_current_realloc_calls, REALLOC_CALLS, u64);
    export_getter!(alloc_profile_current_dealloc_calls, DEALLOC_CALLS, u64);
    export_getter!(alloc_profile_current_live_bytes, LIVE_BYTES, i64);
    export_getter!(alloc_profile_current_peak_bytes, PEAK_BYTES, u64);
    export_getter!(alloc_profile_init_alloc_calls, INIT_ALLOC_CALLS, u64);
    export_getter!(alloc_profile_init_realloc_calls, INIT_REALLOC_CALLS, u64);
    export_getter!(alloc_profile_init_dealloc_calls, INIT_DEALLOC_CALLS, u64);
    export_getter!(alloc_profile_init_live_bytes, INIT_LIVE_BYTES, i64);
    export_getter!(alloc_profile_init_peak_bytes, INIT_PEAK_BYTES, u64);
    export_getter!(alloc_profile_selftest_result, SELFTEST_RESULT, i64);

    #[no_mangle]
    pub extern "C" fn alloc_profile_available() -> i32 {
        1
    }

    /// Rebase the peak watermark to the current live total (see
    /// `core.rs::reset_peak`). A harness calls this at the start of each
    /// measured "steady phase" window so the next `current_peak_bytes`
    /// reading is an absolute "peak reached strictly within this window"
    /// figure, not the difference between two unrelated global watermarks.
    #[no_mangle]
    pub extern "C" fn alloc_profile_reset_peak() {
        reset_peak();
    }

    /// Texture-bind sequence mode for the upstream `#691` texture-cache
    /// within-pass counterfactual: 0 = bind `texture_a` four times in a
    /// row (A,A,A,A — expects 3 real cache hits), 1 = alternate (A,B,B,A
    /// — only the middle B,B repeat is expected to hit). Both sequences
    /// end on `texture_a`, so the frame's rendered pixel output is
    /// identical regardless of mode: a fair counterfactual, not a
    /// deliberate pixel change. Only read by `Stage::draw` under this same
    /// `cfg`, so it cannot affect the baseline/candidate timing builds,
    /// which never link this module.
    static BIND_MODE: AtomicI64 = AtomicI64::new(0);

    #[no_mangle]
    pub extern "C" fn alloc_profile_set_bind_mode(mode: i32) {
        BIND_MODE.store(mode as i64, Ordering::Relaxed);
    }

    /// Four-entry bind plan for one frame's draw: `true` = bind
    /// `texture_a`, `false` = bind `texture_b`.
    pub fn bind_sequence() -> [bool; 4] {
        if BIND_MODE.load(Ordering::Relaxed) == 1 {
            [true, false, false, true] // alternate: A, B, B, A
        } else {
            [true, true, true, true] // repeat: A, A, A, A
        }
    }

    /// One-shot trigger for the `#691` delete/recreate/rebind
    /// counterfactual (`GlCache::forget_texture`, `src/graphics/gl/
    /// cache.rs`): set by the harness, consumed (cleared) by the next
    /// `Stage::draw` call. Deliberately a one-shot flag, not a persistent
    /// mode, because delete+recreate is a single event, not a per-frame
    /// steady-state pattern.
    static DELETE_RECREATE_REQUESTED: AtomicI64 = AtomicI64::new(0);
    /// Frame index at which the delete/recreate/rebind sequence actually
    /// ran, or -1 if it has not run yet. Exported so a harness can confirm
    /// the one-shot request was consumed instead of silently missed (for
    /// example, if it arrived after the frame that would have consumed
    /// it).
    static DELETE_RECREATE_APPLIED_AT_FRAME: AtomicI64 = AtomicI64::new(-1);

    #[no_mangle]
    pub extern "C" fn alloc_profile_request_delete_recreate() {
        DELETE_RECREATE_REQUESTED.store(1, Ordering::Relaxed);
    }

    export_getter!(
        alloc_profile_delete_recreate_applied_at_frame,
        DELETE_RECREATE_APPLIED_AT_FRAME,
        i64
    );

    /// Read-and-clear: `true` at most once per `alloc_profile_request_
    /// delete_recreate()` call.
    pub fn take_delete_recreate_request() -> bool {
        DELETE_RECREATE_REQUESTED.swap(0, Ordering::Relaxed) == 1
    }

    pub fn mark_delete_recreate_applied(frame_index: u64) {
        DELETE_RECREATE_APPLIED_AT_FRAME.store(frame_index as i64, Ordering::Relaxed);
    }
}

#[cfg(miniquad_alloc_profile)]
#[global_allocator]
static ALLOC_PROFILE_ALLOCATOR: alloc_profile::CountingAllocator =
    alloc_profile::CountingAllocator::new();

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
        Vertex {
            pos: Vec2 {
                x: -0.5 + dx,
                y: -0.5 + dy,
            },
            uv: Vec2 { x: 0., y: 0. },
        },
        Vertex {
            pos: Vec2 {
                x: 0.5 + dx,
                y: -0.5 + dy,
            },
            uv: Vec2 { x: 1., y: 0. },
        },
        Vertex {
            pos: Vec2 {
                x: 0.5 + dx,
                y: 0.5 + dy,
            },
            uv: Vec2 { x: 1., y: 1. },
        },
        Vertex {
            pos: Vec2 {
                x: -0.5 + dx,
                y: 0.5 + dy,
            },
            uv: Vec2 { x: 0., y: 1. },
        },
    ]
}

fn stress_vertices(count: usize, seed: u64) -> Vec<Vertex> {
    (0..count)
        .map(|i| {
            let v = ((seed.wrapping_add(i as u64)) % 1000) as f32 / 1000.0;
            Vertex {
                pos: Vec2 { x: v, y: v },
                uv: Vec2 { x: v, y: 1.0 - v },
            }
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

        #[cfg(miniquad_alloc_profile)]
        alloc_profile::mark_init_done();

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

/// Upstream `#691` (`GlCache`/`forget_texture`, `src/graphics/gl/cache.rs`)
/// counterfactuals, compiled in only under `miniquad_alloc_profile`. Never
/// reached by the baseline/candidate timing builds.
#[cfg(miniquad_alloc_profile)]
impl Stage {
    fn apply_alloc_profile_bindings(&mut self) {
        if alloc_profile::take_delete_recreate_request() {
            // One-shot bind -> delete -> create -> rebind probe. Real GL
            // may or may not reuse texture_a's freed numeric name for the
            // new texture (driver/browser-dependent, not controlled by
            // this fixture): a real bindTexture call recorded for the new
            // texture here is consistent with `forget_texture` correctly
            // invalidating the cache slot on delete, but is not
            // deterministic proof of the specific name-reuse collision
            // scenario `forget_texture` exists to guard against. See
            // `docs/browser-profiling.md`'s upstream-investigation section
            // for the full caveat; never cite this alone as proof of
            // `forget_texture`'s behavior.
            self.bindings.images[0] = self.texture_a;
            self.ctx.apply_bindings(&self.bindings);
            self.ctx.delete_texture(self.texture_a);
            self.texture_a = self.ctx.new_texture_from_rgba8(
                4,
                4,
                &checkerboard([255, 255, 255, 255], [255, 0, 0, 255]),
            );
            self.bindings.images[0] = self.texture_a;
            self.ctx.apply_bindings(&self.bindings);
            alloc_profile::mark_delete_recreate_applied(self.frame_index);
            return;
        }
        // Within-pass sequence: 4 `apply_bindings` calls before the single
        // final `draw` below, so a real cache hit (`GlCache::bind_texture`'s
        // dedup: same slot/target/texture => no real `glBindTexture`) is
        // actually reached within one uncommitted pass -- never exercised
        // by a single-bind-per-frame structure. Repeat mode (A,A,A,A) and
        // alternate mode (A,B,B,A) both end on `texture_a`, so the frame's
        // rendered pixel output is identical between modes: a fair
        // counterfactual on bind *counts*, not a pixel-content change.
        for bind_a in alloc_profile::bind_sequence() {
            self.bindings.images[0] = if bind_a {
                self.texture_a
            } else {
                self.texture_b
            };
            self.ctx.apply_bindings(&self.bindings);
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

        // Alternating textures: rebind every frame, no re-upload. This is
        // the fixture's unchanged default for every build, including the
        // baseline/candidate timing pairs. Untouched by the
        // `miniquad_alloc_profile`-only counterfactuals below.
        #[cfg(not(miniquad_alloc_profile))]
        {
            self.bindings.images[0] = if self.frame_index % 2 == 0 {
                self.texture_a
            } else {
                self.texture_b
            };
        }

        self.ctx.begin_default_pass(Default::default());
        self.ctx.apply_pipeline(&self.pipeline);
        #[cfg(not(miniquad_alloc_profile))]
        self.ctx.apply_bindings(&self.bindings);
        #[cfg(miniquad_alloc_profile)]
        self.apply_alloc_profile_bindings();
        self.ctx
            .apply_uniforms(UniformsSource::table(&shader::Uniforms {
                offset: (0.0, 0.0),
            }));
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
