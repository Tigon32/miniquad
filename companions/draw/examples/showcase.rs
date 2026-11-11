//! Compilable WASM showcase for the `miniquad-draw` companion.
//!
//! Draws a background grid, a few arrows (polyline shaft + triangle
//! head), a sampled cubic curve, and a field of animated points, all
//! through the public `miniquad-draw` interface. DOM text labels are
//! intentionally out of scope here: the parent application places HTML
//! labels over (or beside) the canvas, as noted in
//! `docs/drawing-companion.md`.
//!
//! Build for the browser (see the end of `docs/drawing-companion.md` for
//! the full host integration steps):
//!
//! ```sh
//! cargo build --release --target wasm32-unknown-unknown \
//!     --manifest-path companions/draw/Cargo.toml --example showcase
//! ```
//!
//! Check only, without a full build:
//!
//! ```sh
//! cargo check --target wasm32-unknown-unknown \
//!     --manifest-path companions/draw/Cargo.toml --example showcase
//! ```

use miniquad::*;
use miniquad_draw::{Batch, Color, Rect, Renderer, Transform2D};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

const GRID_STEP: f32 = 40.0;
const POINT_COUNT: usize = 48;

/// Set by the exported `request_gpu_release` function, read once per
/// frame by `Showcase::draw`. A plain `AtomicBool` is enough: WASM is
/// single-threaded here (miniquad's wasm bridge calls `frame`/`resize`/
/// etc. from one JS event loop), so this needs no lock, and — unlike a
/// raw global pointer to the `Showcase`/`Renderer` — it carries no
/// pointer or lifetime for a caller to misuse. This is app-specific
/// plumbing for the browser GPU-release proof (issue #123), not a
/// change to miniquad's core ABI.
static RELEASE_REQUESTED: AtomicBool = AtomicBool::new(false);

/// `0` once `Renderer::destroy` has run, `1` while the renderer is live.
/// Exposed to the host page through `resources_live` so a browser test
/// can confirm the GPU release actually happened instead of asserting on
/// JS-side bookkeeping alone.
static RESOURCES_LIVE: AtomicU32 = AtomicU32::new(1);

/// Request that the next `Showcase::draw` call release its GPU
/// resources (`Renderer::destroy`) and stop drawing. Idempotent: calling
/// this more than once, or after the renderer is already destroyed, is a
/// no-op (`Showcase::draw` consumes the `Option<Renderer>` exactly once).
#[no_mangle]
pub extern "C" fn request_gpu_release() {
    RELEASE_REQUESTED.store(true, Ordering::SeqCst);
}

/// `1` while the showcase's `Renderer` is live, `0` after
/// `request_gpu_release` has taken effect.
#[no_mangle]
pub extern "C" fn resources_live() -> u32 {
    RESOURCES_LIVE.load(Ordering::SeqCst)
}

