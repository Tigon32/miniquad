//! Manual JS/WebGPU bridge candidate for `miniquad-webgpu-proof/1`
//! (`docs/webgpu-proof-contract.md`, issue #154). This is a bounded proof,
//! not a `RenderingBackend` implementation and not a production backend.
//!
//! The WASM import module is `mq_webgpu_proof` (see `src/bridge.rs`). The
//! exports below are the only entry points `web/host.js` calls. Memory
//! ownership follows contract section 7: an export that receives
//! `(ptr, len)` from JavaScript claims (and frees) that buffer through
//! `src/alloc.rs`; an export that hands bytes to JavaScript keeps them valid
//! only for the duration of the call.

mod alloc;
mod bridge;
mod error;
mod json;
mod pixel;
mod state;
mod text;

use state::{InitOutcome, State};
use std::cell::RefCell;

thread_local! {
    static STATE: RefCell<Option<State>> = RefCell::new(None);
    static STATUS_BUFFER: RefCell<Vec<u8>> = RefCell::new(Vec::new());
}

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> Option<R> {
    STATE.with(|s| s.borrow_mut().as_mut().map(f))
}

/// Allocates `len` bytes Rust owns for a future JS-to-Rust callback.
/// Returns 0 on failure (see `src/alloc.rs`).
#[no_mangle]
pub extern "C" fn mq_proof_alloc(len: usize) -> usize {
    alloc::alloc(len) as usize
}

/// Frees a buffer JavaScript could not deliver to a callback export.
#[no_mangle]
pub extern "C" fn mq_proof_free(ptr: usize, len: usize) {
    alloc::free(ptr as *mut u8, len);
}

/// Starts the proof application. Called once, before the frame loop starts.
/// `mode_ptr`/`mode_len` were allocated by `mq_proof_alloc`; this export
/// claims and frees them (contract section 7, "JavaScript to Rust bytes").
/// `api_available` and `secure_context` are host-computed facts (contract
/// section 5: "The host checks for the API and secure context, but it
/// reports the result to Rust."). Returns 1 if the mode parsed (even if
/// startup then failed for another reason), 0 for `contract-mismatch`.
#[no_mangle]
pub extern "C" fn mq_proof_init(
    mode_ptr: usize,
    mode_len: usize,
    api_available: u32,
    secure_context: u32,
    width: u32,
    height: u32,
) -> u32 {
    let mode_bytes = alloc::claim(mode_ptr as *mut u8, mode_len).unwrap_or_default();
    let mode_str = match std::str::from_utf8(&mode_bytes) {
        Ok(s) => s,
        Err(_) => return 0,
    };
    match State::init(mode_str, api_available != 0, secure_context != 0, width, height) {
        InitOutcome::Started(state) => {
            STATE.with(|s| *s.borrow_mut() = Some(state));
            1
        }
        InitOutcome::InvalidMode => 0,
    }
}

/// Writes `(ptr, len)` of the current UTF-8 JSON status as two little-endian
/// `u32` values at `out_ptr`. The bytes at the returned `ptr` are Rust-owned
/// and valid only until the next call into this module (contract section
/// 7, "Rust to JavaScript bytes"); `host.js` decodes them before any other
/// export call.
#[no_mangle]
pub extern "C" fn mq_proof_status(out_ptr: usize) {
    let json = with_state(|s| s.status_json()).unwrap_or_else(host_not_ready_json);
    STATUS_BUFFER.with(|buf| {
        let mut buf = buf.borrow_mut();
        buf.clear();
        buf.extend_from_slice(json.as_bytes());
        let ptr = buf.as_ptr() as usize;
        let len = buf.len();
        unsafe {
            let out = out_ptr as *mut usize;
            std::ptr::write_unaligned(out, ptr);
            std::ptr::write_unaligned(out.add(1), len);
        }
    });
}

