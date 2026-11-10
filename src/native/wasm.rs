pub mod fs;
pub mod webgl;

mod keycodes;

use std::{
    cell::RefCell,
    collections::HashMap,
    path::PathBuf,
    sync::{mpsc::Receiver, Mutex, OnceLock},
    thread_local,
};

use crate::{
    event::EventHandler,
    native::{NativeDisplayData, Request},
};

// fn dropped_file_count(&mut self) -> usize {
//     self.dropped_files.bytes.len()
// }
// fn dropped_file_bytes(&mut self, index: usize) -> Option<Vec<u8>> {
//     self.dropped_files.bytes.get(index).cloned()
// }
// fn dropped_file_path(&mut self, index: usize) -> Option<PathBuf> {
//     self.dropped_files.paths.get(index).cloned()
// }

thread_local! {
    static EVENT_HANDLER: RefCell<Option<Box<dyn EventHandler>>> = RefCell::new(None);
    static REQUESTS: RefCell<Option<Receiver<Request>>> = const { RefCell::new(None) };
    static TRANSFER_BUFFERS: RefCell<TransferRegistry> = RefCell::new(TransferRegistry::default());
}
fn tl_event_handler<T, F: FnOnce(&mut dyn EventHandler) -> T>(f: F) -> T {
    EVENT_HANDLER.with(|globals| {
        let mut globals = globals.borrow_mut();
        let globals: &mut Box<dyn EventHandler> = globals.as_mut().unwrap();
        f(&mut **globals)
    })
}

static mut CURSOR_ICON: crate::CursorIcon = crate::CursorIcon::Default;
static mut CURSOR_SHOW: bool = true;

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct sapp_touchpoint {
    pub identifier: usize,
    pub pos_x: f32,
    pub pos_y: f32,
    pub changed: bool,
}

pub fn run<F>(conf: &crate::conf::Conf, f: F)
where
    F: 'static + FnOnce() -> Box<dyn EventHandler>,
{
    {
        use std::ffi::CString;
        use std::panic;

        panic::set_hook(Box::new(|info| {
            let msg = CString::new(format!("{:?}", info)).unwrap_or_else(|_| {
                CString::new(format!("MALFORMED ERROR MESSAGE {:?}", info.location())).unwrap()
            });
            unsafe { console_log(msg.as_ptr()) };
        }));
    }

    let version = match conf.platform.webgl_version {
        crate::conf::WebGLVersion::WebGL1 => 1,
        crate::conf::WebGLVersion::WebGL2 => 2,
    };
    unsafe {
        init_webgl(version);
    }

    // setup initial canvas size
    unsafe {
        setup_canvas_size(conf.high_dpi);
    }

    let (tx, rx) = std::sync::mpsc::channel();
    REQUESTS.with(|r| *r.borrow_mut() = Some(rx));
    let w = unsafe { canvas_width() as _ };
    let h = unsafe { canvas_height() as _ };
    let dpi_scale = unsafe { dpi_scale() };
    let clipboard = Box::new(Clipboard);
    crate::set_display(NativeDisplayData {
        blocking_event_loop: conf.platform.blocking_event_loop,
        dpi_scale,
        ..NativeDisplayData::new(w, h, tx, clipboard)
    });
    EVENT_HANDLER.with(|g| {
        *g.borrow_mut() = Some(f());
    });

    // start requestAnimationFrame loop
    unsafe {
        run_animation_loop(conf.platform.blocking_event_loop);
    }
}

pub unsafe fn sapp_width() -> ::core::ffi::c_int {
    canvas_width()
}

pub unsafe fn sapp_height() -> ::core::ffi::c_int {
    canvas_height()
}

#[link(wasm_import_module = "env")]
extern "C" {
    pub fn setup_canvas_size(high_dpi: bool);
    pub fn run_animation_loop(blocking: bool);
    pub fn canvas_width() -> i32;
    pub fn canvas_height() -> i32;
    pub fn dpi_scale() -> f32;
    pub fn console_debug(msg: *const ::core::ffi::c_char);
    pub fn console_log(msg: *const ::core::ffi::c_char);
    pub fn console_info(msg: *const ::core::ffi::c_char);
    pub fn console_warn(msg: *const ::core::ffi::c_char);
    pub fn console_error(msg: *const ::core::ffi::c_char);

    pub fn sapp_set_clipboard(clipboard: *const i8, len: usize);

    /// call "requestPointerLock" and "exitPointerLock" internally.
    /// Will hide cursor and will disable mouse_move events, but instead will
    /// will make inifinite mouse field for raw_device_input event.
    /// Notice that this function will works only from "engaging" event callbacks - from
    /// "mouse_down"/"key_down" event handler functions.
    pub fn sapp_set_cursor_grab(grab: bool);

    pub fn sapp_set_cursor(cursor: *const u8, len: usize);

    pub fn sapp_is_elapsed_timer_supported() -> bool;

    pub fn sapp_set_fullscreen(fullscreen: bool);
    pub fn sapp_is_fullscreen() -> bool;
    pub fn sapp_set_window_size(new_width: u32, new_height: u32);
    pub fn sapp_schedule_update();
    pub fn init_webgl(version: i32);
    pub fn now() -> f64;
}

