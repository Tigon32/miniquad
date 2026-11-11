//! Candidate B for docs/webgpu-proof-contract.md, version miniquad-webgpu-proof/1.
//! This crate targets wasm32-unknown-unknown and the browser WebGPU API only.
//! It is not part of the root miniquad workspace and does not implement
//! `RenderingBackend`. See README.md for the build command and tool versions.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{mpsc, Arc};

use js_sys::{Object, Reflect};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{Event, FocusEvent, HtmlCanvasElement, KeyboardEvent, MouseEvent};

const CONTRACT: &str = "miniquad-webgpu-proof/1";
const CANDIDATE: &str = "wgpu";
const MAX_MESSAGE_BYTES: usize = 4096;
const ROW_ALIGNMENT: u32 = 256;

const TRIANGLE_WGSL: &str = include_str!("../../webgpu-proof-shared/triangle.wgsl");
const INVALID_WGSL: &str = include_str!("../../webgpu-proof-shared/invalid.wgsl");

// Cut `text` to at most `MAX_MESSAGE_BYTES` bytes at a UTF-8 character boundary.
fn clip_message(text: impl Into<String>) -> String {
    let mut text = text.into();
    if text.len() > MAX_MESSAGE_BYTES {
        let mut cut = MAX_MESSAGE_BYTES;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    if text.is_empty() {
        text.push_str("(no message)");
    }
    text
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Render,
    InvalidWgsl,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Render => "render",
            Mode::InvalidWgsl => "invalid-wgsl",
        }
    }

    fn parse(value: &str) -> Option<Mode> {
        match value {
            "render" => Some(Mode::Render),
            "invalid-wgsl" => Some(Mode::InvalidWgsl),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
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

    fn terminal(self) -> bool {
        matches!(self, Phase::Failed | Phase::Lost | Phase::Disposed)
    }
}

// docs/webgpu-proof-contract.md, section 5, "Error codes". The Rust enum is the
// same in both candidates; only this candidate's mapping to wgpu facts differs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ErrorCode {
    ApiUnavailable,
    InsecureContext,
    AdapterUnavailable,
    DeviceRequestFailed,
    CanvasContextUnavailable,
    ShaderCompilation,
    PipelineCreation,
    ReadbackFailed,
    DeviceLost,
    ContractMismatch,
    Internal,
}

impl ErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            ErrorCode::ApiUnavailable => "api-unavailable",
            ErrorCode::InsecureContext => "insecure-context",
            ErrorCode::AdapterUnavailable => "adapter-unavailable",
            ErrorCode::DeviceRequestFailed => "device-request-failed",
            ErrorCode::CanvasContextUnavailable => "canvas-context-unavailable",
            ErrorCode::ShaderCompilation => "shader-compilation",
            ErrorCode::PipelineCreation => "pipeline-creation",
            ErrorCode::ReadbackFailed => "readback-failed",
            ErrorCode::DeviceLost => "device-lost",
            ErrorCode::ContractMismatch => "contract-mismatch",
            ErrorCode::Internal => "internal",
        }
    }
}

#[derive(Clone)]
struct ProofError {
    code: ErrorCode,
    message: String,
    reason: Option<&'static str>,
}

