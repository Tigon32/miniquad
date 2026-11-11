//! WebGL2 context entry for the issue #145 GPU timer-query acceptance test.
//! This is the one context this release claims a verified, nonzero GPU
//! timer-query result for, gated on the browser granting
//! `EXT_disjoint_timer_query_webgl2`; see MADR 0023 and
//! `tests/browser/gpu-timer-query.spec.mjs` for the hardware-adapter proof.
//! Shares `Stage`/`ExportingStage` with `gpu_timer_query_webgl1.rs`; see
//! `gpu_timer_query/core.rs`.
use miniquad::*;

include!("gpu_timer_query/core.rs");

fn main() {
    let mut conf = conf::Conf::default();
    #[cfg(target_arch = "wasm32")]
    {
        conf.platform.webgl_version = conf::WebGLVersion::WebGL2;
    }
    miniquad::start(conf, move || Box::new(ExportingStage(Stage::new())));
}
