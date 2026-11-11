use crate::{
    event::{EventHandler, KeyCode, KeyMods, TouchPhase},
    native::{
        egl::{self, LibEgl},
        NativeDisplayData,
    },
};

use std::{cell::RefCell, sync::mpsc, thread, time::Duration};

pub use crate::native::gl::{self, *};

mod keycodes;

pub use ndk_sys;

pub mod ndk_utils;

#[no_mangle]
pub unsafe extern "C" fn JNI_OnLoad(
    vm: *mut ndk_sys::JavaVM,
    _: std::ffi::c_void,
) -> ndk_sys::jint {
    VM = vm as *mut _ as _;

    ndk_sys::JNI_VERSION_1_6 as _
}

extern "C" {
    fn quad_main();
}

/// Short recap on how miniquad on Android works
/// There is a MainActivity, a normal Java activity
/// It creates a View and pass a reference to a view to rust.
/// Rust spawn a thread that render things into this view as often as
/// possible.
/// Also MainActivty collects user input events and calls native rust functions.
///
/// This long explanation was to illustrate how we ended up with evets callback
/// and drawing in the different threads.
/// Message enum is used to send data from the callbacks to the drawing thread.
#[derive(Debug)]
enum Message {
    SurfaceChanged {
        width: i32,
        height: i32,
    },
    SurfaceCreated {
        window: *mut ndk_sys::ANativeWindow,
    },
    SurfaceDestroyed,
    Touch {
        phase: TouchPhase,
        touch_id: u64,
        x: f32,
        y: f32,
    },
    Character {
        character: u32,
    },
    KeyDown {
        keycode: KeyCode,
    },
    KeyUp {
        keycode: KeyCode,
    },
    Pause,
    Resume,
    Destroy,
    /// The activity's `onBackPressed` called into Rust instead of
    /// finishing immediately. #151.
    BackPressed,
    Request(crate::native::Request),
}
unsafe impl Send for Message {}

thread_local! {
    static MESSAGES_TX: RefCell<Option<mpsc::Sender<Message>>> = RefCell::new(None);
}

fn send_message(message: Message) {
    MESSAGES_TX.with(|tx| {
        let mut tx = tx.borrow_mut();
        tx.as_mut().unwrap().send(message).unwrap();
    })
}

pub static mut ACTIVITY: ndk_sys::jobject = std::ptr::null_mut();
static mut VM: *mut ndk_sys::JavaVM = std::ptr::null_mut();

pub unsafe fn console_debug(msg: *const ::core::ffi::c_char) {
    ndk_sys::__android_log_write(
        ndk_sys::android_LogPriority_ANDROID_LOG_DEBUG as _,
        b"SAPP\0".as_ptr() as _,
        msg,
    );
}

pub unsafe fn console_info(msg: *const ::core::ffi::c_char) {
    ndk_sys::__android_log_write(
        ndk_sys::android_LogPriority_ANDROID_LOG_INFO as _,
        b"SAPP\0".as_ptr() as _,
        msg,
    );
}

pub unsafe fn console_warn(msg: *const ::core::ffi::c_char) {
    ndk_sys::__android_log_write(
        ndk_sys::android_LogPriority_ANDROID_LOG_WARN as _,
        b"SAPP\0".as_ptr() as _,
        msg,
    );
}

pub unsafe fn console_error(msg: *const ::core::ffi::c_char) {
    ndk_sys::__android_log_write(
        ndk_sys::android_LogPriority_ANDROID_LOG_ERROR as _,
        b"SAPP\0".as_ptr() as _,
        msg,
    );
}

// fn log_info(message: &str) {
//     use std::ffi::CString;

//     let msg = CString::new(message).unwrap_or_else(|_| panic!());

//     unsafe { console_info(msg.as_ptr()) };
// }