unsafe fn show_mouse(shown: bool) {
    if shown != CURSOR_SHOW {
        CURSOR_SHOW = shown;
        update_cursor();
    }
}

unsafe fn set_mouse_cursor(icon: crate::CursorIcon) {
    if CURSOR_ICON != icon {
        CURSOR_ICON = icon;
        if CURSOR_SHOW {
            update_cursor();
        }
    }
}

pub unsafe fn update_cursor() {
    let css_name = if !CURSOR_SHOW {
        "none"
    } else {
        match CURSOR_ICON {
            crate::CursorIcon::Default => "default",
            crate::CursorIcon::Help => "help",
            crate::CursorIcon::Pointer => "pointer",
            crate::CursorIcon::Wait => "wait",
            crate::CursorIcon::Crosshair => "crosshair",
            crate::CursorIcon::Text => "text",
            crate::CursorIcon::Move => "move",
            crate::CursorIcon::NotAllowed => "not-allowed",
            crate::CursorIcon::EWResize => "ew-resize",
            crate::CursorIcon::NSResize => "ns-resize",
            crate::CursorIcon::NESWResize => "nesw-resize",
            crate::CursorIcon::NWSEResize => "nwse-resize",
        }
    };
    sapp_set_cursor(css_name.as_ptr(), css_name.len());
}

// gl.js version required to be shipped alongside this rust code.
// "crate_version" is a misleading, but it can't be changed for legacy reasons.
#[no_mangle]
pub extern "C" fn crate_version() -> u32 {
    3
}

#[no_mangle]
pub extern "C" fn allocate_vec_u8(len: usize) -> *mut u8 {
    let mut string = vec![0u8; len];
    let ptr = string.as_mut_ptr();
    string.leak();
    ptr
}

// Only buffers created by this allocator may cross the JS-to-Rust ownership
// boundary. Unknown pointers and duplicate transfers never reach a raw-parts
// constructor. An allocation with zero logical bytes still gets a unique pointer.
const MAX_TRANSFER_ALLOCATION: usize = 64 * 1024 * 1024;
const MAX_TRANSFER_OUTSTANDING: usize = 64 * 1024 * 1024 + 4096;
const MAX_TRANSFER_COUNT: usize = 256;

#[derive(Default)]
struct TransferRegistry {
    buffers: HashMap<usize, (usize, Vec<u8>)>,
    reserved: usize,
}

#[no_mangle]
pub extern "C" fn allocate_transfer_vec_u8(len: usize) -> *mut u8 {
    if len > MAX_TRANSFER_ALLOCATION {
        return std::ptr::null_mut();
    }
    TRANSFER_BUFFERS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let size = len.max(1);
        if registry.buffers.len() >= MAX_TRANSFER_COUNT
            || size > MAX_TRANSFER_OUTSTANDING.saturating_sub(registry.reserved)
        {
            return std::ptr::null_mut();
        }
        let mut bytes = Vec::new();
        if bytes.try_reserve_exact(size).is_err() {
            return std::ptr::null_mut();
        }
        bytes.resize(size, 0);
        let ptr = bytes.as_mut_ptr();
        registry.reserved += size;
        registry.buffers.insert(ptr as usize, (len, bytes));
        ptr
    })
}

// A claim consumes the allocation exactly once. A mismatched length also
// removes and drops the registered allocation rather than trusting its metadata.
fn take_transfer_vec_u8(ptr: *mut u8, len: usize) -> Option<Vec<u8>> {
    TRANSFER_BUFFERS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let (expected_len, mut bytes) = registry.buffers.remove(&(ptr as usize))?;
        registry.reserved -= bytes.len();
        if expected_len != len {
            return None;
        }
        bytes.truncate(len);
        Some(bytes)
    })
}

#[no_mangle]
pub extern "C" fn discard_transfer_vec_u8(ptr: *mut u8) {
    TRANSFER_BUFFERS.with(|registry| {
        let mut registry = registry.borrow_mut();
        if let Some((_, bytes)) = registry.buffers.remove(&(ptr as usize)) {
            registry.reserved -= bytes.len();
        }
    });
}

static CLIPBOARD: OnceLock<Mutex<Option<String>>> = OnceLock::new();
struct Clipboard;
impl crate::native::Clipboard for Clipboard {
    fn get(&mut self) -> Option<String> {
        CLIPBOARD
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap()
            .clone()
    }

    fn set(&mut self, data: &str) {
        // The JS import takes a byte length. Interior NUL bytes are valid UTF-8
        // and must not cause a CString conversion panic or silent truncation.
        unsafe { sapp_set_clipboard(data.as_ptr().cast(), data.len()) };
    }
}

#[no_mangle]
pub extern "C" fn on_clipboard_paste(msg: *mut u8, len: usize) {
    // Reject forged, repeated or incorrectly sized transfers without
    // dereferencing caller-provided raw pointers.
    let Some(bytes) = take_transfer_vec_u8(msg, len) else {
        return;
    };
    if let Ok(text) = String::from_utf8(bytes) {
        *CLIPBOARD.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(text);
    }
}

