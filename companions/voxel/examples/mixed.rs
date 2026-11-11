//! Mixed-mode (mode B) voxel vertical slice: WASM-only rendering, plus
//! an optional native authoritative server over the bounded `VXP1`
//! protocol (`docs/architecture/voxel-protocol.md`).
//!
//! This example owns no network socket itself: per the protocol
//! contract, "the runtime frame WASM never calls the network". All
//! `fetch` traffic is the embedding host's job; this example only
//! exposes the bounded staging exports (`vx_net_*`, `vx_input`,
//! `vx_state_hash_lo/hi`, `vx_world_rev`, `vx_sprite_pixel`,
//! `vx_release_gpu`, `vx_resources_live`) that the host JS poller
//! (`companions/voxel/web/voxel-host.mjs`) copies bytes through.
//!
//! The rendered scene (terrain + sprite + camera) is intentionally
//! identical to `examples/offline.rs`, built from the same shared
//! [`miniquad_voxel::sim::Sim`] scene, so offline and mixed-mode
//! frames are comparable. The difference from `offline.rs` is that
//! edits reach the scene through [`miniquad_voxel::sim::Sim::apply`]
//! driven by the host network loop (mixed mode) or applied directly
//! (offline mode, before the first snapshot / while the host has no
//! transport), plus the in-frame seven-segment HUD described in
//! `miniquad_voxel::hud`.

use miniquad::*;
use miniquad_voxel::camera::OrbitCamera;
use miniquad_voxel::hud::{self, Geometry, Mode, Revision, Status};
use miniquad_voxel::math::{Mat4, Vec3};
use miniquad_voxel::mesh::{build_chunk_mesh, MeshBuffers, Vertex as VoxelVertex};
use miniquad_voxel::protocol;
use miniquad_voxel::sim::{Command, Sim, SCENE_CHUNK_COORDS, SCENE_CHUNK_DIMS};
use miniquad_voxel::terrain::PALETTE;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::Mutex;

// ---------------------------------------------------------------------
// Bounded staging buffers and mailbox (module statics; see the
// contract comment in docs/architecture/voxel-protocol.md: "No export
// stores a pointer to `Stage`.").
// ---------------------------------------------------------------------

/// `HEADER_LEN (24) + MAX_SERVER_BODY (16384)`: the largest frame the
/// client can ever receive.
const NET_BUF_LEN: usize = protocol::HEADER_LEN + protocol::MAX_SERVER_BODY;

static NET_IN_BUF: Mutex<[u8; NET_BUF_LEN]> = Mutex::new([0; NET_BUF_LEN]);
static NET_OUT_BUF: Mutex<[u8; NET_BUF_LEN]> = Mutex::new([0; NET_BUF_LEN]);

/// One decoded inbound frame, applied by `Stage::update`.
enum Inbound {
    Snapshot { rev: u32, snapshot: protocol::Snapshot },
    Delta { base_rev: u32, rev: u32, commands: Vec<Command> },
    Error(protocol::ErrorCode),
}

/// One-slot mailbox: `vx_net_in_commit` fills it, `Stage::update`
/// drains it. A full slot is never silently overwritten: the host
/// must wait for the previous frame to be applied.
static INBOUND_MAILBOX: Mutex<Option<Inbound>> = Mutex::new(None);

/// Whether the previous inbound frame has been applied to `Sim`, so
/// `vx_net_build_request` may build the next request. Starts `true`
/// (a `Hello` may be built immediately).
static INBOUND_APPLIED: AtomicBool = AtomicBool::new(true);

/// Queued local/mixed inputs, applied directly in offline mode, or
/// drained into the next `Inputs` request in mixed mode. Bounded at
/// `protocol::MAX_COMMANDS`.
static PENDING_INPUTS: Mutex<Vec<Command>> = Mutex::new(Vec::new());

/// Transport status for the HUD: 0 connecting, 1 online, 2 offline, 3
/// version error. Only meaningful once the host has called
/// `vx_net_set_status` at least once; the example starts in "local"
/// HUD mode until that happens (see `Stage::hud_state`).
static NET_STATUS: AtomicU8 = AtomicU8::new(0);
static NET_STATUS_SET: AtomicBool = AtomicBool::new(false);

/// Client request sequence and last-applied revision, per the
/// protocol's "sequence and revision rules".
static CLIENT_SEQ: AtomicU32 = AtomicU32::new(0);
static CLIENT_WORLD_ID: AtomicU32 = AtomicU32::new(0);
static HAVE_SNAPSHOT: AtomicBool = AtomicBool::new(false);