struct MainThreadState {
    libegl: LibEgl,
    egl_display: egl::EGLDisplay,
    egl_config: egl::EGLConfig,
    egl_context: egl::EGLContext,
    surface: egl::EGLSurface,
    window: *mut ndk_sys::ANativeWindow,
    event_handler: Box<dyn EventHandler>,
    quit: bool,
    fullscreen: bool,
    update_requested: bool,
    keymods: KeyMods,
    /// Set once `Activity.finish()` has been requested, so `check_quit`
    /// calls it at most once. #151.
    activity_finish_requested: bool,
}

impl MainThreadState {
    unsafe fn destroy_surface(&mut self) {
        (self.libegl.eglMakeCurrent)(
            self.egl_display,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        (self.libegl.eglDestroySurface)(self.egl_display, self.surface);
        self.surface = std::ptr::null_mut();
    }

    unsafe fn update_surface(&mut self, window: *mut ndk_sys::ANativeWindow) {
        if !self.window.is_null() {
            ndk_sys::ANativeWindow_release(self.window);
        }
        self.window = window;
        if self.surface.is_null() == false {
            self.destroy_surface();
        }

        self.surface = (self.libegl.eglCreateWindowSurface)(
            self.egl_display,
            self.egl_config,
            window as _,
            std::ptr::null_mut(),
        );

        assert!(!self.surface.is_null());

        let res = (self.libegl.eglMakeCurrent)(
            self.egl_display,
            self.surface,
            self.surface,
            self.egl_context,
        );

        assert!(res != 0);
    }

    fn process_message(&mut self, msg: Message) {
        match msg {
            Message::SurfaceCreated { window } => unsafe {
                self.update_surface(window);
            },
            Message::SurfaceDestroyed => unsafe {
                self.destroy_surface();
            },
            Message::SurfaceChanged { width, height } => {
                {
                    let density = unsafe { query_display_density() };
                    let mut d = crate::native_display().lock().unwrap();
                    d.screen_width = width as _;
                    d.screen_height = height as _;
                    d.dpi_scale = density;
                }
                self.event_handler.resize_event(width as _, height as _);
            }
            Message::Touch {
                phase,
                touch_id,
                x,
                y,
            } => {
                self.event_handler.touch_event(phase, touch_id, x, y);
            }
            Message::Character { character } => {
                if let Some(character) = char::from_u32(character) {
                    self.event_handler
                        .char_event(character, Default::default(), false);
                }
            }
            Message::KeyDown { keycode } => {
                match keycode {
                    KeyCode::LeftShift | KeyCode::RightShift => self.keymods.shift = true,
                    KeyCode::LeftControl | KeyCode::RightControl => self.keymods.ctrl = true,
                    KeyCode::LeftAlt | KeyCode::RightAlt => self.keymods.alt = true,
                    KeyCode::LeftSuper | KeyCode::RightSuper => self.keymods.logo = true,
                    _ => {}
                }
                self.event_handler
                    .key_down_event(keycode, self.keymods, false);
            }
            Message::KeyUp { keycode } => {
                match keycode {
                    KeyCode::LeftShift | KeyCode::RightShift => self.keymods.shift = false,
                    KeyCode::LeftControl | KeyCode::RightControl => self.keymods.ctrl = false,
                    KeyCode::LeftAlt | KeyCode::RightAlt => self.keymods.alt = false,
                    KeyCode::LeftSuper | KeyCode::RightSuper => self.keymods.logo = false,
                    _ => {}
                }
                self.event_handler.key_up_event(keycode, self.keymods);
            }
            Message::Pause => self.event_handler.window_minimized_event(),
            Message::Resume => {
                if self.fullscreen {
                    unsafe {
                        let env = attach_jni_env();
                        set_full_screen(env, true);
                    }
                }

                self.event_handler.window_restored_event()
            }
            Message::Destroy => {
                // Real OS destruction cannot be cancelled: `cancel_quit`
                // from this event has no effect, matching
                // `EventHandler::quit_requested_event` docs. #151.
                let mut d = crate::native_display().lock().unwrap();
                d.quit_requested = true;
                d.quit_ordered = true;
                drop(d);
                self.quit = true;
                self.event_handler.quit_requested_event()
            }
            Message::BackPressed => {
                // Mirror `request_quit()`: let `check_quit` confirm with
                // `quit_requested_event` before anything finishes. #151.
                let mut d = crate::native_display().lock().unwrap();
                d.quit_requested = true;
            }
            Message::Request(req) => self.process_request(req),
        }
    }

    /// Confirm a pending `request_quit()`/Back quit, and finish the
    /// activity once `order_quit()` or a confirmed `request_quit()` has
    /// set `quit_ordered`. `cancel_quit()` called from
    /// `quit_requested_event` keeps the activity open. #151.
    fn check_quit(&mut self) {
        let quit_ordered = crate::native::drive_android_quit_state(crate::native_display(), || {
            self.event_handler.quit_requested_event()
        });

        if !self.activity_finish_requested && quit_ordered {
            self.activity_finish_requested = true;
            unsafe {
                let env = attach_jni_env();
                ndk_utils::call_void_method!(env, ACTIVITY, "finish", "()V");
            }
        }
    }

    fn frame(&mut self) {
        self.event_handler.update();

        if self.surface.is_null() == false {
            self.update_requested = false;
            self.event_handler.draw();

            unsafe {
                (self.libegl.eglSwapBuffers)(self.egl_display, self.surface);
            }
        }
    }

    fn process_request(&mut self, request: crate::native::Request) {
        use crate::native::Request::*;

        match request {
            ScheduleUpdate => {
                self.update_requested = true;
            }
            SetFullscreen(fullscreen) => {
                unsafe {
                    let env = attach_jni_env();
                    set_full_screen(env, fullscreen);
                }
                self.fullscreen = fullscreen;
            }
            ShowKeyboard(show) => unsafe {
                let env = attach_jni_env();
                ndk_utils::call_void_method!(env, ACTIVITY, "showKeyboard", "(Z)V", show as i32);
            },
            SetImePosition { .. } => {
                // IME position control not applicable on Android
            }
            SetImeEnabled(..) => {
                // IME enable/disable not applicable on Android
            }
            _ => {}
        }
    }
}

// Detaches the current thread from the JVM on thread exit. Only ever
// stored in `DETACH_ON_THREAD_EXIT` by `attach_jni_env`, and only for a
// thread that `GetEnv` first reported as `JNI_EDETACHED` (#150): a
// JVM-owned thread (a JNI callback thread) is already attached and so
// never gets one of these, and is therefore never detached by us.
struct DetachOnThreadExit;

impl Drop for DetachOnThreadExit {
    fn drop(&mut self) {
        unsafe {
            if VM.is_null() {
                return;
            }
            if let Some(detach_current_thread) = (**VM).DetachCurrentThread {
                let res = detach_current_thread(VM);
                if res != ndk_sys::JNI_OK as i32 {
                    console_error(
                        b"miniquad: DetachCurrentThread failed on thread exit\0".as_ptr() as _,
                    );
                }
            }
        }
    }
}

thread_local! {
    static DETACH_ON_THREAD_EXIT: std::cell::RefCell<Option<DetachOnThreadExit>> =
        const { std::cell::RefCell::new(None) };
}

/// Get the JNI Env for the current thread, attaching it to the JVM only
/// if it is not already attached.
///
/// Uses `GetEnv` to check attachment first: a thread the JVM already
/// owns (for example the UI thread delivering a JNI callback) is always
/// already attached, and this is then a cheap no-op that never touches
/// `AttachCurrentThread`/`DetachCurrentThread`. A thread this crate
/// creates itself (for example the render thread spawned in `run`) is
/// `JNI_EDETACHED` on its first call here: this attaches it and records
/// a thread-local [`DetachOnThreadExit`] guard, so the thread is
/// detached automatically, exactly once, when it exits (including on a
/// panic unwind) — without ever detaching a JVM-owned thread. #150.
pub unsafe fn attach_jni_env() -> *mut ndk_sys::JNIEnv {
    let mut env: *mut ::core::ffi::c_void = std::ptr::null_mut();
    let get_env = (**VM).GetEnv.unwrap();
    let status = get_env(VM, &mut env, ndk_sys::JNI_VERSION_1_6 as _);

    if status == ndk_sys::JNI_EDETACHED {
        let mut attached_env: *mut ndk_sys::JNIEnv = std::ptr::null_mut();
        let attach_current_thread = (**VM).AttachCurrentThread.unwrap();
        let res = attach_current_thread(VM, &mut attached_env, std::ptr::null_mut());
        assert!(res == ndk_sys::JNI_OK as i32);

        DETACH_ON_THREAD_EXIT.with(|guard| *guard.borrow_mut() = Some(DetachOnThreadExit));

        return attached_env;
    }

    assert!(status == ndk_sys::JNI_OK as i32);
    env as *mut ndk_sys::JNIEnv
}

/// `Resources.getDisplayMetrics().density` — 1.0 = mdpi, 2.0 = xhdpi,
/// etc. Returns 1.0 on any JNI hiccup.
unsafe fn query_display_density() -> f32 {
    if VM.is_null() || ACTIVITY.is_null() {
        return 1.0;
    }
    let env = attach_jni_env();
    if env.is_null() {
        return 1.0;
    }

    let resources = ndk_utils::call_object_method!(
        env,
        ACTIVITY,
        "getResources",
        "()Landroid/content/res/Resources;"
    );
    if resources.is_null() {
        return 1.0;
    }

    let metrics = ndk_utils::call_object_method!(
        env,
        resources,
        "getDisplayMetrics",
        "()Landroid/util/DisplayMetrics;"
    );
    if metrics.is_null() {
        return 1.0;
    }

    let get_object_class = (**env).GetObjectClass.unwrap();
    let get_field_id = (**env).GetFieldID.unwrap();
    let get_float_field = (**env).GetFloatField.unwrap();

    let metrics_class = get_object_class(env, metrics);
    let density_field = get_field_id(
        env,
        metrics_class,
        b"density\0".as_ptr() as _,
        b"F\0".as_ptr() as _,
    );
    if density_field.is_null() {
        return 1.0;
    }

    let density = get_float_field(env, metrics, density_field);
    if density > 0.0 { density } else { 1.0 }
}

pub struct AndroidClipboard {}
impl AndroidClipboard {
    pub fn new() -> AndroidClipboard {
        AndroidClipboard {}
    }
}
impl crate::native::Clipboard for AndroidClipboard {
    fn get(&mut self) -> Option<String> {
        unsafe {
            let env = attach_jni_env();

            let text = ndk_utils::call_object_method!(
                env,
                ACTIVITY,
                "getClipboardText",
                "()Ljava/lang/String;"
            );
            if text.is_null() {
                return None;
            }

            let text = ndk_utils::get_utf_str!(env, text);
            Some(text)
        }
    }

