//! The proof state machine. Rust owns every field of `status()`
//! (`docs/webgpu-proof-contract.md` sections 4-6). JavaScript only reports
//! facts through the exported callbacks in `lib.rs`; this module decides
//! every phase transition.

use crate::bridge;
use crate::error::{ProofError, ProofErrorCode};
use crate::json::JsonWriter;
use crate::pixel::{self, CanvasFormat};
use crate::text;

pub const CONTRACT: &str = "miniquad-webgpu-proof/1";
pub const CANDIDATE: &str = "manual";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Render,
    InvalidWgsl,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "render" => Some(Mode::Render),
            "invalid-wgsl" => Some(Mode::InvalidWgsl),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Mode::Render => "render",
            Mode::InvalidWgsl => "invalid-wgsl",
        }
    }

    fn shader_source(self) -> &'static str {
        match self {
            Mode::Render => include_str!("../../webgpu-proof-shared/triangle.wgsl"),
            Mode::InvalidWgsl => include_str!("../../webgpu-proof-shared/invalid.wgsl"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Starting,
    Running,
    Failed,
    Lost,
    Disposed,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Starting => "starting",
            Phase::Running => "running",
            Phase::Failed => "failed",
            Phase::Lost => "lost",
            Phase::Disposed => "disposed",
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, Phase::Failed | Phase::Lost | Phase::Disposed)
    }
}

/// The step this instance is waiting for. `None` once `Running` (or once a
/// terminal phase is reached). Guards stale/duplicate async results: a
/// result is accepted only when its `request_id` matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Adapter,
    Device,
    Context,
    Shader,
    Pipeline,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PointerState {
    pub x: i32,
    pub y: i32,
    pub button: u32, // 0 left, 1 middle, 2 right (matches MouseEvent.button)
    pub down: bool,
}

#[derive(Debug, Clone, Default)]
pub struct KeyState {
    pub code: String,
    pub down: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadbackPhase {
    Idle,
    Pending,
    Ready,
    Failed,
}

#[derive(Debug, Clone)]
pub struct ReadbackState {
    pub id: u32,
    pub phase: ReadbackPhase,
    pub width: u32,
    pub height: u32,
    pub center: Option<[u8; 4]>,
    pub corner: Option<[u8; 4]>,
    pub error: Option<ProofError>,
}

impl Default for ReadbackState {
    fn default() -> Self {
        ReadbackState {
            id: 0,
            phase: ReadbackPhase::Idle,
            width: 0,
            height: 0,
            center: None,
            corner: None,
            error: None,
        }
    }
}

pub struct State {
    pub mode: Mode,
    pub phase: Phase,
    pub error: Option<ProofError>,
    pub canvas_format: Option<CanvasFormat>,
    pub surface: (u32, u32),
    pub frame_count: u32,
    pub resize_count: u32,
    pub pointer: Option<PointerState>,
    pub key: Option<KeyState>,
    pub focused: bool,
    pub focus_changes: u32,
    pub readback: ReadbackState,

    step: Option<Step>,
    next_request_id: u32,
    next_frame_id: u32,
    adapter_handle: u32,
    device_handle: u32,
    shader_handle: u32,
    pipeline_handle: u32,
    disposed_device: bool,
}

/// The outcome of `mq_proof_init`, reused by `lib.rs` for the contract's
/// host-vs-rust reporter split.
pub enum InitOutcome {
    Started(State),
    /// The mode string did not parse. The caller can still build a `State`
    /// (the contract allows `reporter: "rust"` for `contract-mismatch`),
    /// but there is no valid mode to run, so `lib.rs` builds a minimal
    /// failed state directly instead of calling into this module.
    InvalidMode,
}

impl State {
    pub fn init(mode: &str, api_available: bool, secure_context: bool, width: u32, height: u32) -> InitOutcome {
        let mode = match Mode::parse(mode) {
            Some(m) => m,
            None => return InitOutcome::InvalidMode,
        };
        let mut state = State {
            mode,
            phase: Phase::Starting,
            error: None,
            canvas_format: None,
            surface: (width, height),
            frame_count: 0,
            resize_count: 0,
            pointer: None,
            key: None,
            focused: false,
            focus_changes: 0,
            readback: ReadbackState::default(),
            step: None,
            next_request_id: 1,
            next_frame_id: 1,
            adapter_handle: 0,
            device_handle: 0,
            shader_handle: 0,
            pipeline_handle: 0,
            disposed_device: false,
        };

        if !secure_context {
            state.fail(ProofErrorCode::InsecureContext, "isSecureContext is false");
            return InitOutcome::Started(state);
        }
        if !api_available {
            state.fail(ProofErrorCode::ApiUnavailable, "navigator.gpu is missing");
            return InitOutcome::Started(state);
        }

        state.step = Some(Step::Adapter);
        let request_id = state.next_request_id();
        bridge::request_adapter(request_id);
        InitOutcome::Started(state)
    }