/// Explicit GPU release flag and live-resource counter. See
/// `docs/architecture/voxel-protocol.md`, "Release:".
static RELEASE_GPU: AtomicBool = AtomicBool::new(false);
static RESOURCES_LIVE: AtomicU32 = AtomicU32::new(0);

/// Shared simulation core. Behind a `Mutex` only because it is
/// touched from both `update` (apply) and the `vx_state_hash_lo/hi`
/// staging exports (read); there is exactly one WASM thread, so this
/// is for interior mutability discipline, not real concurrency.
static SIM: Mutex<Option<Sim>> = Mutex::new(None);

/// Sprite centre in canvas pixels, updated once per `draw`.
static SPRITE_PIXEL: AtomicU32 = AtomicU32::new(0);

/// The app-parameters surface version (matches
/// `templates/browser/rust/src/main.rs` and `examples/offline.rs`'s
/// contract), and the sprite animation speed it sets. This is a
/// purely local, host-side visual control, distinct from
/// `Command::SetSpeed` below: `mq_param_set_f32` only scales this
/// client's own sprite-bobbing animation rate, while a `SetSpeed`
/// input (`vx_input(2, ...)`) is a network command queued for the
/// *server's* authoritative `Sim`. The HUD/UI contract calls for a
/// host control that drives both at once.
const PARAMS_VERSION: u32 = 1;
const DEFAULT_SPEED_BITS: u32 = 0x3F80_0000; // f32::to_bits(1.0)
static SPEED_BITS: AtomicU32 = AtomicU32::new(DEFAULT_SPEED_BITS);

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

// ---------------------------------------------------------------------
// Staging exports
// ---------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn vx_net_in_ptr() -> *mut u8 {
    NET_IN_BUF.lock().unwrap().as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn vx_net_in_cap() -> u32 {
    NET_BUF_LEN as u32
}

/// Decodes the first `len` bytes of the inbound buffer into the
/// one-slot mailbox. Returns `0` ok, `1` invalid frame, `2` slot
/// full, `3` too long.
#[no_mangle]
pub extern "C" fn vx_net_in_commit(len: u32) -> i32 {
    let len = len as usize;
    if len > NET_BUF_LEN {
        return 3;
    }
    let mut mailbox = INBOUND_MAILBOX.lock().unwrap();
    if mailbox.is_some() {
        return 2;
    }
    let buf = NET_IN_BUF.lock().unwrap();
    let frame = &buf[..len];
    let (header, body) = match protocol::decode_header(frame) {
        Ok(v) => v,
        Err(_) => return 1,
    };
    let decoded = match header.kind {
        protocol::Kind::Snapshot => match protocol::decode_snapshot(body) {
            Ok(snapshot) => Inbound::Snapshot { rev: header.rev, snapshot },
            Err(_) => return 1,
        },
        protocol::Kind::Delta => match protocol::decode_delta(body) {
            Ok((base_rev, commands)) => Inbound::Delta { base_rev, rev: header.rev, commands },
            Err(_) => return 1,
        },
        protocol::Kind::Error => match protocol::decode_error(body) {
            Ok(code) => Inbound::Error(code),
            Err(_) => return 1,
        },
        _ => return 1,
    };
    *mailbox = Some(decoded);
    INBOUND_APPLIED.store(false, Ordering::Relaxed);
    0
}

/// Writes the next request (`Hello` or `Inputs`) into the outbound
/// buffer. Returns the written length, or `0` while the previous
/// inbound frame has not yet been applied (see `Stage::update`).
#[no_mangle]
pub extern "C" fn vx_net_build_request() -> u32 {
    if !INBOUND_APPLIED.load(Ordering::Relaxed) {
        return 0;
    }
    let mut out = NET_OUT_BUF.lock().unwrap();
    let world_id = CLIENT_WORLD_ID.load(Ordering::Relaxed);
    if !HAVE_SNAPSHOT.load(Ordering::Relaxed) {
        return protocol::encode_hello(&mut out[..], 0).map(|n| n as u32).unwrap_or(0);
    }
    let seq = CLIENT_SEQ.load(Ordering::Relaxed) + 1;
    let rev = SIM.lock().unwrap().as_ref().map(|s| s.rev()).unwrap_or(0);
    let mut pending = PENDING_INPUTS.lock().unwrap();
    let commands: Vec<Command> = pending.drain(..).collect();
    drop(pending);
    match protocol::encode_inputs(&mut out[..], world_id, seq, rev, &commands) {
        Ok(n) => {
            CLIENT_SEQ.store(seq, Ordering::Relaxed);
            n as u32
        }
        Err(_) => 0,
    }
}

