//! Benchmark-only comparison crate for issue #123.
//!
//! This crate is **not** part of `companions/draw` or the root
//! `miniquad` crate's dependency graph. It builds exactly one of two
//! mutually exclusive CPU geometry backends over the same bounded
//! reference workload (50 rectangles, 50 triangles, 20 circles, 10
//! stroked cubic curves — see [`workload::SPEC`]):
//!
//! * `internal`: `miniquad-draw`'s existing pure geometry builders
//!   (`companions/draw/src/geometry.rs`), reused as published (no
//!   GPU handles involved — these functions never touch
//!   `RenderingBackend`).
//! * `lyon`: `lyon_tessellation` 1.0.23 (exact pin), a maintained
//!   tessellation library, source-verified in
//!   `docs/drawing-companion.md`.
//!
//! Both backends produce the same [`workload::WorkloadResult`] shape, so
//! a caller (the `run_internal`/`run_lyon` binaries, or
//! `scripts/compare-drawing.mjs` driving the compiled WASM) can compare
//! vertex/triangle counts, bounding boxes, and wall-clock time without
//! caring which backend built the geometry.
//!
//! The two feature flags are mutually exclusive by design (see the
//! `compile_error!` below): this keeps the comparison honest — a build
//! never silently links both backends and reports whichever happened to
//! run.

#[cfg(all(feature = "internal", feature = "lyon"))]
compile_error!(
    "features \"internal\" and \"lyon\" are mutually exclusive: build with exactly one, e.g. \
     `cargo build --no-default-features --features internal`"
);

#[cfg(not(any(feature = "internal", feature = "lyon")))]
compile_error!(
    "select exactly one backend feature: \"internal\" or \"lyon\" \
     (`cargo build --no-default-features --features internal`)"
);

pub mod workload;

#[cfg(feature = "internal")]
pub mod internal;

#[cfg(feature = "lyon")]
pub mod lyon_adapter;

/// Run the selected backend's workload once and return its result.
pub fn run_selected() -> workload::WorkloadResult {
    #[cfg(feature = "internal")]
    {
        internal::run()
    }
    #[cfg(feature = "lyon")]
    {
        lyon_adapter::run()
    }
}

/// Print a hand-rolled JSON report to stdout (no `serde_json` dependency
/// added just for this: the crate already keeps its dependency surface
/// to exactly one backend library at a time). `timings_ns` holds one
/// wall-clock duration per repeat, so `scripts/compare-drawing.mjs` and
/// a human reader can both see the full spread, not just a mean.
pub fn print_report(backend: &str, timings_ns: &[u128], result: &workload::WorkloadResult) {
    fn stats_json(name: &str, s: &workload::ShapeStats) -> String {
        format!(
            "{{\"shape\":\"{name}\",\"vertex_count\":{},\"triangle_count\":{},\"total_area\":{}}}",
            s.vertex_count, s.triangle_count, s.total_area
        )
    }
    let bounds = result
        .bounds
        .map(|b| {
            format!(
                "{{\"min_x\":{},\"min_y\":{},\"max_x\":{},\"max_y\":{},\"width\":{},\"height\":{}}}",
                b.min_x,
                b.min_y,
                b.max_x,
                b.max_y,
                b.width(),
                b.height()
            )
        })
        .unwrap_or_else(|| "null".to_string());
    let timings = timings_ns
        .iter()
        .map(|t| t.to_string())
        .collect::<Vec<_>>()
        .join(",");
    println!(
        "{{\"backend\":\"{backend}\",\"timings_ns\":[{timings}],\"total_vertices\":{},\"shapes\":[{},{},{},{}],\"bounds\":{bounds}}}",
        result.total_vertices,
        stats_json("rects", &result.rects),
        stats_json("triangles", &result.triangles),
        stats_json("circles", &result.circles),
        stats_json("curve_strokes", &result.curve_strokes),
    );
}

/// WASM entry point: runs the workload once and returns a checksum (the
/// total vertex count across every shape) so the call cannot be
/// dead-code-eliminated and a host (see `scripts/compare-drawing.mjs`)
/// can confirm the module actually executed the real geometry code, not
/// a stub. Exported from both the `internal` and `lyon` builds under the
/// same symbol name, so the driver script does not need feature-specific
/// glue.
#[no_mangle]
pub extern "C" fn run() -> u32 {
    run_selected().total_vertices as u32
}