#[no_mangle]
pub extern "C" fn frame() {
    REQUESTS.with(|r| {
        while let Ok(request) = r.borrow_mut().as_mut().unwrap().try_recv() {
            match request {
                Request::SetCursorGrab(grab) => unsafe { sapp_set_cursor_grab(grab) },
                Request::ShowMouse(show) => unsafe { show_mouse(show) },
                Request::SetMouseCursor(cursor) => unsafe {
                    set_mouse_cursor(cursor);
                },
                Request::SetFullscreen(fullscreen) => unsafe {
                    sapp_set_fullscreen(fullscreen);
                },
                _ => {}
            }
        }
    });
    tl_event_handler(|event_handler| {
        event_handler.update();
        event_handler.draw();
    });
}

#[no_mangle]
pub extern "C" fn mouse_move(x: i32, y: i32) {
    tl_event_handler(|event_handler| {
        event_handler.mouse_motion_event(x as _, y as _);
    });
}

#[no_mangle]
pub extern "C" fn raw_mouse_move(dx: i32, dy: i32) {
    tl_event_handler(|event_handler| {
        event_handler.raw_mouse_motion(dx as _, dy as _);
    });
}

#[no_mangle]
pub extern "C" fn mouse_down(x: i32, y: i32, btn: i32) {
    let btn = keycodes::translate_mouse_button(btn);

    tl_event_handler(|event_handler| {
        event_handler.mouse_button_down_event(btn, x as _, y as _);
    });
}

#[no_mangle]
pub extern "C" fn mouse_up(x: i32, y: i32, btn: i32) {
    let btn = keycodes::translate_mouse_button(btn);

    tl_event_handler(|event_handler| {
        event_handler.mouse_button_up_event(btn, x as _, y as _);
    });
}

#[no_mangle]
pub extern "C" fn mouse_wheel(dx: i32, dy: i32) {
    tl_event_handler(|event_handler| {
        event_handler.mouse_wheel_event(dx as _, dy as _);
    });
}

#[no_mangle]
pub extern "C" fn key_down(key: u32, modifiers: u32, repeat: bool) {
    let key = keycodes::translate_keycode(key as _);
    let mods = keycodes::translate_mod(modifiers as _);

    tl_event_handler(|event_handler| {
        event_handler.key_down_event(key, mods, repeat);
    });
}

#[no_mangle]
pub extern "C" fn key_press(key: u32) {
    if let Some(key) = char::from_u32(key) {
        tl_event_handler(|event_handler| {
            event_handler.char_event(key, crate::KeyMods::default(), false);
        });
    }
}

#[no_mangle]
pub extern "C" fn key_up(key: u32, modifiers: u32) {
    let key = keycodes::translate_keycode(key as _);
    let mods = keycodes::translate_mod(modifiers as _);

    tl_event_handler(|event_handler| {
        event_handler.key_up_event(key, mods);
    });
}

#[no_mangle]
pub extern "C" fn resize(width: i32, height: i32) {
    {
        let mut d = crate::native_display().lock().unwrap();
        d.screen_width = width as _;
        d.screen_height = height as _;
    }
    tl_event_handler(|event_handler| {
        event_handler.resize_event(width as _, height as _);
    });
}

#[no_mangle]
pub extern "C" fn touch(phase: u32, id: u32, x: f32, y: f32) {
    let phase = keycodes::translate_touch_phase(phase as _);
    tl_event_handler(|event_handler| {
        event_handler.touch_event(phase, id as _, x as _, y as _);
    });
}

#[no_mangle]
pub extern "C" fn focus(has_focus: bool) {
    tl_event_handler(|event_handler| {
        if has_focus {
            event_handler.window_restored_event();
        } else {
            event_handler.window_minimized_event();
        }
    });
}

#[no_mangle]
pub extern "C" fn on_files_dropped_start() {
    let mut d = crate::native_display().lock().unwrap();
    d.dropped_files = Default::default();
}

#[no_mangle]
pub extern "C" fn on_files_dropped_finish() {
    tl_event_handler(|event_handler| event_handler.files_dropped_event());
}

#[no_mangle]
pub extern "C" fn on_file_dropped(
    path: *mut u8,
    path_len: usize,
    bytes: *mut u8,
    bytes_len: usize,
) {
    // Consume both allocations even if one is invalid, so a malformed
    // transfer does not leave the second buffer registered indefinitely.
    let path_bytes = take_transfer_vec_u8(path, path_len);
    let bytes = take_transfer_vec_u8(bytes, bytes_len);
    if let (Some(path_bytes), Some(bytes)) = (path_bytes, bytes) {
        if let Ok(path) = String::from_utf8(path_bytes) {
            let mut d = crate::native_display().lock().unwrap();
            d.dropped_files.paths.push(PathBuf::from(path));
            d.dropped_files.bytes.push(bytes);
        }
    }
}
