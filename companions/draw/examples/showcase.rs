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

const GRID_STEP: f32 = 40.0;
const POINT_COUNT: usize = 48;

struct Point {
    phase: f32,
    radius: f32,
}

struct Showcase {
    ctx: Box<dyn RenderingBackend>,
    renderer: Renderer,
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
            renderer,
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
        let (width, height) = window::screen_size();

        let mut batch = Batch::new();
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

        self.ctx.begin_default_pass(Default::default());
        self.renderer
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