/// Set by `request_empty_frame`, consumed (reset to `false`) by the next
/// `Showcase::draw` call. Exercises `Renderer::draw` with a `Batch` that
/// has zero chunks, to confirm an empty batch does not panic or submit a
/// draw call with a zero-length index buffer (issue #123's "empty batch"
/// qualification case).
static EMPTY_FRAME_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Request that the next frame draw a completely empty `Batch` (no
/// shapes at all) instead of the usual showcase scene. One-shot: the
/// flag is cleared as soon as that one frame has drawn.
#[no_mangle]
pub extern "C" fn request_empty_frame() {
    EMPTY_FRAME_REQUESTED.store(true, Ordering::SeqCst);
}

struct Point {
    phase: f32,
    radius: f32,
}

struct Showcase {
    ctx: Box<dyn RenderingBackend>,
    renderer: Option<Renderer>,
    points: Vec<Point>,
    time: f32,
}

impl Showcase {
    fn new() -> Showcase {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();
        let renderer = Renderer::new(ctx.as_mut());

        let points = (0..POINT_COUNT)
            .map(|i| Point {
                phase: i as f32 * std::f32::consts::TAU / POINT_COUNT as f32,
                radius: 3.0 + (i % 5) as f32,
            })
            .collect();

        Showcase {
            ctx,
            renderer: Some(renderer),
            points,
            time: 0.0,
        }
    }

    fn draw_grid(&self, batch: &mut Batch, width: f32, height: f32) {
        let mut x = 0.0;
        while x <= width {
            batch
                .polyline(
                    &[(x, 0.0), (x, height)],
                    1.0,
                    Color::new(0.3, 0.3, 0.35, 1.0),
                    Transform2D::IDENTITY,
                )
                .expect("grid line is a valid polyline");
            x += GRID_STEP;
        }
        let mut y = 0.0;
        while y <= height {
            batch
                .polyline(
                    &[(0.0, y), (width, y)],
                    1.0,
                    Color::new(0.3, 0.3, 0.35, 1.0),
                    Transform2D::IDENTITY,
                )
                .expect("grid line is a valid polyline");
            y += GRID_STEP;
        }
    }

    fn draw_arrow(&self, batch: &mut Batch, from: (f32, f32), to: (f32, f32), color: Color) {
        batch
            .polyline(&[from, to], 3.0, color, Transform2D::IDENTITY)
            .expect("arrow shaft is a valid polyline");

        let dx = to.0 - from.0;
        let dy = to.1 - from.1;
        let len = (dx * dx + dy * dy).sqrt().max(1.0e-3);
        let ux = dx / len;
        let uy = dy / len;
        // Perpendicular, for the arrow head's base width.
        let px = -uy;
        let py = ux;
        let head_len = 14.0;
        let head_half_width = 7.0;
        let base = (to.0 - ux * head_len, to.1 - uy * head_len);
        let left = (base.0 + px * head_half_width, base.1 + py * head_half_width);
        let right = (base.0 - px * head_half_width, base.1 - py * head_half_width);

        batch
            .triangle(to, left, right, color, Transform2D::IDENTITY)
            .expect("arrow head is a valid triangle");
    }

    fn draw_curve(&self, batch: &mut Batch, width: f32, height: f32) {
        let y = height * 0.3;
        batch
            .cubic_curve_stroke(
                (width * 0.1, y),
                (width * 0.35, y - 120.0),
                (width * 0.65, y + 120.0),
                (width * 0.9, y),
                0.5,
                3.0,
                Color::new(0.9, 0.6, 0.2, 1.0),
                Transform2D::IDENTITY,
            )
            .expect("showcase curve control points are finite and bounded");
    }

    /// Draws three small, fixed, axis-aligned swatches used by the
    /// browser qualification tests (issue #123) to assert clipping,
    /// opacity blending, and draw order against flat interior pixels
    /// (away from any anti-aliased edge, since hard edges are a
    /// documented `miniquad-draw` limit — see `docs/drawing-companion.md`).
    /// All three stay in a reserved top-right strip that the grid,
    /// curve, arrows, and points never otherwise touch, and are drawn
    /// last so nothing else can paint over them.
    fn draw_qc_panels(&self, batch: &mut Batch, width: f32, height: f32) {
        let panel = |x0: f32, y0: f32, x1: f32, y1: f32| {
            Rect::new(width * x0, height * y0, width * (x1 - x0), height * (y1 - y0))
        };

        // Clipping: an opaque base swatch, then a wider opaque overlay
        // clipped to the swatch's left half. A browser test samples the
        // left half (expects the overlay color) and the right half
        // (expects the base color unchanged) to confirm `set_clip`
        // actually restricts the GPU scissor/clip rectangle.
        let clip_base = panel(0.72, 0.02, 0.90, 0.10);
        batch
            .rectangle(clip_base, Color::new(0.0, 0.6, 0.6, 1.0), Transform2D::IDENTITY)
            .expect("clip base swatch stays in bounds");
        batch
            .set_clip(Some(panel(0.72, 0.02, 0.81, 0.10)))
            .expect("clip rectangle stays within the batch's addressable range");
        batch
            .rectangle(
                panel(0.72, 0.02, 0.98, 0.10),
                Color::new(0.95, 0.5, 0.05, 1.0),
                Transform2D::IDENTITY,
            )
            .expect("clip overlay swatch stays in bounds");
        batch.set_clip(None).expect("clearing the clip is always valid");

        // Opacity: an opaque base swatch, then a 50%-alpha overlay of a
        // different color over the same rectangle. The expected blended
        // color is computable (`over` compositing against an opaque
        // background), so a browser test can assert the interior pixel
        // within a small tolerance instead of only checking "some
        // color changed".
        let opacity_panel = panel(0.72, 0.14, 0.90, 0.22);
        batch
            .rectangle(opacity_panel, Color::new(0.9, 0.05, 0.05, 1.0), Transform2D::IDENTITY)
            .expect("opacity base swatch stays in bounds");
        batch
            .rectangle(opacity_panel, Color::new(0.05, 0.05, 0.9, 0.5), Transform2D::IDENTITY)
            .expect("opacity overlay swatch stays in bounds");

        // Draw order: two fully opaque, identically-sized swatches over
        // the same rectangle. The second (yellow) must fully hide the
        // first (green) at every interior pixel if shapes are submitted
        // and drawn in push order (painter's algorithm).
        let order_panel = panel(0.72, 0.26, 0.90, 0.34);
        batch
            .rectangle(order_panel, Color::new(0.1, 0.8, 0.2, 1.0), Transform2D::IDENTITY)
            .expect("draw-order base swatch stays in bounds");
        batch
            .rectangle(order_panel, Color::new(0.95, 0.9, 0.1, 1.0), Transform2D::IDENTITY)
            .expect("draw-order top swatch stays in bounds");
    }

    fn draw_points(&self, batch: &mut Batch, width: f32, height: f32) {
        let cx = width * 0.5;
        let cy = height * 0.7;
        let orbit = height.min(width) * 0.2;
        for p in &self.points {
            let angle = p.phase + self.time;
            let x = cx + orbit * angle.cos();
            let y = cy + orbit * 0.6 * angle.sin();
            batch
                .circle(
                    (x, y),
                    p.radius,
                    16,
                    Color::new(0.2, 0.8, 0.9, 0.9),
                    Transform2D::IDENTITY,
                )
                .expect("animated point radius and segment count stay in bounds");
        }
    }
}

impl EventHandler for Showcase {
    fn update(&mut self) {
        self.time += 0.016;
    }

    fn draw(&mut self) {
        if RELEASE_REQUESTED.load(Ordering::SeqCst) {
            if let Some(renderer) = self.renderer.take() {
                renderer.destroy(self.ctx.as_mut());
                RESOURCES_LIVE.store(0, Ordering::SeqCst);
            }
        }
        if self.renderer.is_none() {
            // Released: still present a defined frame (a clear), so a
            // host page sees a deliberate stop, not a frozen or panicking
            // canvas.
            self.ctx
                .begin_default_pass(PassAction::clear_color(0.0, 0.0, 0.0, 1.0));
            self.ctx.end_render_pass();
            self.ctx.commit_frame();
            return;
        }

        let (width, height) = window::screen_size();

        let mut batch = Batch::new();
        if EMPTY_FRAME_REQUESTED.swap(false, Ordering::SeqCst) {
            // Deliberately submit a zero-chunk batch: `Renderer::draw`
            // must not panic, and must not issue a zero-length draw
            // call, when there is nothing to draw.
            debug_assert!(batch.is_empty());
        } else {
            batch
                .rectangle(
                    Rect::new(0.0, 0.0, width, height),
                    Color::new(0.08, 0.08, 0.1, 1.0),
                    Transform2D::IDENTITY,
                )
                .expect("full-screen background rectangle stays in bounds");

            self.draw_grid(&mut batch, width, height);
            self.draw_curve(&mut batch, width, height);
            self.draw_arrow(
                &mut batch,
                (width * 0.1, height * 0.85),
                (width * 0.3, height * 0.6),
                Color::new(0.9, 0.3, 0.3, 1.0),
            );
            self.draw_arrow(
                &mut batch,
                (width * 0.9, height * 0.85),
                (width * 0.7, height * 0.6),
                Color::new(0.3, 0.9, 0.4, 1.0),
            );
            self.draw_points(&mut batch, width, height);
            self.draw_qc_panels(&mut batch, width, height);
        }

        // Clear with an opaque alpha. `PassAction::default()` clears alpha
        // to 0.0, and the renderer's blend state (see `gpu.rs`) never
        // writes a *new* alpha afterward, it only ever preserves
        // whatever is already in the framebuffer; this protects an
        // already-opaque canvas from translucent draws, but only if the
        // canvas starts opaque. On the WASM build, a canvas with alpha
        // 0.0 composites as fully transparent against the host page
        // (`premultipliedAlpha: true` is the WebGL default), hiding every
        // drawn color behind the page background. See
        // `docs/drawing-companion.md` for the full writeup.
        self.ctx
            .begin_default_pass(PassAction::clear_color(0.08, 0.08, 0.1, 1.0));
        self.renderer
            .as_mut()
            .expect("checked Some above")
            .draw(self.ctx.as_mut(), &batch, (width, height));
        self.ctx.end_render_pass();
        self.ctx.commit_frame();
    }
}

fn main() {
    let conf = conf::Conf {
        window_title: "miniquad-draw showcase".to_string(),
        ..Default::default()
    };
    miniquad::start(conf, move || Box::new(Showcase::new()));
}