#[no_mangle]
pub extern "C" fn vx_net_out_ptr() -> *const u8 {
    NET_OUT_BUF.lock().unwrap().as_ptr()
}

/// Sets the host transport state for the HUD. `0` connecting, `1`
/// online, `2` offline, `3` version error. Returns `0` on success, `1`
/// for an unknown code.
#[no_mangle]
pub extern "C" fn vx_net_set_status(code: u32) -> i32 {
    if code > 3 {
        return 1;
    }
    NET_STATUS.store(code as u8, Ordering::Relaxed);
    NET_STATUS_SET.store(true, Ordering::Relaxed);
    0
}

/// The same trace entry point in both modes. `op` 1 sets a voxel
/// (`id`, `x`, `y`, `z`), `op` 2 sets speed (`x` holds `milli`).
/// Offline mode applies the input in the next `update`. Mixed mode
/// queues it for the next `Inputs` request, up to
/// `protocol::MAX_COMMANDS`. Returns `0` ok, `1` unknown `op`, `2`
/// queue full (mixed mode only).
#[no_mangle]
pub extern "C" fn vx_input(op: u32, id: u32, x: i32, y: i32, z: i32) -> i32 {
    let command = match op {
        1 => Command::SetVoxel {
            x: x as i16,
            y: y as i16,
            z: z as i16,
            id: id as u8,
        },
        2 => Command::SetSpeed { milli: x as u16 },
        _ => return 1,
    };
    let mut pending = PENDING_INPUTS.lock().unwrap();
    if pending.len() >= protocol::MAX_COMMANDS {
        return 2;
    }
    pending.push(command);
    0
}

#[no_mangle]
pub extern "C" fn vx_state_hash_lo() -> u32 {
    let hash = SIM.lock().unwrap().as_ref().map(|s| s.state_hash()).unwrap_or(0);
    (hash & 0xFFFF_FFFF) as u32
}

#[no_mangle]
pub extern "C" fn vx_state_hash_hi() -> u32 {
    let hash = SIM.lock().unwrap().as_ref().map(|s| s.state_hash()).unwrap_or(0);
    (hash >> 32) as u32
}

#[no_mangle]
pub extern "C" fn vx_world_rev() -> u32 {
    SIM.lock().unwrap().as_ref().map(|s| s.rev()).unwrap_or(0)
}

/// Sprite centre in canvas pixels, packed as `x << 16 | y`.
#[no_mangle]
pub extern "C" fn vx_sprite_pixel() -> u32 {
    SPRITE_PIXEL.load(Ordering::Relaxed)
}

/// Sets the explicit GPU release flag. The next `draw` deletes all
/// GPU resources once, sets `resources_live` to `0`, and draws
/// nothing after that, even while the application is paused (the host
/// must call the runtime `resume()` once to service this).
#[no_mangle]
pub extern "C" fn vx_release_gpu() {
    RELEASE_GPU.store(true, Ordering::Relaxed);
}

#[no_mangle]
pub extern "C" fn vx_resources_live() -> u32 {
    RESOURCES_LIVE.load(Ordering::Relaxed)
}

/// Count of inputs discarded (not applied anywhere) while offline, for
/// host-visible metrics. Mirrors `voxel-host.mjs`'s
/// `discardedInputCount` on the JS side; this counts inputs discarded
/// on the Rust side if `vx_input` is ever called while the transport
/// is known offline and mixed-mode semantics require discarding
/// rather than queuing (left at the host's discretion today: the
/// current implementation always queues, and the host is the
/// authority on "server-offline edits reaching vx_input discarded").
static DISCARDED_INPUTS: AtomicU32 = AtomicU32::new(0);

#[no_mangle]
pub extern "C" fn vx_discarded_input_count() -> u32 {
    DISCARDED_INPUTS.load(Ordering::Relaxed)
}

fn hud_mode_and_status() -> (Mode, Status) {
    if !NET_STATUS_SET.load(Ordering::Relaxed) {
        return (Mode::Local, Status::None);
    }
    let status = match NET_STATUS.load(Ordering::Relaxed) {
        0 => Status::Connecting,
        1 => Status::Online,
        2 => Status::Offline,
        3 => Status::VersionError,
        _ => Status::None,
    };
    (Mode::Server, status)
}