    fn set(&mut self, data: &str) {
        let data = std::ffi::CString::new(data).unwrap();
        unsafe {
            let env = attach_jni_env();

            let new_string_utf = (**env).NewStringUTF.unwrap();
            let jtext = new_string_utf(env, data.as_ptr());

            ndk_utils::call_void_method!(
                env,
                ACTIVITY,
                "setClipboardText",
                "(Ljava/lang/String;)V",
                jtext
            );
        }
    }
}

pub unsafe fn run<F>(conf: crate::conf::Conf, f: F)
where
    F: 'static + FnOnce() -> Box<dyn EventHandler>,
{
    if conf.platform.android_panic_hook {
        use std::ffi::CString;
        use std::panic;

        panic::set_hook(Box::new(|info| {
            let msg = CString::new(format!("{info}")).unwrap_or_else(|_| {
                CString::new(format!("MALFORMED ERROR MESSAGE {:?}", info.location())).unwrap()
            });
            console_error(msg.as_ptr());
        }));
    }

    if conf.fullscreen {
        let env = attach_jni_env();
        set_full_screen(env, true);
    }

    // yeah, just adding Send to outer F will do it, but it will brake the API
    // in other backends
    struct SendHack<F>(F);
    unsafe impl<F> Send for SendHack<F> {}

    let f = SendHack(f);

    let (tx, rx) = mpsc::channel();

    let tx2 = tx.clone();
    MESSAGES_TX.with(move |messages_tx| *messages_tx.borrow_mut() = Some(tx2));

    thread::spawn(move || {
        let mut libegl = LibEgl::try_load().expect("Cant load LibEGL");

        // skip all the messages until android will be able to actually open a window
        //
        // sometimes before launching an app android will show a permission dialog
        // it is important to create GL context only after a first SurfaceChanged
        let window = 'a: loop {
            match rx.try_recv() {
                Ok(Message::SurfaceCreated { window }) => {
                    break 'a window;
                }
                _ => {}
            }
        };
        let (screen_width, screen_height) = 'a: loop {
            match rx.try_recv() {
                Ok(Message::SurfaceChanged { width, height }) => {
                    break 'a (width as f32, height as f32);
                }
                _ => {}
            }
        };

        let (egl_context, egl_config, egl_display) = crate::native::egl::create_egl_context(
            &mut libegl,
            std::ptr::null_mut(), /* EGL_DEFAULT_DISPLAY */
            conf.platform.framebuffer_alpha,
            conf.sample_count,
        )
        .expect("Cant create EGL context");

        assert!(!egl_display.is_null());
        assert!(!egl_config.is_null());

        crate::native::gl::load_gl_funcs(|proc| {
            let name = std::ffi::CString::new(proc).unwrap();
            (libegl.eglGetProcAddress)(name.as_ptr() as _)
        });

        let surface = (libegl.eglCreateWindowSurface)(
            egl_display,
            egl_config,
            window as _,
            std::ptr::null_mut(),
        );

        if (libegl.eglMakeCurrent)(egl_display, surface, surface, egl_context) == 0 {
            panic!();
        }

        let clipboard = Box::new(AndroidClipboard::new());
        let tx_fn = Box::new(move |req| tx.send(Message::Request(req)).unwrap());
        let density = query_display_density();
        crate::set_or_replace_display(NativeDisplayData {
            high_dpi: conf.high_dpi,
            blocking_event_loop: conf.platform.blocking_event_loop,
            dpi_scale: density,
            ..NativeDisplayData::new(screen_width as _, screen_height as _, tx_fn, clipboard)
        });

        let event_handler = f.0();
        let mut s = MainThreadState {
            libegl,
            egl_display,
            egl_config,
            egl_context,
            surface,
            window,
            event_handler,
            quit: false,
            fullscreen: conf.fullscreen,
            update_requested: true,
            keymods: KeyMods {
                shift: false,
                ctrl: false,
                alt: false,
                logo: false,
            },
            activity_finish_requested: false,
        };

        let rx_timeout = conf
            .platform
            .sleep_interval_ms
            .map(|sleep| Duration::from_millis(sleep as u64));

        while !s.quit {
            let block_on_wait = conf.platform.blocking_event_loop && !s.update_requested;

            if block_on_wait {
                // We don't need to loop here because the loop above consumes all
                // available messages. Instead we are going to block until receiving here.

                match rx_recv(&rx, rx_timeout) {
                    Ok(msg) => s.process_message(msg),
                    // Timeout so time to do periodic update()
                    Err(mpsc::RecvTimeoutError::Timeout) => s.update_requested = true,
                    Err(mpsc::RecvTimeoutError::Disconnected) => panic!(),
                }
            } else {
                // process all the messages from the main thread
                while let Ok(msg) = rx.try_recv() {
                    s.process_message(msg);
                }
            }

            if !conf.platform.blocking_event_loop || s.update_requested {
                s.frame();
            }

            s.check_quit();

            thread::yield_now();
        }

        (s.libegl.eglMakeCurrent)(
            s.egl_display,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        (s.libegl.eglDestroySurface)(s.egl_display, s.surface);
        (s.libegl.eglDestroyContext)(s.egl_display, s.egl_context);
        (s.libegl.eglTerminate)(s.egl_display);
    });
}