    fn next_request_id(&mut self) -> u32 {
        let id = self.next_request_id;
        self.next_request_id += 1;
        id
    }

    fn fail(&mut self, code: ProofErrorCode, message: &str) {
        if self.phase.is_terminal() {
            return;
        }
        self.phase = Phase::Failed;
        self.error = Some(ProofError::new(code, message));
        self.step = None;
    }

    fn accepts(&self, want: Step, request_id: u32, expected_id: u32) -> bool {
        !self.phase.is_terminal() && self.step == Some(want) && request_id == expected_id
    }

    pub fn on_adapter_result(&mut self, request_id: u32, ok: bool, handle: u32) {
        if !self.accepts(Step::Adapter, request_id, self.next_request_id - 1) {
            return;
        }
        if !ok || handle == 0 {
            self.fail(ProofErrorCode::AdapterUnavailable, "requestAdapter() gave null");
            return;
        }
        self.adapter_handle = handle;
        self.step = Some(Step::Device);
        let next_id = self.next_request_id();
        bridge::request_device(next_id, handle);
    }

    pub fn on_device_result(&mut self, request_id: u32, ok: bool, handle: u32) {
        if !self.accepts(Step::Device, request_id, self.next_request_id - 1) {
            return;
        }
        if !ok || handle == 0 {
            self.fail(ProofErrorCode::DeviceRequestFailed, "requestDevice() rejected");
            return;
        }
        self.device_handle = handle;
        self.step = Some(Step::Context);
        let next_id = self.next_request_id();
        bridge::request_context(next_id, handle);
    }

    pub fn on_context_result(&mut self, request_id: u32, ok: bool, format_code: u32) {
        if !self.accepts(Step::Context, request_id, self.next_request_id - 1) {
            return;
        }
        let format = if ok { CanvasFormat::from_code(format_code) } else { None };
        let format = match format {
            Some(f) => f,
            None => {
                self.fail(
                    ProofErrorCode::CanvasContextUnavailable,
                    "getContext(\"webgpu\") gave null",
                );
                return;
            }
        };
        self.canvas_format = Some(format);
        self.step = Some(Step::Shader);
        let next_id = self.next_request_id();
        let code = self.mode.shader_source();
        bridge::compile_shader(next_id, self.device_handle, code);
    }

    pub fn on_shader_result(&mut self, request_id: u32, ok: bool, handle: u32, message: &[u8]) {
        if !self.accepts(Step::Shader, request_id, self.next_request_id - 1) {
            return;
        }
        if !ok || handle == 0 {
            let text = text::validate_incoming_text(message).unwrap_or("shader compilation failed");
            self.fail(ProofErrorCode::ShaderCompilation, text);
            return;
        }
        self.shader_handle = handle;
        self.step = Some(Step::Pipeline);
        let next_id = self.next_request_id();
        bridge::create_pipeline(next_id, self.device_handle, handle);
    }

    pub fn on_pipeline_result(&mut self, request_id: u32, ok: bool, handle: u32, message: &[u8]) {
        if !self.accepts(Step::Pipeline, request_id, self.next_request_id - 1) {
            return;
        }
        if !ok || handle == 0 {
            let text = text::validate_incoming_text(message).unwrap_or("pipeline creation failed");
            self.fail(ProofErrorCode::PipelineCreation, text);
            return;
        }
        self.pipeline_handle = handle;
        self.step = None;
        self.phase = Phase::Running;
    }

    /// Called once per animation frame while running. Starts a render (and,
    /// if a readback is pending, a copy) by calling into the bridge.
    pub fn tick(&mut self) {
        if self.phase != Phase::Running {
            return;
        }
        let frame_id = self.next_frame_id;
        self.next_frame_id += 1;
        let do_readback = self.readback.phase == ReadbackPhase::Pending;
        bridge::render_frame(
            frame_id,
            self.device_handle,
            self.pipeline_handle,
            do_readback,
            self.readback.id,
        );
    }