impl ProofError {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        ProofError {
            code,
            message: clip_message(message),
            reason: None,
        }
    }

    fn device_lost(reason: &'static str) -> Self {
        ProofError {
            code: ErrorCode::DeviceLost,
            message: clip_message("the device was lost"),
            reason: Some(reason),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReadbackState {
    Idle,
    Pending,
    Ready,
    Failed,
}

impl ReadbackState {
    fn as_str(self) -> &'static str {
        match self {
            ReadbackState::Idle => "idle",
            ReadbackState::Pending => "pending",
            ReadbackState::Ready => "ready",
            ReadbackState::Failed => "failed",
        }
    }
}

struct Readback {
    id: u32,
    state: ReadbackState,
    width: u32,
    height: u32,
    center: Option<[u8; 4]>,
    corner: Option<[u8; 4]>,
    error: Option<ProofError>,
}

impl Default for Readback {
    fn default() -> Self {
        Readback {
            id: 0,
            state: ReadbackState::Idle,
            width: 0,
            height: 0,
            center: None,
            corner: None,
            error: None,
        }
    }
}

#[derive(Clone)]
struct PointerState {
    x: f64,
    y: f64,
    button: &'static str,
    down: bool,
}

#[derive(Clone)]
struct KeyState {
    code: String,
    down: bool,
}

#[derive(Default)]
struct Input {
    pointer: Option<PointerState>,
    key: Option<KeyState>,
    focused: bool,
    focus_changes: u32,
}

// GPU resources kept alive while `phase` is `running`. Dropped on dispose or
// device loss; `canvas` stays owned by the host page, this is a clone handle.
struct GpuState {
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: wgpu::Surface<'static>,
    pipeline: wgpu::RenderPipeline,
    format: wgpu::TextureFormat,
    canvas: HtmlCanvasElement,
}

enum DeviceEvent {
    Lost(wgpu::DeviceLostReason),
    Error(String),
}

// One registered DOM listener, kept so `dispose()` can remove it.
struct Listener {
    target: web_sys::EventTarget,
    kind: &'static str,
    callback: js_sys::Function,
    _closure: Box<dyn std::any::Any>,
}

struct State {
    mode: Mode,
    phase: Phase,
    error: Option<ProofError>,
    canvas_format: Option<&'static str>,
    surface_width: u32,
    surface_height: u32,
    frame_count: u32,
    resize_count: u32,
    input: Input,
    readback: Readback,
    next_readback_id: u32,
    pending_readback: Option<u32>,
    gpu: Option<GpuState>,
    disposed: bool,
    listeners: Vec<Listener>,
    gpu_events: Option<mpsc::Receiver<DeviceEvent>>,
    pending_device: Option<wgpu::Device>,
}

impl State {
    fn new(mode: Mode) -> Self {
        State {
            mode,
            phase: Phase::Starting,
            error: None,
            canvas_format: None,
            surface_width: 0,
            surface_height: 0,
            frame_count: 0,
            resize_count: 0,
            input: Input::default(),
            readback: Readback::default(),
            next_readback_id: 0,
            pending_readback: None,
            gpu: None,
            disposed: false,
            listeners: Vec::new(),
            gpu_events: None,
            pending_device: None,
        }
    }
}

fn release(s: &mut State) -> Result<(), String> {
    s.gpu_events = None;
    let mut errors = Vec::new();
    for listener in s.listeners.drain(..) {
        if let Err(error) = listener
            .target
            .remove_event_listener_with_callback(listener.kind, &listener.callback)
        {
            errors.push(format!("remove {} listener: {error:?}", listener.kind));
        }
    }
    if let Some(gpu) = s.gpu.take() {
        gpu.device.destroy();
    }
    if let Some(device) = s.pending_device.take() {
        device.destroy();
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

// Set a failed/lost status, unless the phase is already terminal. A terminal
// phase never changes to another phase (docs/webgpu-proof-contract.md, section 5).
fn fail(state: &Rc<RefCell<State>>, code: ErrorCode, message: impl Into<String>) {
    let mut s = state.borrow_mut();
    if s.phase.terminal() {
        return;
    }
    s.phase = Phase::Failed;
    s.error = Some(ProofError::new(code, message));
    if let Err(error) = release(&mut s) {
        let current = s.error.as_mut().expect("failure was recorded");
        current.message = clip_message(format!("{}; {error}", current.message));
    }
}

fn lose(state: &Rc<RefCell<State>>, reason: &'static str) {
    let mut s = state.borrow_mut();
    if s.phase.terminal() {
        return;
    }
    s.phase = Phase::Lost;
    s.error = Some(ProofError::device_lost(reason));
    if let Err(error) = release(&mut s) {
        s.error.as_mut().expect("device loss was recorded").message = clip_message(error);
    }
}

#[wasm_bindgen]
pub struct ProofApp {
    state: Rc<RefCell<State>>,
}

#[wasm_bindgen]
impl ProofApp {
    #[wasm_bindgen(constructor)]
    #[cfg(target_arch = "wasm32")]
    pub fn new(mode: String, canvas: HtmlCanvasElement) -> ProofApp {
        let parsed = Mode::parse(&mode).unwrap_or(Mode::Render);
        let state = Rc::new(RefCell::new(State::new(parsed)));
        if Mode::parse(&mode).is_none() {
            fail(
                &state,
                ErrorCode::ContractMismatch,
                format!("unknown mode: {mode}"),
            );
        } else {
            attach_input_listeners(&state, &canvas);
            if !state.borrow().phase.terminal() {
                wasm_bindgen_futures::spawn_local(start(Rc::clone(&state), parsed, canvas));
            }
        }
        ProofApp { state }
    }

    #[wasm_bindgen(js_name = status)]
    pub fn status(&self) -> JsValue {
        build_status(&self.state.borrow())
    }

    #[wasm_bindgen(js_name = reportHostError)]
    pub fn report_host_error(&self, message: String) {
        fail(&self.state, ErrorCode::Internal, message);
    }

    #[wasm_bindgen(js_name = requestReadback)]
    pub fn request_readback(&self) -> u32 {
        let mut s = self.state.borrow_mut();
        if s.phase != Phase::Running {
            return 0;
        }
        let Some(next) = s.next_readback_id.checked_add(1) else {
            drop(s);
            fail(
                &self.state,
                ErrorCode::Internal,
                "readback request ids exhausted",
            );
            return 0;
        };
        s.next_readback_id = next;
        let id = s.next_readback_id;
        s.readback = Readback {
            id,
            state: ReadbackState::Pending,
            ..Readback::default()
        };
        s.pending_readback = Some(id);
        id
    }

    #[wasm_bindgen(js_name = dispose)]
    pub fn dispose(&self) {
        let mut s = self.state.borrow_mut();
        if s.disposed {
            return;
        }
        s.disposed = true;
        let cleanup = release(&mut s);
        if !s.phase.terminal() {
            s.phase = Phase::Disposed;
            s.error = None;
            if let Err(error) = cleanup {
                s.phase = Phase::Failed;
                s.error = Some(ProofError::new(ErrorCode::Internal, error));
            }
        }
    }

    // Called once per animation frame by web/host.js. Not part of the public
    // `MqWebGpuProofHost` interface (docs/webgpu-proof-contract.md, section 4).
    #[wasm_bindgen(js_name = tick)]
    #[cfg(target_arch = "wasm32")]
    pub fn tick(&self) {
        tick(&self.state);
    }
}

fn set(object: &Object, key: &str, value: JsValue) {
    if !Reflect::set(object, &JsValue::from_str(key), &value).unwrap_throw() {
        wasm_bindgen::throw_str("cannot write a status field");
    }
}

fn rgba_js(pixel: Option<[u8; 4]>) -> JsValue {
    match pixel {
        None => JsValue::NULL,
        Some(bytes) => {
            let array = js_sys::Array::new();
            for byte in bytes {
                array.push(&JsValue::from_f64(f64::from(byte)));
            }
            array.into()
        }
    }
}

fn error_js(error: Option<&ProofError>) -> JsValue {
    match error {
        None => JsValue::NULL,
        Some(error) => {
            let object = Object::new();
            set(&object, "code", JsValue::from_str(error.code.as_str()));
            set(&object, "message", JsValue::from_str(&error.message));
            if let Some(reason) = error.reason {
                set(&object, "reason", JsValue::from_str(reason));
            }
            object.into()
        }
    }
}

fn build_status(s: &State) -> JsValue {
    let root = Object::new();
    set(&root, "contract", JsValue::from_str(CONTRACT));
    set(&root, "candidate", JsValue::from_str(CANDIDATE));
    set(&root, "reporter", JsValue::from_str("rust"));
    set(&root, "mode", JsValue::from_str(s.mode.as_str()));
    set(&root, "phase", JsValue::from_str(s.phase.as_str()));
    set(&root, "error", error_js(s.error.as_ref()));
    set(
        &root,
        "canvasFormat",
        s.canvas_format.map_or(JsValue::NULL, JsValue::from_str),
    );

    let surface = Object::new();
    set(
        &surface,
        "width",
        JsValue::from_f64(f64::from(s.surface_width)),
    );
    set(
        &surface,
        "height",
        JsValue::from_f64(f64::from(s.surface_height)),
    );
    set(&root, "surface", surface.into());

    set(
        &root,
        "frameCount",
        JsValue::from_f64(f64::from(s.frame_count)),
    );
    set(
        &root,
        "resizeCount",
        JsValue::from_f64(f64::from(s.resize_count)),
    );

    let input = Object::new();
    set(
        &input,
        "pointer",
        match &s.input.pointer {
            None => JsValue::NULL,
            Some(pointer) => {
                let object = Object::new();
                set(&object, "x", JsValue::from_f64(pointer.x));
                set(&object, "y", JsValue::from_f64(pointer.y));
                set(&object, "button", JsValue::from_str(pointer.button));
                set(&object, "down", JsValue::from_bool(pointer.down));
                object.into()
            }
        },
    );
    set(
        &input,
        "key",
        match &s.input.key {
            None => JsValue::NULL,
            Some(key) => {
                let object = Object::new();
                set(&object, "code", JsValue::from_str(&key.code));
                set(&object, "down", JsValue::from_bool(key.down));
                object.into()
            }
        },
    );
    set(&input, "focused", JsValue::from_bool(s.input.focused));
    set(
        &input,
        "focusChanges",
        JsValue::from_f64(f64::from(s.input.focus_changes)),
    );
    set(&root, "input", input.into());

    let readback = Object::new();
    set(&readback, "id", JsValue::from_f64(f64::from(s.readback.id)));
    set(
        &readback,
        "state",
        JsValue::from_str(s.readback.state.as_str()),
    );
    set(
        &readback,
        "width",
        JsValue::from_f64(f64::from(s.readback.width)),
    );
    set(
        &readback,
        "height",
        JsValue::from_f64(f64::from(s.readback.height)),
    );
    set(&readback, "center", rgba_js(s.readback.center));
    set(&readback, "corner", rgba_js(s.readback.corner));
    set(&readback, "error", error_js(s.readback.error.as_ref()));
    set(&root, "readback", readback.into());

    root.into()
}

fn add_listener<E, F>(
    state: &Rc<RefCell<State>>,
    target: &web_sys::EventTarget,
    kind: &'static str,
    mut handler: F,
) where
    E: JsCast + 'static,
    F: FnMut(&Rc<RefCell<State>>, E) + 'static,
{
    if state.borrow().phase.terminal() {
        return;
    }
    let state_for_closure = Rc::clone(state);
    let closure = Closure::<dyn FnMut(Event)>::new(move |event: Event| {
        if let Ok(typed) = event.dyn_into::<E>() {
            handler(&state_for_closure, typed);
        }
    });
    let callback: js_sys::Function = closure.as_ref().clone().unchecked_into();
    if let Err(error) = target.add_event_listener_with_callback(kind, &callback) {
        fail(
            state,
            ErrorCode::Internal,
            format!("add {kind} listener: {error:?}"),
        );
        return;
    }
    state.borrow_mut().listeners.push(Listener {
        target: target.clone(),
        kind,
        callback,
        _closure: Box::new(closure),
    });
}

fn pointer_button(event: &MouseEvent) -> &'static str {
    match event.button() {
        1 => "middle",
        2 => "right",
        _ => "left",
    }
}

fn attach_input_listeners(state: &Rc<RefCell<State>>, canvas: &HtmlCanvasElement) {
    let target: web_sys::EventTarget = canvas.clone().into();

    add_listener::<MouseEvent, _>(state, &target, "pointerdown", |state, event| {
        update_pointer(state, &event, true);
    });
    add_listener::<MouseEvent, _>(state, &target, "pointerup", |state, event| {
        update_pointer(state, &event, false);
    });
    add_listener::<KeyboardEvent, _>(state, &target, "keydown", |state, event| {
        update_key(state, &event, true);
    });
    add_listener::<KeyboardEvent, _>(state, &target, "keyup", |state, event| {
        update_key(state, &event, false);
    });
    add_listener::<FocusEvent, _>(state, &target, "focus", |state, _event| {
        update_focus(state, true);
    });
    add_listener::<FocusEvent, _>(state, &target, "blur", |state, _event| {
        update_focus(state, false);
    });
}

fn update_pointer(state: &Rc<RefCell<State>>, event: &MouseEvent, down: bool) {
    let mut s = state.borrow_mut();
    if s.disposed {
        return;
    }
    s.input.pointer = Some(PointerState {
        x: f64::from(event.offset_x()),
        y: f64::from(event.offset_y()),
        button: pointer_button(event),
        down,
    });
}

fn update_key(state: &Rc<RefCell<State>>, event: &KeyboardEvent, down: bool) {
    let mut s = state.borrow_mut();
    if s.disposed {
        return;
    }
    s.input.key = Some(KeyState {
        code: event.code(),
        down,
    });
}

fn update_focus(state: &Rc<RefCell<State>>, focused: bool) {
    let mut s = state.borrow_mut();
    if s.disposed {
        return;
    }
    if s.input.focused != focused {
        s.input.focus_changes += 1;
    }
    s.input.focused = focused;
}

// Map a browser-reported preferred canvas format to the contract's enum.
fn canvas_format_name(format: wgpu::TextureFormat) -> Option<&'static str> {
    match format {
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => Some("bgra8unorm"),
        wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba8UnormSrgb => Some("rgba8unorm"),
        _ => None,
    }
}

fn surface_config(
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
) -> wgpu::SurfaceConfiguration {
    wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        format,
        color_space: wgpu::SurfaceColorSpace::Auto,
        width,
        height,
        desired_maximum_frame_latency: 2,
        present_mode: wgpu::PresentMode::Fifo,
        alpha_mode: wgpu::CompositeAlphaMode::Opaque,
        view_formats: vec![],
    }
}