fn hud_revision() -> Revision {
    if HAVE_SNAPSHOT.load(Ordering::Relaxed) {
        Revision::Known(SIM.lock().unwrap().as_ref().map(|s| s.rev()).unwrap_or(0))
    } else {
        Revision::Unknown
    }
}

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------

struct ChunkMesh {
    vertex_buffer: BufferId,
    index_buffer: BufferId,
    index_count: i32,
}

struct Stage {
    ctx: Box<dyn RenderingBackend>,

    terrain_pipeline: Pipeline,
    terrain_mesh: Option<ChunkMesh>,
    dirty: bool,

    sprite_pipeline: Pipeline,
    sprite_bindings: Bindings,

    hud_pipeline: Pipeline,
    hud_bindings: Bindings,
    hud_vertex_capacity: usize,
    hud_last_string: String,

    camera: OrbitCamera,
    dragging: bool,
    last_mouse: (f32, f32),
    screen_size: (f32, f32),
    dpr: f32,

    start_time: f64,
    released: bool,
}

/// Rebuilds the combined (both scene chunks) visible-face mesh from
/// the current `Sim` world state.
fn rebuild_mesh(ctx: &mut dyn RenderingBackend, sim: &Sim) -> ChunkMesh {
    let mut combined = MeshBuffers::new();
    for (i, coord) in SCENE_CHUNK_COORDS.iter().enumerate() {
        let mut buffers = MeshBuffers::new();
        if build_chunk_mesh(sim.world(), *coord, &PALETTE, &mut buffers).is_ok() {
            let x_offset = (i as f32) * SCENE_CHUNK_DIMS.x as f32;
            append_mesh(&mut combined, &buffers, x_offset);
        }
    }
    let vertex_buffer = ctx.new_buffer(
        BufferType::VertexBuffer,
        BufferUsage::Immutable,
        BufferSource::slice(&combined.vertices),
    );
    let indices: Vec<u16> = combined
        .indices
        .iter()
        .map(|&i| u16::try_from(i).expect("fixed demo mesh fits WebGL1 indices"))
        .collect();
    let index_buffer = ctx.new_buffer(
        BufferType::IndexBuffer,
        BufferUsage::Immutable,
        BufferSource::slice(&indices),
    );
    RESOURCES_LIVE.fetch_add(2, Ordering::Relaxed);
    ChunkMesh {
        vertex_buffer,
        index_buffer,
        index_count: combined.indices.len() as i32,
    }
}

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

/// Largest glyph quad count the HUD stream buffer supports: 16 cells,
/// 7 segments each, 4 vertices per quad = <= 112 quads, plus 1 chip
/// quad and 1 panel quad: <= 114 quads total, matching the contract.
const HUD_MAX_QUADS: usize = 16 * 7 + 2;
const HUD_VERTICES_PER_QUAD: usize = 4;
const HUD_INDICES_PER_QUAD: usize = 6;

#[repr(C)]
#[derive(Clone, Copy)]
struct HudVertex {
    pos: [f32; 2],
    color: [f32; 4],
}