/// Adds a call to Receiver as if there was a `.recv_timeout_opt(timeout)`
/// where the `timeout` arg is optional.
fn rx_recv<T>(
    rx: &mpsc::Receiver<T>,
    timeout: Option<Duration>,
) -> Result<T, mpsc::RecvTimeoutError> {
    match timeout {
        Some(timeout) => rx.recv_timeout(timeout),
        // No timeout specified so just do a normal blocking recv()
        None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
    }
}

#[no_mangle]
extern "C" fn jni_on_load(vm: *mut std::ffi::c_void) {
    unsafe {
        VM = vm as _;
    }
}

unsafe fn create_native_window(surface: ndk_sys::jobject) -> *mut ndk_sys::ANativeWindow {
    let env = attach_jni_env();

    ndk_sys::ANativeWindow_fromSurface(env, surface)
}

#[no_mangle]
pub unsafe extern "C" fn Java_quad_1native_QuadNative_activityOnCreate(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
    activity: ndk_sys::jobject,
) {
    let env = attach_jni_env();
    ACTIVITY = (**env).NewGlobalRef.unwrap()(env, activity);
    quad_main();
}

#[no_mangle]
unsafe extern "C" fn Java_quad_1native_QuadNative_activityOnResume(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
) {
    send_message(Message::Resume);
}