/// A `contract-mismatch` status for a mode that did not parse, before any
/// `State` exists. `reporter` is `"rust"`; the contract allows either
/// reporter for this code.
fn host_not_ready_json() -> String {
    "{\"contract\":\"miniquad-webgpu-proof/1\",\"candidate\":\"manual\",\"reporter\":\"rust\",\
\"mode\":\"render\",\"phase\":\"failed\",\
\"error\":{\"code\":\"contract-mismatch\",\"message\":\"unknown mode\"},\
\"canvasFormat\":null,\"surface\":{\"width\":0,\"height\":0},\"frameCount\":0,\"resizeCount\":0,\
\"input\":{\"pointer\":null,\"key\":null,\"focused\":false,\"focusChanges\":0},\
\"readback\":{\"id\":0,\"state\":\"idle\",\"width\":0,\"height\":0,\"center\":null,\"corner\":null,\"error\":null}}"
        .to_string()
}

#[no_mangle]
pub extern "C" fn mq_proof_request_readback() -> u32 {
    with_state(|s| s.request_readback()).unwrap_or(0)
}

/// Returns 1 the first time disposal runs (JavaScript must then release GPU
/// resources), 0 on a repeat call.
#[no_mangle]
pub extern "C" fn mq_proof_dispose() -> u32 {
    with_state(|s| s.dispose() as u32).unwrap_or(0)
}

/// Called once per animation frame while the application is running.
#[no_mangle]
pub extern "C" fn mq_proof_tick() {
    with_state(|s| s.tick());
}

#[no_mangle]
pub extern "C" fn mq_proof_adapter_result(request_id: u32, ok: u32, handle: u32) {
    with_state(|s| s.on_adapter_result(request_id, ok != 0, handle));
}

#[no_mangle]
pub extern "C" fn mq_proof_device_result(request_id: u32, ok: u32, handle: u32) {
    with_state(|s| s.on_device_result(request_id, ok != 0, handle));
}

#[no_mangle]
pub extern "C" fn mq_proof_context_result(request_id: u32, ok: u32, format_code: u32) {
    with_state(|s| s.on_context_result(request_id, ok != 0, format_code));
}

/// `message_ptr`/`message_len` were allocated by `mq_proof_alloc`; this
/// export takes ownership (contract section 7, "JavaScript to Rust bytes").
#[no_mangle]
pub extern "C" fn mq_proof_shader_result(request_id: u32, ok: u32, handle: u32, message_ptr: usize, message_len: usize) {
    let bytes = alloc::claim(message_ptr as *mut u8, message_len).unwrap_or_default();
    with_state(|s| s.on_shader_result(request_id, ok != 0, handle, &bytes));
}

#[no_mangle]
pub extern "C" fn mq_proof_pipeline_result(request_id: u32, ok: u32, handle: u32, message_ptr: usize, message_len: usize) {
    let bytes = alloc::claim(message_ptr as *mut u8, message_len).unwrap_or_default();
    with_state(|s| s.on_pipeline_result(request_id, ok != 0, handle, &bytes));
}

#[no_mangle]
pub extern "C" fn mq_proof_frame_submitted(_frame_id: u32, ok: u32) {
    with_state(|s| s.on_frame_submitted(ok != 0));
}

/// `bytes_ptr`/`bytes_len` were allocated by `mq_proof_alloc` and hold the
/// mapped buffer, including `bytesPerRow` padding; this export claims and
/// frees them.
#[no_mangle]
pub extern "C" fn mq_proof_readback_result(
    id: u32,
    ok: u32,
    width: u32,
    height: u32,
    bytes_ptr: usize,
    bytes_len: usize,
    bytes_per_row: u32,
    format_code: u32,
) {
    let bytes = alloc::claim(bytes_ptr as *mut u8, bytes_len).unwrap_or_default();
    with_state(|s| s.on_readback_result(id, ok != 0, width, height, &bytes, bytes_per_row, format_code));
}

