#![allow(dead_code)]

#[cfg(not(target_os = "android"))]
use std::sync::mpsc;

#[derive(Default)]
pub(crate) struct DroppedFiles {
    pub paths: Vec<std::path::PathBuf>,
    pub bytes: Vec<Vec<u8>>,
}
pub(crate) struct NativeDisplayData {
    pub screen_width: i32,
    pub screen_height: i32,
    pub screen_position: (u32, u32),
    pub dpi_scale: f32,
    pub high_dpi: bool,
    pub quit_requested: bool,
    pub quit_ordered: bool,
    #[cfg(target_os = "android")]
    pub native_requests: Box<dyn Fn(Request) + Send>,
    #[cfg(not(target_os = "android"))]
    pub native_requests: mpsc::Sender<Request>,
    pub clipboard: Box<dyn Clipboard>,
    pub dropped_files: DroppedFiles,
    pub blocking_event_loop: bool,

    #[cfg(target_vendor = "apple")]
    pub view: crate::native::apple::frameworks::ObjcId,
    #[cfg(any(target_os = "ios", target_os = "tvos"))]
    pub view_ctrl: crate::native::apple::frameworks::ObjcId,
    #[cfg(target_vendor = "apple")]
    pub gfx_api: crate::conf::AppleGfxApi,
}
#[cfg(target_vendor = "apple")]
unsafe impl Send for NativeDisplayData {}
#[cfg(target_vendor = "apple")]
unsafe impl Sync for NativeDisplayData {}

impl NativeDisplayData {
    pub fn new(
        screen_width: i32,
        screen_height: i32,
        #[cfg(target_os = "android")] native_requests: Box<dyn Fn(Request) + Send>,
        #[cfg(not(target_os = "android"))] native_requests: mpsc::Sender<Request>,
        clipboard: Box<dyn Clipboard>,
    ) -> NativeDisplayData {
        NativeDisplayData {
            screen_width,
            screen_height,
            screen_position: (0, 0),
            dpi_scale: 1.,
            high_dpi: false,
            quit_requested: false,
            quit_ordered: false,
            native_requests,
            clipboard,
            dropped_files: Default::default(),
            blocking_event_loop: false,
            #[cfg(target_vendor = "apple")]
            gfx_api: crate::conf::AppleGfxApi::OpenGl,
            #[cfg(target_vendor = "apple")]
            view: std::ptr::null_mut(),
            #[cfg(any(target_os = "ios", target_os = "tvos"))]
            view_ctrl: std::ptr::null_mut(),
        }
    }
}

#[derive(Debug)]
pub(crate) enum Request {
    ScheduleUpdate,
    SetCursorGrab(bool),
    ShowMouse(bool),
    SetMouseCursor(crate::CursorIcon),
    SetWindowSize { new_width: u32, new_height: u32 },
    SetWindowPosition { new_x: u32, new_y: u32 },
    SetFullscreen(bool),
    ShowKeyboard(bool),
    SetImePosition { x: i32, y: i32 },
    SetImeEnabled(bool),
}

pub trait Clipboard: Send + Sync {
    fn get(&mut self) -> Option<String>;
    fn set(&mut self, string: &str);
}

pub mod module;

#[cfg(target_os = "linux")]
pub mod linux_x11;

#[cfg(target_os = "linux")]
pub mod linux_wayland;

#[cfg(target_os = "android")]
pub mod android;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "android")]
pub use android::*;

#[cfg(target_arch = "wasm32")]
pub mod wasm;

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "tvos"))]
pub mod apple;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(any(target_os = "ios", target_os = "tvos"))]
pub mod ios;

#[cfg(any(target_os = "android", target_os = "linux"))]
pub mod egl;

// there is no glGetProcAddr on webgl, so its impossible to make "gl" module work
// on macos.. well, there is, but way easier to just statically link to gl
#[cfg(not(target_arch = "wasm32"))]
pub mod gl;

#[cfg(target_arch = "wasm32")]
pub use wasm::webgl as gl;

pub mod query_stab;

/// Run the quit callback without the display lock. Return whether to finish.
#[cfg(any(target_os = "android", test))]
pub(crate) fn drive_android_quit_state(
    display: &std::sync::Mutex<NativeDisplayData>,
    confirm_quit: impl FnOnce(),
) -> bool {
    let needs_confirmation = {
        let d = display.lock().unwrap();
        d.quit_requested && !d.quit_ordered
    };

    if needs_confirmation {
        confirm_quit();

        let mut d = display.lock().unwrap();
        d.quit_ordered = d.quit_ordered || d.quit_requested;
    }

    display.lock().unwrap().quit_ordered
}

#[cfg(test)]
mod android_quit_state_tests {
    use super::{drive_android_quit_state, Clipboard, NativeDisplayData};
    use std::sync::Mutex;

    struct NoopClipboard;
    impl Clipboard for NoopClipboard {
        fn get(&mut self) -> Option<String> {
            None
        }
        fn set(&mut self, _string: &str) {}
    }

    fn display_with(quit_requested: bool, quit_ordered: bool) -> Mutex<NativeDisplayData> {
        #[cfg(not(target_os = "android"))]
        let (tx, _rx) = std::sync::mpsc::channel();
        #[cfg(target_os = "android")]
        let tx = Box::new(|_| {});
        let mut data = NativeDisplayData::new(0, 0, tx, Box::new(NoopClipboard));
        data.quit_requested = quit_requested;
        data.quit_ordered = quit_ordered;
        Mutex::new(data)
    }

    #[test]
    fn confirmed_quit_is_ordered_without_deadlocking() {
        let display = display_with(true, false);

        let quit_ordered = drive_android_quit_state(&display, || {
            let _ = display.try_lock().unwrap().quit_requested;
        });

        assert!(quit_ordered);
        assert!(display.lock().unwrap().quit_ordered);
    }

    #[test]
    fn cancel_quit_inside_confirm_keeps_activity_open() {
        let display = display_with(true, false);

        let quit_ordered = drive_android_quit_state(&display, || {
            display.try_lock().unwrap().quit_requested = false;
        });

        assert!(!quit_ordered);
        assert!(!display.lock().unwrap().quit_ordered);
    }

    #[test]
    fn already_ordered_quit_skips_reconfirmation() {
        let display = display_with(true, true);

        let quit_ordered = drive_android_quit_state(&display, || {
            panic!("confirm_quit must not run once quit_ordered is already true");
        });

        assert!(quit_ordered);
    }

    #[test]
    fn idle_frame_keeps_running_without_confirmation() {
        let display = display_with(false, false);
        assert!(!drive_android_quit_state(&display, || {
            panic!("an idle frame must not request quit confirmation");
        }));
    }

    #[test]
    fn order_quit_inside_confirmation_overrides_cancel() {
        let display = display_with(true, false);
        assert!(drive_android_quit_state(&display, || {
            let mut d = display.try_lock().unwrap();
            d.quit_ordered = true;
            d.quit_requested = false;
        }));
    }
}
