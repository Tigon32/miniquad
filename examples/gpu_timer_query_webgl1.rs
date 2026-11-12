//! WebGL1 context entry for the issue #145 GPU timer-query acceptance test.
//! `EXT_disjoint_timer_query_webgl2` is a WebGL2-only extension, so this
//! context must report [`HarnessStatus::Unsupported`] without a panic; see
//! MADR 0023 for the decision and `tests/browser/gpu-timer-query.spec.mjs`
//! for the browser assertion. Shares `Stage`/`ExportingStage` with
//! `gpu_timer_query_webgl2.rs`; see `gpu_timer_query/core.rs`.
use miniquad::*;

include!("gpu_timer_query/core.rs");

fn main() {
    let mut conf = conf::Conf::default();
    #[cfg(target_arch = "wasm32")]
    {
        conf.platform.webgl_version = conf::WebGLVersion::WebGL1;
    }
    miniquad::start(conf, move || Box::new(ExportingStage(Stage::new())));
}