/// `reason_code`: 0 = `"destroyed"`, any other value = `"unknown"`.
#[no_mangle]
pub extern "C" fn mq_proof_device_lost(reason_code: u32) {
    with_state(|s| s.on_device_lost(reason_code == 0));
}

#[no_mangle]
pub extern "C" fn mq_proof_pointer_event(x: i32, y: i32, button: u32, down: u32) {
    with_state(|s| s.on_pointer_event(x, y, button, down != 0));
}

/// `code_ptr`/`code_len` were allocated by `mq_proof_alloc`; this export
/// claims and frees them, then validates UTF-8 within the 4096-byte limit
/// (contract section 7). Invalid bytes fail the application with code
/// `internal`, instead of silently dropping the key (no silent fallback).
#[no_mangle]
pub extern "C" fn mq_proof_key_event(code_ptr: usize, code_len: usize, down: u32) {
    let bytes = alloc::claim(code_ptr as *mut u8, code_len).unwrap_or_default();
    match text::validate_incoming_text(&bytes) {
        Ok(code) => {
            with_state(|s| s.on_key_event(code, down != 0));
        }
        Err(()) => {
            with_state(|s| s.fail_internal("key code was not valid UTF-8 within the 4096-byte limit"));
        }
    }
}

#[no_mangle]
pub extern "C" fn mq_proof_focus_event(focused: u32) {
    with_state(|s| s.on_focus_event(focused != 0));
}

#[no_mangle]
pub extern "C" fn mq_proof_resize(width: u32, height: u32) {
    with_state(|s| s.on_resize(width, height));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reset() {
        STATE.with(|s| *s.borrow_mut() = None);
    }

    /// Writes `text` into a fresh `mq_proof_alloc` buffer, the way `host.js`
    /// must before calling an export that claims ownership of bytes.
    fn alloc_text(text: &str) -> (usize, usize) {
        let ptr = mq_proof_alloc(text.len());
        unsafe {
            std::ptr::copy_nonoverlapping(text.as_ptr(), ptr as *mut u8, text.len());
        }
        (ptr, text.len())
    }

    #[test]
    fn init_with_an_unknown_mode_returns_zero_and_builds_no_state() {
        reset();
        let (ptr, len) = alloc_text("bogus");
        let ok = mq_proof_init(ptr, len, 1, 1, 256, 256);
        assert_eq!(ok, 0);
        assert!(with_state(|_| ()).is_none());
    }

    #[test]
    fn init_with_a_known_mode_builds_state_and_status_reports_rust() {
        reset();
        let (ptr, len) = alloc_text("render");
        let ok = mq_proof_init(ptr, len, 1, 1, 256, 256);
        assert_eq!(ok, 1);

        let mut out = [0usize; 2];
        mq_proof_status(out.as_mut_ptr() as usize);
        let json_ptr = out[0] as *const u8;
        let json_len = out[1];
        let json = unsafe { std::str::from_utf8(std::slice::from_raw_parts(json_ptr, json_len)) }.unwrap();
        assert!(json.contains("\"reporter\":\"rust\""));
        assert!(json.contains("\"phase\":\"starting\""));
        reset();
    }

    #[test]
    fn request_readback_before_running_returns_zero_without_a_state() {
        reset();
        assert_eq!(mq_proof_request_readback(), 0);
    }

    #[test]
    fn key_event_with_invalid_utf8_does_not_panic() {
        reset();
        let (ptr, len) = alloc_text("render");
        mq_proof_init(ptr, len, 1, 1, 256, 256);
        let invalid: &[u8] = &[0xff, 0xfe];
        let ptr = alloc::alloc(invalid.len());
        unsafe {
            std::ptr::copy_nonoverlapping(invalid.as_ptr(), ptr, invalid.len());
        }
        mq_proof_key_event(ptr as usize, invalid.len(), 1);
        reset();
    }

    #[test]
    fn dispose_without_a_state_is_a_safe_no_op() {
        reset();
        assert_eq!(mq_proof_dispose(), 0);
    }
}