fn backing_size(css_width: i32, css_height: i32, ratio: f64) -> Result<(u32, u32), &'static str> {
    let dimension = |css: i32| {
        let pixels = (f64::from(css.max(1)) * ratio).floor();
        if !pixels.is_finite() || !(1.0..=f64::from(u32::MAX)).contains(&pixels) {
            return Err("canvas backing size is outside the supported range");
        }
        Ok(pixels as u32)
    };
    Ok((dimension(css_width)?, dimension(css_height)?))
}

fn validate_surface_size(
    (width, height): (u32, u32),
    limits: &wgpu::Limits,
) -> Result<(), &'static str> {
    let row = width
        .checked_mul(4)
        .and_then(|bytes| bytes.checked_add(ROW_ALIGNMENT - 1))
        .map(|bytes| bytes / ROW_ALIGNMENT * ROW_ALIGNMENT)
        .ok_or("canvas row size overflow")?;
    let bytes = u64::from(row) * u64::from(height);
    if width == 0
        || height == 0
        || width > limits.max_texture_dimension_2d
        || height > limits.max_texture_dimension_2d
        || bytes > limits.max_buffer_size.min(u64::from(u32::MAX))
    {
        return Err("canvas exceeds texture or readback limits");
    }
    Ok(())
}

fn canvas_size(
    canvas: &HtmlCanvasElement,
    device: &wgpu::Device,
) -> Result<(u32, u32), &'static str> {
    let window = web_sys::window().ok_or("no window object")?;
    let size = backing_size(
        canvas.client_width(),
        canvas.client_height(),
        window.device_pixel_ratio(),
    )?;
    validate_surface_size(size, &device.limits())?;
    Ok(size)
}