#[no_mangle]
unsafe extern "C" fn Java_quad_1native_QuadNative_activityOnPause(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
) {
    send_message(Message::Pause);
}

#[no_mangle]
unsafe extern "C" fn Java_quad_1native_QuadNative_activityOnDestroy(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
) {
    send_message(Message::Destroy);
}

#[no_mangle]
unsafe extern "C" fn Java_quad_1native_QuadNative_activityOnBackPressed(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
) {
    send_message(Message::BackPressed);
}

#[no_mangle]
extern "C" fn Java_quad_1native_QuadNative_surfaceOnSurfaceCreated(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
    surface: ndk_sys::jobject,
) {
    let window = unsafe { create_native_window(surface) };
    send_message(Message::SurfaceCreated { window });
}

#[no_mangle]
extern "C" fn Java_quad_1native_QuadNative_surfaceOnSurfaceDestroyed(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
) {
    send_message(Message::SurfaceDestroyed);
}

#[no_mangle]
extern "C" fn Java_quad_1native_QuadNative_surfaceOnSurfaceChanged(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
    _: ndk_sys::jobject,
    width: ndk_sys::jint,
    height: ndk_sys::jint,
) {
    send_message(Message::SurfaceChanged {
        width: width as _,
        height: height as _,
    });
}

#[no_mangle]
extern "C" fn Java_quad_1native_QuadNative_surfaceOnTouch(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
    touch_id: ndk_sys::jint,
    action: ndk_sys::jint,
    x: ndk_sys::jfloat,
    y: ndk_sys::jfloat,
) {
    let phase = match action {
        0 => TouchPhase::Moved,
        1 => TouchPhase::Ended,
        2 => TouchPhase::Started,
        3 => TouchPhase::Cancelled,
        x => panic!("Unsupported touch phase: {}", x),
    };

    send_message(Message::Touch {
        phase,
        touch_id: touch_id as _,
        x: x as f32,
        y: y as f32,
    });
}

