//! Calls from Rust into the host JavaScript (`docs/webgpu-proof-contract.md`
//! section 7). The import module is `mq_webgpu_proof`, not the ABI v3 `env`
//! module. On a non-`wasm32` target (`cargo test --lib`) these are no-op
//! stubs that record the call for assertions; nothing in this crate links
//! against a browser on the host target.

#[cfg(target_arch = "wasm32")]
mod wasm {
    #[link(wasm_import_module = "mq_webgpu_proof")]
    extern "C" {
        pub fn js_request_adapter(request_id: u32);
        pub fn js_request_device(request_id: u32, adapter_handle: u32);
        pub fn js_request_context(request_id: u32, device_handle: u32);
        pub fn js_compile_shader(request_id: u32, device_handle: u32, code_ptr: *const u8, code_len: u32);
        pub fn js_create_pipeline(request_id: u32, device_handle: u32, shader_handle: u32);
        pub fn js_render_frame(
            frame_id: u32,
            device_handle: u32,
            pipeline_handle: u32,
            do_readback: u32,
            readback_id: u32,
        );
    }
}

#[cfg(target_arch = "wasm32")]
pub fn request_adapter(request_id: u32) {
    unsafe { wasm::js_request_adapter(request_id) }
}
#[cfg(target_arch = "wasm32")]
pub fn request_device(request_id: u32, adapter_handle: u32) {
    unsafe { wasm::js_request_device(request_id, adapter_handle) }
}
#[cfg(target_arch = "wasm32")]
pub fn request_context(request_id: u32, device_handle: u32) {
    unsafe { wasm::js_request_context(request_id, device_handle) }
}
#[cfg(target_arch = "wasm32")]
pub fn compile_shader(request_id: u32, device_handle: u32, code: &str) {
    unsafe { wasm::js_compile_shader(request_id, device_handle, code.as_ptr(), code.len() as u32) }
}
#[cfg(target_arch = "wasm32")]
pub fn create_pipeline(request_id: u32, device_handle: u32, shader_handle: u32) {
    unsafe { wasm::js_create_pipeline(request_id, device_handle, shader_handle) }
}
#[cfg(target_arch = "wasm32")]
pub fn render_frame(frame_id: u32, device_handle: u32, pipeline_handle: u32, do_readback: bool, readback_id: u32) {
    unsafe { wasm::js_render_frame(frame_id, device_handle, pipeline_handle, do_readback as u32, readback_id) }
}
#[cfg(not(target_arch = "wasm32"))]
pub mod recorded_calls {
    use std::cell::RefCell;

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Call {
        RequestAdapter(u32),
        RequestDevice(u32, u32),
        RequestContext(u32, u32),
        CompileShader(u32, u32, String),
        CreatePipeline(u32, u32, u32),
        RenderFrame(u32, u32, u32, bool, u32),
    }

    thread_local! {
        static CALLS: RefCell<Vec<Call>> = RefCell::new(Vec::new());
    }

    pub fn push(call: Call) {
        CALLS.with(|c| c.borrow_mut().push(call));
    }

    #[cfg(test)]
    pub fn take_all() -> Vec<Call> {
        CALLS.with(|c| c.borrow_mut().drain(..).collect())
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub fn request_adapter(request_id: u32) {
    recorded_calls::push(recorded_calls::Call::RequestAdapter(request_id));
}
#[cfg(not(target_arch = "wasm32"))]
pub fn request_device(request_id: u32, adapter_handle: u32) {
    recorded_calls::push(recorded_calls::Call::RequestDevice(request_id, adapter_handle));
}
#[cfg(not(target_arch = "wasm32"))]
pub fn request_context(request_id: u32, device_handle: u32) {
    recorded_calls::push(recorded_calls::Call::RequestContext(request_id, device_handle));
}
#[cfg(not(target_arch = "wasm32"))]
pub fn compile_shader(request_id: u32, device_handle: u32, code: &str) {
    recorded_calls::push(recorded_calls::Call::CompileShader(
        request_id,
        device_handle,
        code.to_string(),
    ));
}
#[cfg(not(target_arch = "wasm32"))]
pub fn create_pipeline(request_id: u32, device_handle: u32, shader_handle: u32) {
    recorded_calls::push(recorded_calls::Call::CreatePipeline(
        request_id,
        device_handle,
        shader_handle,
    ));
}
#[cfg(not(target_arch = "wasm32"))]
pub fn render_frame(frame_id: u32, device_handle: u32, pipeline_handle: u32, do_readback: bool, readback_id: u32) {
    recorded_calls::push(recorded_calls::Call::RenderFrame(
        frame_id,
        device_handle,
        pipeline_handle,
        do_readback,
        readback_id,
    ));
}