impl Stage {
    pub fn new() -> Stage {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();

        let sim = Sim::new_scene();
        let terrain_mesh = Some(rebuild_mesh(&mut *ctx, &sim));
        *SIM.lock().unwrap() = Some(sim);

        let terrain_shader = ctx
            .new_shader(
                match ctx.info().backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: shader::TERRAIN_VERTEX,
                        fragment: shader::TERRAIN_FRAGMENT,
                    },
                    Backend::Metal => {
                        panic!("miniquad-voxel mixed example does not supply a Metal shader")
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
                        panic!("miniquad-voxel mixed example does not supply a Metal shader")
                    }
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

        // HUD: one bounded stream buffer, created once (per "Rendering
        // and GPU resources": "one stream buffer that is created
        // once"). Rebuilt (its contents re-uploaded) only when the
        // HUD string/status/size changes.
        let hud_vertex_buffer = ctx.new_buffer(
            BufferType::VertexBuffer,
            BufferUsage::Stream,
            BufferSource::empty::<HudVertex>(HUD_MAX_QUADS * HUD_VERTICES_PER_QUAD),
        );
        let hud_index_buffer = ctx.new_buffer(
            BufferType::IndexBuffer,
            BufferUsage::Immutable,
            BufferSource::slice(&hud_quad_indices()),
        );
        let hud_bindings = Bindings {
            vertex_buffers: vec![hud_vertex_buffer],
            index_buffer: hud_index_buffer,
            images: vec![],
        };
        let hud_shader = ctx
            .new_shader(
                match ctx.info().backend {
                    Backend::OpenGl => ShaderSource::Glsl {
                        vertex: shader::HUD_VERTEX,
                        fragment: shader::HUD_FRAGMENT,
                    },
                    Backend::Metal => {
                        panic!("miniquad-voxel mixed example does not supply a Metal shader")
                    }
                },
                shader::hud_meta(),
            )
            .unwrap();
        // Drawn last, depth test always-pass, depth write off,
        // straight-alpha blend, orthographic physical pixels.
        let hud_pipeline = ctx.new_pipeline(
            &[BufferLayout::default()],
            &[
                VertexAttribute::new("in_pos", VertexFormat::Float2),
                VertexAttribute::new("in_color", VertexFormat::Float4),
            ],
            hud_shader,
            PipelineParams {
                depth_test: Comparison::Always,
                depth_write: false,
                color_blend: Some(BlendState::new(
                    Equation::Add,
                    BlendFactor::Value(BlendValue::SourceAlpha),
                    BlendFactor::OneMinusValue(BlendValue::SourceAlpha),
                )),
                ..Default::default()
            },
        );
        RESOURCES_LIVE.fetch_add(6, Ordering::Relaxed); // sprite(2) + hud(2) + hud pipeline/shader accounted at delete time

        let world_center_x = SCENE_CHUNK_DIMS.x as f32;
        let world_center_z = (SCENE_CHUNK_DIMS.z as f32) * 0.5;
        Stage {
            ctx,
            terrain_pipeline,
            terrain_mesh,
            dirty: false,
            sprite_pipeline,
            sprite_bindings,
            hud_pipeline,
            hud_bindings,
            hud_vertex_capacity: HUD_MAX_QUADS * HUD_VERTICES_PER_QUAD,
            hud_last_string: String::new(),
            camera: OrbitCamera::new(
                Vec3::new(world_center_x, (SCENE_CHUNK_DIMS.y as f32) * 0.4, world_center_z),
                22.0,
                0.6,
                0.5,
            ),
            dragging: false,
            last_mouse: (0.0, 0.0),
            screen_size: (800.0, 500.0),
            dpr: 1.0,
            start_time: date::now(),
            released: false,
        }
    }

    /// Applies any inbound mailbox frame, and in offline-local mode
    /// (status never set), applies pending local inputs directly.
    fn drain_network(&mut self) {
        let mut mailbox = INBOUND_MAILBOX.lock().unwrap();
        if let Some(inbound) = mailbox.take() {
            let mut sim_guard = SIM.lock().unwrap();
            match inbound {
                Inbound::Snapshot { rev, snapshot } => {
                    if let Some(sim) = sim_guard.as_mut() {
                        apply_snapshot(sim, rev, &snapshot);
                    }
                    HAVE_SNAPSHOT.store(true, Ordering::Relaxed);
                    self.dirty = true;
                }
                Inbound::Delta { base_rev, rev, commands } => {
                    if let Some(sim) = sim_guard.as_mut() {
                        if base_rev == sim.rev() {
                            for command in commands {
                                let _ = sim.apply(command);
                            }
                            self.dirty = true;
                            if sim.rev() != rev {
                                // The header's declared post-frame
                                // revision disagrees with what
                                // applying its own commands produced:
                                // treat this exactly like any other
                                // resync trigger rather than silently
                                // trusting a corrupted/inconsistent
                                // Delta.
                                HAVE_SNAPSHOT.store(false, Ordering::Relaxed);
                            }
                        } else {
                            // "It discards a Delta with base_rev != rev
                            // and sends Hello." The client itself does
                            // not send requests; clearing HAVE_SNAPSHOT
                            // makes the next vx_net_build_request call
                            // build a Hello instead of further Inputs.
                            HAVE_SNAPSHOT.store(false, Ordering::Relaxed);
                        }
                    }
                }
                Inbound::Error(code) => {
                    use protocol::ErrorCode;
                    match code {
                        ErrorCode::World | ErrorCode::Gap | ErrorCode::Stale => {
                            // "World/restart/gap/stale => Hello resync."
                            HAVE_SNAPSHOT.store(false, Ordering::Relaxed);
                        }
                        ErrorCode::Version => {
                            // "Version => stop": no retry, no resync.
                            // The host-side poller already stops
                            // polling on a version error; nothing to
                            // change in Sim.
                        }
                        ErrorCode::Rejected | ErrorCode::Malformed | ErrorCode::TooLarge => {
                            // Rejected/malformed/too-large: the world
                            // stays exactly as it was (rev unchanged,
                            // never a speculative local write to roll
                            // back), matching "rejected edit unchanged
                            // rev + host message".
                        }
                    }
                }
            }
            drop(sim_guard);
            INBOUND_APPLIED.store(true, Ordering::Relaxed);
        }
        drop(mailbox);

        // Offline/local mode: no transport status has ever been set,
        // so apply queued inputs directly instead of waiting for a
        // server round trip.
        if !NET_STATUS_SET.load(Ordering::Relaxed) {
            let mut pending = PENDING_INPUTS.lock().unwrap();
            let commands: Vec<Command> = pending.drain(..).collect();
            drop(pending);
            if !commands.is_empty() {
                let mut sim_guard = SIM.lock().unwrap();
                if let Some(sim) = sim_guard.as_mut() {
                    for command in commands {
                        let _ = sim.apply(command);
                    }
                }
                self.dirty = true;
            }
        } else if NET_STATUS.load(Ordering::Relaxed) == 2 {
            // Mixed mode, transport offline: edits are not locally
            // speculative, so queued-but-unsent inputs are discarded
            // and counted rather than silently kept forever.
            let mut pending = PENDING_INPUTS.lock().unwrap();
            if !pending.is_empty() {
                DISCARDED_INPUTS.fetch_add(pending.len() as u32, Ordering::Relaxed);
                pending.clear();
            }
        }
    }

