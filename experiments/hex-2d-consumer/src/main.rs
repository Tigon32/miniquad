//! A fresh downstream crate: depends on `miniquad-draw` by path and
//! draws the 37-cell hex board using only its public items
//! (`miniquad_draw::hex`, `Batch`, `Renderer`, `Color`, `Transform2D`).
//! See `docs/hex-2d-contract.md` sections 2 and 4.7 (MADR 0012, issue
//! #134): this crate is the downstream-consumer check for the optional
//! 2D hex layout module, proving it compiles and draws from outside the
//! `miniquad-draw` crate itself.
//!
//! Build native:
//!
//! ```sh
//! cargo build --manifest-path experiments/hex-2d-consumer/Cargo.toml
//! ```
//!
//! Build WASM:
//!
//! ```sh
//! cargo build --manifest-path experiments/hex-2d-consumer/Cargo.toml \
//!     --target wasm32-unknown-unknown
//! ```

use miniquad::*;
use miniquad_draw::hex::{HexCoord, HexLayout, HexOrientation};
use miniquad_draw::{Batch, Color, Renderer};

/// The board holds every cell within lattice distance `3` of `(0, 0)`:
/// 37 cells (same board as `companions/draw/examples/hex_board.rs`).
const BOARD_DISTANCE: u32 = 3;

fn board_cells() -> Vec<HexCoord> {
    let d = BOARD_DISTANCE as i32;
    let origin = HexCoord::new(0, 0).expect("(0, 0) is always a valid HexCoord");
    let mut cells = Vec::new();
    for q in -d..=d {
        for r in -d..=d {
            if let Ok(cell) = HexCoord::new(q, r) {
                if origin.distance(cell) <= BOARD_DISTANCE {
                    cells.push(cell);
                }
            }
        }
    }
    cells
}

struct Consumer {
    ctx: Box<dyn RenderingBackend>,
    renderer: Renderer,
    cells: Vec<HexCoord>,
}

impl Consumer {
    fn new() -> Consumer {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();
        let renderer = Renderer::new(ctx.as_mut());
        Consumer {
            ctx,
            renderer,
            cells: board_cells(),
        }
    }
}

impl EventHandler for Consumer {
    fn update(&mut self) {}

    fn draw(&mut self) {
        let (width, height) = window::screen_size();
        let layout = HexLayout::new(HexOrientation::FlatTop, 20.0, (width / 2.0, height / 2.0))
            .expect("a fixed radius and an on-screen origin stay in bounds");

        let mut batch = Batch::new();
        for &cell in &self.cells {
            let transform = layout
                .cell_transform(cell)
                .expect("every board cell has a finite in-range transform");
            batch
                .circle(
                    (0.0, 0.0),
                    17.0,
                    6,
                    Color::new(0.4, 0.6, 0.9, 1.0),
                    transform,
                )
                .expect("the fill radius stays in bounds");
        }

        self.ctx
            .begin_default_pass(PassAction::clear_color(0.05, 0.05, 0.08, 1.0));
        self.renderer
            .draw(self.ctx.as_mut(), &batch, (width, height));
        self.ctx.end_render_pass();
        self.ctx.commit_frame();
    }
}

fn main() {
    let conf = conf::Conf {
        window_title: "hex-2d-consumer".to_string(),
        ..Default::default()
    };
    miniquad::start(conf, move || Box::new(Consumer::new()));
}