#[cfg(target_arch = "wasm32")]
async fn start(state: Rc<RefCell<State>>, mode: Mode, canvas: HtmlCanvasElement) {
    if state.borrow().phase.terminal() {
        return;
    }
    let Some(window) = web_sys::window() else {
        fail(&state, ErrorCode::Internal, "no window object");
        return;
    };
    if !window.is_secure_context() {
        fail(
            &state,
            ErrorCode::InsecureContext,
            "isSecureContext is false",
        );
        return;
    }
    let navigator = window.navigator();
    let gpu = match Reflect::get(&navigator, &JsValue::from_str("gpu")) {
        Ok(gpu) => gpu,
        Err(error) => {
            fail(
                &state,
                ErrorCode::Internal,
                format!("navigator.gpu getter failed: {error:?}"),
            );
            return;
        }
    };
    if gpu.is_undefined() || gpu.is_null() {
        fail(
            &state,
            ErrorCode::ApiUnavailable,
            "navigator.gpu is missing",
        );
        return;
    }

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::BROWSER_WEBGPU,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });

    let adapter = match instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
    {
        Ok(adapter) => adapter,
        Err(error) => {
            fail(
                &state,
                ErrorCode::AdapterUnavailable,
                format!("requestAdapter failed: {error}"),
            );
            return;
        }
    };

    if state.borrow().phase.terminal() {
        return;
    }
    let (device, queue) = match adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
    {
        Ok(pair) => pair,
        Err(error) => {
            fail(
                &state,
                ErrorCode::DeviceRequestFailed,
                format!("requestDevice failed: {error}"),
            );
            return;
        }
    };

    if state.borrow().phase.terminal() {
        device.destroy();
        return;
    }
    state.borrow_mut().pending_device = Some(device.clone());
    let (events, receiver) = mpsc::channel();
    let lost_events = events.clone();
    device.set_device_lost_callback(move |reason, _| {
        let _ = lost_events.send(DeviceEvent::Lost(reason));
    });
    device.on_uncaptured_error(Arc::new(move |error| {
        let _ = events.send(DeviceEvent::Error(error.to_string()));
    }));
    state.borrow_mut().gpu_events = Some(receiver);
    if state.borrow().phase.terminal() {
        device.destroy();
        return;
    }

    let surface = match instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone())) {
        Ok(surface) => surface,
        Err(error) => {
            fail(
                &state,
                ErrorCode::CanvasContextUnavailable,
                format!("getContext(\"webgpu\") failed: {error}"),
            );
            return;
        }
    };

    let capabilities = surface.get_capabilities(&adapter);
    let Some(format) = capabilities.formats.first().copied() else {
        fail(
            &state,
            ErrorCode::CanvasContextUnavailable,
            "surface has no supported format",
        );
        return;
    };
    let Some(canvas_format) = canvas_format_name(format) else {
        fail(
            &state,
            ErrorCode::Internal,
            "preferred canvas format is outside the contract enum",
        );
        return;
    };

    let shader_text = match mode {
        Mode::Render => TRIANGLE_WGSL,
        Mode::InvalidWgsl => INVALID_WGSL,
    };
    let shader_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("webgpu-wgpu-proof shader"),
        source: wgpu::ShaderSource::Wgsl(shader_text.into()),
    });
    let compilation = shader.get_compilation_info().await;
    let shader_validation = shader_scope.pop().await;
    if state.borrow().phase.terminal() {
        return;
    }
    if let Some(error_message) = compilation
        .messages
        .iter()
        .find(|message| message.message_type == wgpu::CompilationMessageType::Error)
    {
        fail(
            &state,
            ErrorCode::ShaderCompilation,
            error_message.message.clone(),
        );
        return;
    }
    if let Some(error) = shader_validation {
        fail(&state, ErrorCode::ShaderCompilation, error.to_string());
        return;
    }

    let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("webgpu-wgpu-proof layout"),
        bind_group_layouts: &[],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("webgpu-wgpu-proof pipeline"),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });
    if let Some(validation_error) = error_scope.pop().await {
        fail(
            &state,
            ErrorCode::PipelineCreation,
            validation_error.to_string(),
        );
        return;
    }

    if state.borrow().phase.terminal() {
        return;
    }
    let (width, height) = match canvas_size(&canvas, &device) {
        Ok(size) => size,
        Err(error) => {
            fail(&state, ErrorCode::Internal, error);
            return;
        }
    };
    canvas.set_width(width);
    canvas.set_height(height);
    surface.configure(&device, &surface_config(format, width, height));

    {
        let mut s = state.borrow_mut();
        if s.phase.terminal() {
            return;
        }
        s.canvas_format = Some(canvas_format);
        s.surface_width = width;
        s.surface_height = height;
        s.gpu = Some(GpuState {
            device,
            queue,
            surface,
            pipeline,
            format,
            canvas,
        });
        s.pending_device = None;
        s.phase = Phase::Running;
    }
}