    fn hud_string(&self) -> String {
        let (mode, status) = hud_mode_and_status();
        let revision = hud_revision();
        hud::cell_tokens(mode, status, revision).iter().collect()
    }
}

/// Applies a decoded `Snapshot` as a full resync: replaces `Sim`'s
/// world, seed, speed, and revision with the snapshot's content via
/// `Sim::load_snapshot`. On a decode/shape mismatch, leaves `Sim`
/// untouched (the next request will still carry the old `rev`, and
/// the server will resend a `Snapshot` rather than a useless `Delta`).
fn apply_snapshot(sim: &mut Sim, rev: u32, snapshot: &protocol::Snapshot) {
    let chunks: Vec<(miniquad_voxel::world::ChunkCoord, u8, u8, u8, &[u8])> = snapshot
        .chunks
        .iter()
        .map(|c| {
            (
                miniquad_voxel::world::ChunkCoord::new(c.cx as i32, c.cy as i32, c.cz as i32),
                c.dx,
                c.dy,
                c.dz,
                c.voxels.as_slice(),
            )
        })
        .collect();
    let _ = sim.load_snapshot(snapshot.seed, snapshot.speed_milli, rev, &chunks);
}

const ARROW_KEY_STEP: f32 = 0.03;
const DRAG_SENSITIVITY: f32 = 0.01;