#[no_mangle]
extern "C" fn Java_quad_1native_QuadNative_surfaceOnKeyDown(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
    keycode: ndk_sys::jint,
) {
    let keycode = keycodes::translate_keycode(keycode as _);

    send_message(Message::KeyDown { keycode });
}

#[no_mangle]
extern "C" fn Java_quad_1native_QuadNative_surfaceOnKeyUp(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
    keycode: ndk_sys::jint,
) {
    let keycode = keycodes::translate_keycode(keycode as _);

    send_message(Message::KeyUp { keycode });
}

#[no_mangle]
extern "C" fn Java_quad_1native_QuadNative_surfaceOnCharacter(
    _: *mut ndk_sys::JNIEnv,
    _: ndk_sys::jobject,
    character: ndk_sys::jint,
) {
    send_message(Message::Character {
        character: character as u32,
    });
}

unsafe fn set_full_screen(env: *mut ndk_sys::JNIEnv, fullscreen: bool) {
    ndk_utils::call_void_method!(env, ACTIVITY, "setFullScreen", "(Z)V", fullscreen as i32);
}

/// `content` is null on any load error (missing asset, allocation
/// failure, or a failed read). On success `content` is a `libc::malloc`
/// buffer that the caller owns: the caller must release it with
/// `libc::free` once it has copied the bytes out.
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct android_asset {
    pub content: *mut ::core::ffi::c_char,
    pub content_length: ::core::ffi::c_int,
}