#[cfg(target_arch = "wasm32")]
fn tick(state: &Rc<RefCell<State>>) {
    let event = state
        .borrow()
        .gpu_events
        .as_ref()
        .and_then(|events| events.try_recv().ok());
    match event {
        Some(DeviceEvent::Lost(reason)) => lose(
            state,
            match reason {
                wgpu::DeviceLostReason::Destroyed => "destroyed",
                _ => "unknown",
            },
        ),
        Some(DeviceEvent::Error(message)) => fail(state, ErrorCode::Internal, message),
        None => {}
    }
    let (device, queue, texture_result, pending_readback, surface_size);
    {
        let mut s = state.borrow_mut();
        if s.phase != Phase::Running {
            return;
        }
        let (new_width, new_height, resized) = {
            let Some(gpu) = s.gpu.as_ref() else { return };
            let (new_width, new_height) = match canvas_size(&gpu.canvas, &gpu.device) {
                Ok(size) => size,
                Err(error) => {
                    drop(s);
                    fail(state, ErrorCode::Internal, error);
                    return;
                }
            };
            let resized = new_width != s.surface_width || new_height != s.surface_height;
            if resized {
                gpu.canvas.set_width(new_width);
                gpu.canvas.set_height(new_height);
                gpu.surface.configure(
                    &gpu.device,
                    &surface_config(gpu.format, new_width, new_height),
                );
            }
            texture_result = gpu.surface.get_current_texture();
            device = gpu.device.clone();
            queue = gpu.queue.clone();
            (new_width, new_height, resized)
        };
        if resized {
            s.surface_width = new_width;
            s.surface_height = new_height;
            s.resize_count += 1;
        }

        pending_readback = if matches!(
            &texture_result,
            wgpu::CurrentSurfaceTexture::Success(_) | wgpu::CurrentSurfaceTexture::Suboptimal(_)
        ) {
            s.pending_readback.take()
        } else {
            None
        };
        surface_size = (s.surface_width, s.surface_height);
    }

    match texture_result {
        wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {}
        wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
            reconfigure_surface(state);
        }
        wgpu::CurrentSurfaceTexture::Validation => {
            fail(
                state,
                ErrorCode::Internal,
                "surface validation error on get_current_texture",
            );
        }
        wgpu::CurrentSurfaceTexture::Success(surface_texture)
        | wgpu::CurrentSurfaceTexture::Suboptimal(surface_texture) => {
            render_and_present(
                state,
                &device,
                &queue,
                surface_texture,
                pending_readback,
                surface_size,
            );
        }
    }
}