impl EventHandler for Stage {
    fn update(&mut self) {
        self.drain_network();
        if self.dirty {
            if let Some(old) = self.terrain_mesh.take() {
                self.ctx.delete_buffer(old.vertex_buffer);
                self.ctx.delete_buffer(old.index_buffer);
                RESOURCES_LIVE.fetch_sub(2, Ordering::Relaxed);
            }
            let sim_guard = SIM.lock().unwrap();
            if let Some(sim) = sim_guard.as_ref() {
                self.terrain_mesh = Some(rebuild_mesh(&mut *self.ctx, sim));
            }
            self.dirty = false;
        }
    }

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
            self.camera.rotate(dx * DRAG_SENSITIVITY, -dy * DRAG_SENSITIVITY);
            self.last_mouse = (x, y);
        }
    }

    fn draw(&mut self) {
        if RELEASE_GPU.load(Ordering::Relaxed) {
            if !self.released {
                if let Some(mesh) = self.terrain_mesh.take() {
                    self.ctx.delete_buffer(mesh.vertex_buffer);
                    self.ctx.delete_buffer(mesh.index_buffer);
                }
                self.ctx.delete_buffer(self.sprite_bindings.vertex_buffers[0]);
                self.ctx.delete_buffer(self.sprite_bindings.index_buffer);
                self.ctx.delete_buffer(self.hud_bindings.vertex_buffers[0]);
                self.ctx.delete_buffer(self.hud_bindings.index_buffer);
                RESOURCES_LIVE.store(0, Ordering::Relaxed);
                self.released = true;
            }
            // Draws no scene after release, per the contract.
            return;
        }

        let aspect = self.screen_size.0 / self.screen_size.1;
        let view = self.camera.view_matrix();
        let projection = self.camera.projection_matrix(aspect);
        let view_projection = projection.mul(&view);

        self.ctx.begin_default_pass(PassAction::Clear {
            color: Some((0.063, 0.094, 0.141, 1.0)),
            depth: Some(1.0),
            stencil: None,
        });

        if let Some(mesh) = &self.terrain_mesh {
            let bindings = Bindings {
                vertex_buffers: vec![mesh.vertex_buffer],
                index_buffer: mesh.index_buffer,
                images: vec![],
            };
            self.ctx.apply_pipeline(&self.terrain_pipeline);
            self.ctx.apply_bindings(&bindings);
            self.ctx
                .apply_uniforms(UniformsSource::table(&shader::TerrainUniforms {
                    view_projection: view_projection.0,
                }));
            self.ctx.draw(0, mesh.index_count, 1);
        }

        let speed = f32::from_bits(SPEED_BITS.load(Ordering::Relaxed));
        let t = (date::now() - self.start_time) * speed as f64;
        let world_center_x = SCENE_CHUNK_DIMS.x as f32;
        let world_center_z = (SCENE_CHUNK_DIMS.z as f32) * 0.5;
        let radius = 3.0;
        let sprite_pos = Vec3::new(
            world_center_x + (t as f32).cos() * radius,
            (SCENE_CHUNK_DIMS.y as f32) * 0.35 + (t as f32 * 1.7).sin() * 0.6,
            world_center_z + (t as f32).sin() * radius,
        );
        let model = Mat4([
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            sprite_pos.x, sprite_pos.y, sprite_pos.z, 1.0,
        ]);
        let mvp = view_projection.mul(&model);
        self.ctx.apply_pipeline(&self.sprite_pipeline);
        self.ctx.apply_bindings(&self.sprite_bindings);
        self.ctx
            .apply_uniforms(UniformsSource::table(&shader::SpriteUniforms {
                model_view_projection: mvp.0,
                tint: [0.188, 0.459, 0.784, 1.0],
            }));
        self.ctx.draw(0, 6, 1);

        // Sprite centre in canvas pixels: project the clip-space
        // origin of `model` through `view_projection` and map NDC to
        // pixel space.
        let clip = view_projection.transform_point(sprite_pos);
        let ndc_x = clip.0 / clip.3;
        let ndc_y = clip.1 / clip.3;
        let px = ((ndc_x * 0.5 + 0.5) * self.screen_size.0).round().clamp(0.0, 65535.0) as u32;
        let py = ((1.0 - (ndc_y * 0.5 + 0.5)) * self.screen_size.1).round().clamp(0.0, 65535.0) as u32;
        SPRITE_PIXEL.store((px << 16) | py, Ordering::Relaxed);

        // HUD drawn last.
        self.draw_hud();

        self.ctx.end_render_pass();
        self.ctx.commit_frame();
    }
}