// According to documentation, AAssetManager_fromJava is as available as an
// AAssetManager_open, which was used before
// For some reason it is missing fron ndk_sys binding
extern "C" {
    pub fn AAssetManager_fromJava(
        env: *mut ndk_sys::JNIEnv,
        assetManager: ndk_sys::jobject,
    ) -> *mut ndk_sys::AAssetManager;
}

pub(crate) unsafe fn load_asset(filepath: *const ::core::ffi::c_char, out: *mut android_asset) {
    let env = attach_jni_env();

    let get_method_id = (**env).GetMethodID.unwrap();
    let get_object_class = (**env).GetObjectClass.unwrap();
    let call_object_method = (**env).CallObjectMethod.unwrap();

    let mid = (get_method_id)(
        env,
        get_object_class(env, ACTIVITY),
        b"getAssets\0".as_ptr() as _,
        b"()Landroid/content/res/AssetManager;\0".as_ptr() as _,
    );
    let asset_manager = (call_object_method)(env, ACTIVITY, mid);
    let mgr = AAssetManager_fromJava(env, asset_manager);
    let asset = ndk_sys::AAssetManager_open(mgr, filepath, ndk_sys::AASSET_MODE_BUFFER as _);
    if asset.is_null() {
        // No asset at this path. `out` stays zeroed: the caller sees a
        // null `content` and reports a load error.
        return;
    }

    let length = ndk_sys::AAsset_getLength64(asset);
    if !crate::fs::android_asset_length_in_range(length) {
        // content_length is a C int: a negative or over-i32::MAX length
        // can never be reported correctly. Reject before allocating or
        // reading anything. #149.
        ndk_sys::AAsset_close(asset);
        return;
    }

    // `malloc(0)` is not required to return a non-null pointer, so an
    // empty asset still allocates one byte. `content_length` stays 0.
    let alloc_size = if length > 0 { length as usize } else { 1 };
    let buffer = libc::malloc(alloc_size);
    if buffer.is_null() {
        ndk_sys::AAsset_close(asset);
        return;
    }

    let read = if length > 0 {
        ndk_sys::AAsset_read(asset, buffer, length as _)
    } else {
        0
    };
    ndk_sys::AAsset_close(asset);

    // `android_asset_read_outcome` is the host-tested decision for this
    // part of #149: `None` means free the buffer and report an error
    // (including a short read); `Some(n)` means report exactly `n`
    // read bytes.
    match crate::fs::android_asset_read_outcome(length, read) {
        Some(reported_len) => {
            (*out).content_length = reported_len as _;
            (*out).content = buffer as _;
        }
        None => {
            libc::free(buffer);
        }
    }
}