fn reconfigure_surface(state: &Rc<RefCell<State>>) {
    let s = state.borrow();
    if let Some(gpu) = s.gpu.as_ref() {
        gpu.surface.configure(
            &gpu.device,
            &surface_config(gpu.format, s.surface_width, s.surface_height),
        );
    }
}

#[cfg(target_arch = "wasm32")]
fn render_and_present(
    state: &Rc<RefCell<State>>,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    surface_texture: wgpu::SurfaceTexture,
    pending_readback: Option<u32>,
    (width, height): (u32, u32),
) {
    let view = surface_texture
        .texture
        .create_view(&wgpu::TextureViewDescriptor::default());
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("webgpu-wgpu-proof frame"),
    });
    {
        let pipeline = {
            let s = state.borrow();
            s.gpu.as_ref().map(|gpu| gpu.pipeline.clone())
        };
        let Some(pipeline) = pipeline else { return };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("webgpu-wgpu-proof pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: 0.0,
                        g: 0.0,
                        b: 1.0,
                        a: 1.0,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&pipeline);
        pass.draw(0..3, 0..1);
    }

    let readback_copy = pending_readback.map(|id| {
        let unpadded = width * 4;
        let padded = unpadded.div_ceil(ROW_ALIGNMENT) * ROW_ALIGNMENT;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("webgpu-wgpu-proof readback"),
            size: u64::from(padded) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &surface_texture.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        (id, buffer, padded)
    });

    queue.submit(Some(encoder.finish()));
    queue.present(surface_texture);

    {
        let mut s = state.borrow_mut();
        if s.phase == Phase::Running {
            s.frame_count += 1;
        }
    }

    if let Some((id, buffer, padded_bytes_per_row)) = readback_copy {
        let is_bgra = {
            let s = state.borrow();
            s.gpu
                .as_ref()
                .map(|gpu| {
                    gpu.format == wgpu::TextureFormat::Bgra8Unorm
                        || gpu.format == wgpu::TextureFormat::Bgra8UnormSrgb
                })
                .unwrap_or(false)
        };
        let state_for_map = Rc::clone(state);
        let buffer = Rc::new(buffer);
        let buffer_for_map = Rc::clone(&buffer);
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                finish_readback(
                    &state_for_map,
                    &buffer_for_map,
                    id,
                    (width, height),
                    padded_bytes_per_row,
                    is_bgra,
                    result,
                );
            });
    }
}