fn hud_quad_indices() -> Vec<u16> {
    let mut indices = Vec::with_capacity(HUD_MAX_QUADS * HUD_INDICES_PER_QUAD);
    for q in 0..HUD_MAX_QUADS {
        let base = (q * HUD_VERTICES_PER_QUAD) as u16;
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    indices
}

impl Stage {
    fn draw_hud(&mut self) {
        let geo = match hud::compute_geometry(self.dpr, self.screen_size.0, self.screen_size.1) {
            Some(g) => g,
            None => return, // Hides the whole HUD; never falls back to host status text.
        };
        let hud_text = self.hud_string();
        let (_, status) = hud_mode_and_status();
        let rebuild_key = format!("{}|{:?}|{}x{}", hud_text, status, self.screen_size.0, self.screen_size.1);
        if rebuild_key == self.hud_last_string {
            // Still draw with the existing buffer contents; only the
            // upload is skipped when nothing changed.
        } else {
            self.hud_last_string = rebuild_key;
            let verts = build_hud_vertices(&geo, geo.m, geo.m, &hud_text, status);
            if verts.len() <= self.hud_vertex_capacity {
                self.ctx.buffer_update(self.hud_bindings.vertex_buffers[0], BufferSource::slice(&verts));
            }
        }

        let (w, h) = self.screen_size;
        // Orthographic, physical pixels, origin top-left.
        let ortho = Mat4([
            2.0 / w, 0.0, 0.0, 0.0, //
            0.0, -2.0 / h, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            -1.0, 1.0, 0.0, 1.0,
        ]);
        self.ctx.apply_pipeline(&self.hud_pipeline);
        self.ctx.apply_bindings(&self.hud_bindings);
        self.ctx
            .apply_uniforms(UniformsSource::table(&shader::HudUniforms { projection: ortho.0 }));
        let quad_count = hud_quad_count(&hud_text, status);
        self.ctx.draw(0, (quad_count * HUD_INDICES_PER_QUAD) as i32, 1);
    }
}

fn hud_quad_count(text: &str, status: Status) -> usize {
    let mut count = 1; // panel
    if hud::chip_color(status).is_some() {
        count += 1;
    }
    for ch in text.chars() {
        if let Some(mask) = hud::glyph_mask(ch) {
            count += (mask.count_ones()) as usize;
        }
    }
    count
}

/// Builds the panel + chip + glyph-segment quads for the HUD, in
/// device pixels, with `x0`/`y0` as the panel's top-left corner.
fn build_hud_vertices(geo: &Geometry, x0: f32, y0: f32, text: &str, status: Status) -> Vec<HudVertex> {
    let mut verts = Vec::new();
    push_quad(&mut verts, x0, y0, geo.panel_width, geo.panel_height, hud::PANEL_COLOR);
    if let Some(color) = hud::chip_color(status) {
        let (cx, cy, cw, ch) = hud::chip_rect(geo, x0, y0);
        push_quad(&mut verts, cx, cy, cw, ch, color);
    }
    for (i, ch) in text.chars().enumerate() {
        let Some(mask) = hud::glyph_mask(ch) else { continue };
        let (gx, gy, gw, gh) = hud::glyph_rect(geo, x0, y0, i);
        push_glyph_segments(&mut verts, gx, gy, gw, gh, geo.t, mask);
    }
    verts
}

fn push_quad(verts: &mut Vec<HudVertex>, x: f32, y: f32, w: f32, h: f32, color: [f32; 4]) {
    verts.push(HudVertex { pos: [x, y], color });
    verts.push(HudVertex { pos: [x + w, y], color });
    verts.push(HudVertex { pos: [x + w, y + h], color });
    verts.push(HudVertex { pos: [x, y + h], color });
}

/// Draws the subset of the seven segments set in `mask` as thin
/// quads, each `t` device pixels thick, within a `w x h` glyph cell.
fn push_glyph_segments(verts: &mut Vec<HudVertex>, x: f32, y: f32, w: f32, h: f32, t: f32, mask: hud::GlyphMask) {
    let color = hud::GLYPH_COLOR;
    let half = h / 2.0;
    // a: top horizontal
    if mask & 0x01 != 0 {
        push_quad(verts, x, y, w, t, color);
    }
    // b: top-right vertical
    if mask & 0x02 != 0 {
        push_quad(verts, x + w - t, y, t, half, color);
    }
    // c: bottom-right vertical
    if mask & 0x04 != 0 {
        push_quad(verts, x + w - t, y + half, t, half, color);
    }
    // d: bottom horizontal
    if mask & 0x08 != 0 {
        push_quad(verts, x, y + h - t, w, t, color);
    }
    // e: bottom-left vertical
    if mask & 0x10 != 0 {
        push_quad(verts, x, y + half, t, half, color);
    }
    // f: top-left vertical
    if mask & 0x20 != 0 {
        push_quad(verts, x, y, t, half, color);
    }
    // g: middle horizontal
    if mask & 0x40 != 0 {
        push_quad(verts, x, y + half - t / 2.0, w, t, color);
    }
}

fn main() {
    let conf = conf::Conf {
        window_title: "miniquad-voxel mixed".to_owned(),
        #[cfg(feature = "webgl2")]
        platform: conf::Platform {
            webgl_version: conf::WebGLVersion::WebGL2,
            ..Default::default()
        },
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

    pub const HUD_VERTEX: &str = r#"#version 100
    attribute vec2 in_pos;
    attribute vec4 in_color;

    uniform mat4 projection;

    varying lowp vec4 color;

    void main() {
        gl_Position = projection * vec4(in_pos, 0.0, 1.0);
        color = in_color;
    }"#;

    pub const HUD_FRAGMENT: &str = r#"#version 100
    varying lowp vec4 color;

    void main() {
        gl_FragColor = color;
    }"#;

    pub fn hud_meta() -> ShaderMeta {
        ShaderMeta {
            images: vec![],
            uniforms: UniformBlockLayout {
                uniforms: vec![UniformDesc::new("projection", UniformType::Mat4)],
            },
        }
    }

    #[repr(C)]
    pub struct HudUniforms {
        pub projection: [f32; 16],
    }
}