    pub fn on_frame_submitted(&mut self, ok: bool) {
        if self.phase != Phase::Running {
            return;
        }
        if ok {
            self.frame_count += 1;
        }
    }

    pub fn request_readback(&mut self) -> u32 {
        if self.phase != Phase::Running {
            return 0;
        }
        let id = self.next_request_id();
        self.readback = ReadbackState {
            id,
            phase: ReadbackPhase::Pending,
            width: 0,
            height: 0,
            center: None,
            corner: None,
            error: None,
        };
        id
    }

    pub fn on_readback_result(
        &mut self,
        id: u32,
        ok: bool,
        width: u32,
        height: u32,
        bytes: &[u8],
        bytes_per_row: u32,
        format_code: u32,
    ) {
        // A late result for an old id is discarded; a new request replaces
        // the old one (contract section 6, readback rule 6).
        if id != self.readback.id || self.readback.phase != ReadbackPhase::Pending {
            return;
        }
        if !ok {
            self.readback.phase = ReadbackPhase::Failed;
            self.readback.error = Some(ProofError::new(ProofErrorCode::ReadbackFailed, "copy or mapAsync failed"));
            return;
        }
        let format = match CanvasFormat::from_code(format_code) {
            Some(f) => f,
            None => {
                self.readback.phase = ReadbackPhase::Failed;
                self.readback.error = Some(ProofError::new(ProofErrorCode::Internal, "unknown canvas format code"));
                return;
            }
        };
        let (cx, cy) = pixel::center_coord(width, height);
        let center = pixel::read_pixel(bytes, bytes_per_row, width, height, format, cx, cy);
        let corner = pixel::read_pixel(bytes, bytes_per_row, width, height, format, 0, 0);
        match (center, corner) {
            (Some(c), Some(k)) => {
                self.readback.phase = ReadbackPhase::Ready;
                self.readback.width = width;
                self.readback.height = height;
                self.readback.center = Some(c);
                self.readback.corner = Some(k);
                self.readback.error = None;
            }
            _ => {
                self.readback.phase = ReadbackPhase::Failed;
                self.readback.error = Some(ProofError::new(ProofErrorCode::ReadbackFailed, "mapped buffer too small"));
            }
        }
    }

    pub fn on_device_lost(&mut self, reason_destroyed: bool) {
        if self.phase.is_terminal() {
            return;
        }
        self.phase = Phase::Lost;
        let reason = if reason_destroyed { "destroyed" } else { "unknown" };
        self.error = Some(ProofError::with_reason(ProofErrorCode::DeviceLost, "the device was lost", reason));
        self.step = None;
    }

    pub fn on_pointer_event(&mut self, x: i32, y: i32, button: u32, down: bool) {
        if self.phase.is_terminal() {
            return;
        }
        self.pointer = Some(PointerState { x, y, button, down });
    }

    pub fn on_key_event(&mut self, code: &str, down: bool) {
        if self.phase.is_terminal() {
            return;
        }
        self.key = Some(KeyState { code: code.to_string(), down });
    }

    /// Reports a protocol violation outside the startup chain (for example,
    /// a key code with invalid UTF-8 bytes). Contract section 7: "Invalid
    /// bytes give code internal." A no-op once terminal.
    pub fn fail_internal(&mut self, message: &str) {
        self.fail(ProofErrorCode::Internal, message);
    }

    pub fn on_focus_event(&mut self, focused: bool) {
        if self.phase.is_terminal() {
            return;
        }
        self.focused = focused;
        self.focus_changes += 1;
    }

    pub fn on_resize(&mut self, width: u32, height: u32) {
        if self.phase.is_terminal() {
            return;
        }
        self.surface = (width, height);
        self.resize_count += 1;
    }

    /// Returns `true` the first time this is called (JavaScript must still
    /// release GPU resources); `false` on a repeat call, which keeps
    /// `dispose()` idempotent at both layers.
    pub fn dispose(&mut self) -> bool {
        if self.disposed_device {
            return false;
        }
        self.disposed_device = true;
        self.phase = Phase::Disposed;
        self.step = None;
        true
    }

