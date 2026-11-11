//! Issue #123 external-consumer qualification fixture.
//!
//! This crate is deliberately separate from `companions/draw`: it only
//! depends on `miniquad-draw`'s public API (`Batch`, `Color`, `Rect`,
//! `Renderer`, `Transform2D`) through its `Cargo.toml` path dependency,
//! the same shape a downstream consumer would use via a pinned Git
//! dependency once the crate has a public repository home. No geometry,
//! batching, or GPU code is copied from the companion here — this file
//! only calls the companion's existing public functions.
//!
//! Renders one real frame: an opaque background, one rectangle, and one
//! circle, through the companion's actual `Renderer::draw` GPU path (not
//! a CPU-only check like `experiments/drawing-comparison`'s workload
//! comparison). Build for the browser:
//!
//! ```sh
//! cargo build --release --target wasm32-unknown-unknown \
//!     --manifest-path experiments/drawing-comparison/external-consumer/Cargo.toml \
//!     --example consume
//! ```
use miniquad::*;
use miniquad_draw::{Batch, Color, Rect, Renderer, Transform2D};

struct Consumer {
    ctx: Box<dyn RenderingBackend>,
    renderer: Renderer,
}

impl Consumer {
    fn new() -> Consumer {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();
        let renderer = Renderer::new(ctx.as_mut());
        Consumer { ctx, renderer }
    }
}

impl EventHandler for Consumer {
    fn update(&mut self) {}

    fn draw(&mut self) {
        let (width, height) = window::screen_size();

        let mut batch = Batch::new();
        batch
            .rectangle(
                Rect::new(width * 0.2, height * 0.2, width * 0.3, height * 0.3),
                Color::new(0.85, 0.2, 0.2, 1.0),
                Transform2D::IDENTITY,
            )
            .expect("fixture rectangle stays in bounds");
        batch
            .circle(
                (width * 0.65, height * 0.6),
                (width.min(height) * 0.15).max(1.0),
                24,
                Color::new(0.2, 0.5, 0.9, 1.0),
                Transform2D::IDENTITY,
            )
            .expect("fixture circle radius and segment count stay in bounds");

        self.ctx
            .begin_default_pass(PassAction::clear_color(0.1, 0.1, 0.12, 1.0));
        self.renderer.draw(self.ctx.as_mut(), &batch, (width, height));
        self.ctx.end_render_pass();
        self.ctx.commit_frame();
    }
}

fn main() {
    let conf = conf::Conf {
        window_title: "drawing-external-consumer fixture".to_string(),
        ..Default::default()
    };
    miniquad::start(conf, move || Box::new(Consumer::new()));
}