fn finish_readback(
    state: &Rc<RefCell<State>>,
    buffer: &wgpu::Buffer,
    id: u32,
    (width, height): (u32, u32),
    padded_bytes_per_row: u32,
    is_bgra: bool,
    result: Result<(), wgpu::BufferAsyncError>,
) {
    let mut s = state.borrow_mut();
    // A new request replaces the old result; a late result for an old id is discarded.
    if s.readback.id != id || s.phase != Phase::Running {
        if result.is_ok() {
            buffer.unmap();
        }
        buffer.destroy();
        return;
    }
    match result {
        Err(error) => {
            s.readback.state = ReadbackState::Failed;
            s.readback.error = Some(ProofError::new(
                ErrorCode::ReadbackFailed,
                error.to_string(),
            ));
        }
        Ok(()) => {
            let view = match buffer.slice(..).get_mapped_range() {
                Ok(view) => view,
                Err(error) => {
                    s.readback.state = ReadbackState::Failed;
                    s.readback.error = Some(ProofError::new(
                        ErrorCode::ReadbackFailed,
                        error.to_string(),
                    ));
                    buffer.destroy();
                    return;
                }
            };
            let read_pixel = |x: u32, y: u32| -> [u8; 4] {
                let row = (y * padded_bytes_per_row) as usize;
                let col = (x * 4) as usize;
                let p = row + col;
                let b = [view[p], view[p + 1], view[p + 2], view[p + 3]];
                if is_bgra {
                    [b[2], b[1], b[0], b[3]]
                } else {
                    b
                }
            };
            let center = read_pixel(width / 2, height / 2);
            let corner = read_pixel(0, 0);
            drop(view);
            buffer.unmap();
            s.readback.state = ReadbackState::Ready;
            s.readback.width = width;
            s.readback.height = height;
            s.readback.center = Some(center);
            s.readback.corner = Some(corner);
            s.readback.error = None;
        }
    }
    buffer.destroy();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_messages_keep_complete_utf8_within_the_byte_limit() {
        for text in [
            "\u{e9}".repeat(4096),
            "\u{1f600}".repeat(2048),
            format!("{}\u{e9}", "a".repeat(4095)),
        ] {
            let clipped = clip_message(text);
            assert!(clipped.len() <= MAX_MESSAGE_BYTES);
            assert!(std::str::from_utf8(clipped.as_bytes()).is_ok());
        }
        assert!(!clip_message("").is_empty());
    }

    #[test]
    fn disposal_preserves_a_failed_or_lost_terminal_status() {
        for lost in [false, true] {
            let state = Rc::new(RefCell::new(State::new(Mode::Render)));
            if lost {
                lose(&state, "destroyed");
            } else {
                fail(&state, ErrorCode::ShaderCompilation, "invalid shader");
            }
            let before = state.borrow().phase.as_str();
            let app = ProofApp { state };
            app.dispose();
            app.dispose();
            assert_eq!(app.state.borrow().phase.as_str(), before);
            assert!(app.state.borrow().error.is_some());
            assert_eq!(app.request_readback(), 0);
        }
    }

    #[test]
    fn exhausted_readback_ids_fail_instead_of_wrapping_or_panicking() {
        let state = Rc::new(RefCell::new(State::new(Mode::Render)));
        state.borrow_mut().phase = Phase::Running;
        state.borrow_mut().next_readback_id = u32::MAX;
        let app = ProofApp { state };
        assert_eq!(app.request_readback(), 0);
        assert_eq!(app.state.borrow().phase.as_str(), "failed");
        assert_eq!(
            app.state.borrow().error.as_ref().unwrap().code.as_str(),
            "internal"
        );
    }

    #[test]
    fn backing_size_uses_the_pixel_ratio_and_rejects_invalid_dimensions() {
        assert_eq!(backing_size(321, 201, 1.5), Ok((481, 301)));
        for ratio in [f64::NAN, f64::INFINITY, -1.0, 0.0, f64::MAX] {
            assert!(backing_size(256, 256, ratio).is_err());
        }

        #[test]
        fn surface_sizes_respect_texture_buffer_and_address_limits() {
            let limits = wgpu::Limits::default();
            assert!(validate_surface_size((320, 200), &limits).is_ok());
            assert!(
                validate_surface_size((limits.max_texture_dimension_2d + 1, 200), &limits).is_err()
            );
            assert!(validate_surface_size((0, 200), &limits).is_err());
            let limits = wgpu::Limits {
                max_buffer_size: 1024,
                ..limits
            };
            assert!(validate_surface_size((320, 200), &limits).is_err());
            let limits = wgpu::Limits {
                max_texture_dimension_2d: u32::MAX,
                max_buffer_size: u64::MAX,
                ..limits
            };
            assert!(validate_surface_size((u32::MAX, 1), &limits).is_err());
            assert!(validate_surface_size((1, u32::MAX), &limits).is_err());
        }
    }
}