    pub fn status_json(&self) -> String {
        let mut w = JsonWriter::new();
        w.raw("{");
        w.raw("\"contract\":");
        w.string(CONTRACT);
        w.raw(",\"candidate\":");
        w.string(CANDIDATE);
        w.raw(",\"reporter\":");
        w.string("rust");
        w.raw(",\"mode\":");
        w.string(self.mode.as_str());
        w.raw(",\"phase\":");
        w.string(self.phase.as_str());
        w.raw(",\"error\":");
        match &self.error {
            None => w.raw("null"),
            Some(e) => {
                w.raw("{\"code\":");
                w.string(e.code.as_str());
                w.raw(",\"message\":");
                w.string(&e.message);
                if let Some(reason) = e.reason {
                    w.raw(",\"reason\":");
                    w.string(reason);
                }
                w.raw("}");
            }
        }
        w.raw(",\"canvasFormat\":");
        match self.canvas_format {
            None => w.raw("null"),
            Some(f) => w.string(f.as_str()),
        }
        w.raw(",\"surface\":{\"width\":");
        w.number(self.surface.0 as i64);
        w.raw(",\"height\":");
        w.number(self.surface.1 as i64);
        w.raw("}");
        w.raw(",\"frameCount\":");
        w.number(self.frame_count as i64);
        w.raw(",\"resizeCount\":");
        w.number(self.resize_count as i64);
        w.raw(",\"input\":{\"pointer\":");
        match &self.pointer {
            None => w.raw("null"),
            Some(p) => {
                w.raw("{\"x\":");
                w.number(p.x as i64);
                w.raw(",\"y\":");
                w.number(p.y as i64);
                w.raw(",\"button\":");
                w.string(match p.button {
                    0 => "left",
                    1 => "middle",
                    _ => "right",
                });
                w.raw(",\"down\":");
                w.boolean(p.down);
                w.raw("}");
            }
        }
        w.raw(",\"key\":");
        match &self.key {
            None => w.raw("null"),
            Some(k) => {
                w.raw("{\"code\":");
                w.string(&k.code);
                w.raw(",\"down\":");
                w.boolean(k.down);
                w.raw("}");
            }
        }
        w.raw(",\"focused\":");
        w.boolean(self.focused);
        w.raw(",\"focusChanges\":");
        w.number(self.focus_changes as i64);
        w.raw("}");
        w.raw(",\"readback\":{\"id\":");
        w.number(self.readback.id as i64);
        w.raw(",\"state\":");
        w.string(match self.readback.phase {
            ReadbackPhase::Idle => "idle",
            ReadbackPhase::Pending => "pending",
            ReadbackPhase::Ready => "ready",
            ReadbackPhase::Failed => "failed",
        });
        w.raw(",\"width\":");
        w.number(self.readback.width as i64);
        w.raw(",\"height\":");
        w.number(self.readback.height as i64);
        w.raw(",\"center\":");
        write_pixel(&mut w, self.readback.center);
        w.raw(",\"corner\":");
        write_pixel(&mut w, self.readback.corner);
        w.raw(",\"error\":");
        match &self.readback.error {
            None => w.raw("null"),
            Some(e) => {
                w.raw("{\"code\":");
                w.string(e.code.as_str());
                w.raw(",\"message\":");
                w.string(&e.message);
                w.raw("}");
            }
        }
        w.raw("}");
        w.raw("}");
        w.into_string()
    }
}

fn write_pixel(w: &mut JsonWriter, pixel: Option<[u8; 4]>) {
    match pixel {
        None => w.raw("null"),
        Some(p) => {
            w.raw("[");
            w.number(p[0] as i64);
            w.raw(",");
            w.number(p[1] as i64);
            w.raw(",");
            w.number(p[2] as i64);
            w.raw(",");
            w.number(p[3] as i64);
            w.raw("]");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::recorded_calls::{take_all, Call};

    fn running_state() -> State {
        let outcome = State::init("render", true, true, 256, 256);
        let mut state = match outcome {
            InitOutcome::Started(s) => s,
            InitOutcome::InvalidMode => panic!("render must parse"),
        };
        take_all(); // drop the adapter request recorded by init
        state.on_adapter_result(1, true, 7);
        take_all();
        state.on_device_result(2, true, 8);
        take_all();
        state.on_context_result(3, true, 0);
        take_all();
        state.on_shader_result(4, true, 9, b"");
        take_all();
        state.on_pipeline_result(5, true, 10, b"");
        state
    }

    #[test]
    fn invalid_mode_is_reported_as_invalid() {
        assert!(matches!(State::init("bogus", true, true, 256, 256), InitOutcome::InvalidMode));
    }

    #[test]
    fn insecure_context_fails_before_requesting_an_adapter() {
        let outcome = State::init("render", true, false, 256, 256);
        let state = match outcome {
            InitOutcome::Started(s) => s,
            InitOutcome::InvalidMode => unreachable!(),
        };
        assert_eq!(state.phase, Phase::Failed);
        assert_eq!(state.error.as_ref().unwrap().code, ProofErrorCode::InsecureContext);
        assert!(take_all().is_empty(), "no adapter request after an insecure context");
    }

    #[test]
    fn missing_api_fails_before_requesting_an_adapter() {
        let outcome = State::init("render", false, true, 256, 256);
        let state = match outcome {
            InitOutcome::Started(s) => s,
            InitOutcome::InvalidMode => unreachable!(),
        };
        assert_eq!(state.error.as_ref().unwrap().code, ProofErrorCode::ApiUnavailable);
        assert!(take_all().is_empty());
    }

    #[test]
    fn a_full_startup_chain_reaches_running_and_calls_each_bridge_step_once() {
        let outcome = State::init("render", true, true, 256, 256);
        let mut state = match outcome {
            InitOutcome::Started(s) => s,
            InitOutcome::InvalidMode => unreachable!(),
        };
        assert_eq!(take_all(), vec![Call::RequestAdapter(1)]);

        state.on_adapter_result(1, true, 7);
        assert_eq!(take_all(), vec![Call::RequestDevice(2, 7)]);

        state.on_device_result(2, true, 8);
        assert_eq!(take_all(), vec![Call::RequestContext(3, 8)]);

        state.on_context_result(3, true, 0);
        let calls = take_all();
        assert_eq!(calls.len(), 1);
        match &calls[0] {
            Call::CompileShader(4, 8, code) => assert!(code.contains("vs_main")),
            other => panic!("unexpected call {:?}", other),
        }

        state.on_shader_result(4, true, 9, b"");
        assert_eq!(take_all(), vec![Call::CreatePipeline(5, 8, 9)]);

        state.on_pipeline_result(5, true, 10, b"");
        assert_eq!(state.phase, Phase::Running);
    }

    #[test]
    fn a_null_adapter_fails_with_adapter_unavailable() {
        let outcome = State::init("render", true, true, 256, 256);
        let mut state = match outcome {
            InitOutcome::Started(s) => s,
            InitOutcome::InvalidMode => unreachable!(),
        };
        take_all();
        state.on_adapter_result(1, false, 0);
        assert_eq!(state.phase, Phase::Failed);
        assert_eq!(state.error.as_ref().unwrap().code, ProofErrorCode::AdapterUnavailable);
    }

    #[test]
    fn a_stale_adapter_result_is_ignored() {
        let outcome = State::init("render", true, true, 256, 256);
        let mut state = match outcome {
            InitOutcome::Started(s) => s,
            InitOutcome::InvalidMode => unreachable!(),
        };
        take_all();
        // Wrong request id: must not advance the state.
        state.on_adapter_result(999, true, 7);
        assert_eq!(state.phase, Phase::Starting);
        assert!(take_all().is_empty());
    }

    #[test]
    fn invalid_wgsl_mode_fails_with_shader_compilation_and_never_runs() {
        let mut state = running_state_up_to_shader();
        state.on_shader_result(4, false, 0, "line 7: type mismatch".as_bytes());
        assert_eq!(state.phase, Phase::Failed);
        assert_eq!(state.error.as_ref().unwrap().code, ProofErrorCode::ShaderCompilation);
        assert_eq!(state.frame_count, 0);
    }

    fn running_state_up_to_shader() -> State {
        let outcome = State::init("invalid-wgsl", true, true, 256, 256);
        let mut state = match outcome {
            InitOutcome::Started(s) => s,
            InitOutcome::InvalidMode => unreachable!(),
        };
        take_all();
        state.on_adapter_result(1, true, 7);
        take_all();
        state.on_device_result(2, true, 8);
        take_all();
        state.on_context_result(3, true, 0);
        take_all();
        state
    }

    #[test]
    fn frame_count_increases_only_after_a_successful_submit() {
        let mut state = running_state();
        take_all();
        state.tick();
        assert_eq!(take_all(), vec![Call::RenderFrame(1, 8, 10, false, 0)]);
        assert_eq!(state.frame_count, 0);
        state.on_frame_submitted(true);
        assert_eq!(state.frame_count, 1);
        state.tick();
        state.on_frame_submitted(false);
        assert_eq!(state.frame_count, 1, "a failed submit must not increase frameCount");
    }

    #[test]
    fn a_terminal_phase_never_increases_frame_count_again() {
        let mut state = running_state();
        take_all();
        state.on_device_lost(true);
        assert_eq!(state.phase, Phase::Lost);
        state.tick(); // must be a no-op once lost
        assert!(take_all().is_empty());
        state.on_frame_submitted(true);
        assert_eq!(state.frame_count, 0);
    }

    #[test]
    fn device_lost_reports_the_destroyed_reason() {
        let mut state = running_state();
        state.on_device_lost(true);
        assert_eq!(state.error.as_ref().unwrap().code, ProofErrorCode::DeviceLost);
        assert_eq!(state.error.as_ref().unwrap().reason, Some("destroyed"));
    }

    #[test]
    fn readback_round_trip_gives_expected_256_square_pixels() {
        let mut state = running_state();
        let id = state.request_readback();
        assert_eq!(state.readback.phase, ReadbackPhase::Pending);
        let bytes_per_row = 256 * 4;
        let mut buf = vec![0u8; bytes_per_row * 256];
        for y in 0..256usize {
            for x in 0..256usize {
                let px: [u8; 4] = if x == 128 && y == 128 {
                    [0, 0, 255, 255] // BGRA red
                } else if x == 0 && y == 0 {
                    [255, 0, 0, 255] // BGRA blue
                } else {
                    [255, 0, 0, 255]
                };
                let start = y * bytes_per_row + x * 4;
                buf[start..start + 4].copy_from_slice(&px);
            }
        }
        state.on_readback_result(id, true, 256, 256, &buf, bytes_per_row as u32, 0);
        assert_eq!(state.readback.phase, ReadbackPhase::Ready);
        assert_eq!(state.readback.center, Some([255, 0, 0, 255]));
        assert_eq!(state.readback.corner, Some([0, 0, 255, 255]));
    }

    #[test]
    fn a_late_readback_result_for_a_superseded_id_is_discarded() {
        let mut state = running_state();
        let first_id = state.request_readback();
        let second_id = state.request_readback();
        assert_ne!(first_id, second_id);
        state.on_readback_result(first_id, true, 256, 256, &vec![0u8; 256 * 256 * 4], 256 * 4, 0);
        assert_eq!(state.readback.phase, ReadbackPhase::Pending, "the superseded id must not update state");
        assert_eq!(state.readback.id, second_id);
    }

    #[test]
    fn requesting_readback_before_running_returns_zero() {
        let mut state = running_state_up_to_shader();
        assert_eq!(state.request_readback(), 0);
    }

    #[test]
    fn dispose_is_idempotent_and_reports_first_call_only() {
        let mut state = running_state();
        assert!(state.dispose());
        assert_eq!(state.phase, Phase::Disposed);
        assert!(!state.dispose(), "a second dispose call must be a no-op");
        assert_eq!(state.phase, Phase::Disposed);
    }

    #[test]
    fn input_after_disposal_does_not_change_status() {
        let mut state = running_state();
        state.dispose();
        state.on_pointer_event(40, 30, 0, true);
        state.on_key_event("KeyA", true);
        state.on_focus_event(true);
        assert!(state.pointer.is_none());
        assert!(state.key.is_none());
        assert_eq!(state.focus_changes, 0);
    }

    #[test]
    fn status_json_round_trips_expected_fields() {
        let state = running_state();
        let json = state.status_json();
        assert!(json.contains("\"contract\":\"miniquad-webgpu-proof/1\""));
        assert!(json.contains("\"candidate\":\"manual\""));
        assert!(json.contains("\"phase\":\"running\""));
        assert!(json.contains("\"canvasFormat\":\"bgra8unorm\""));
    }
}
