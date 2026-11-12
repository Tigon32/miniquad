//! A ready-to-use interactive 2D hex board, built only from public
//! `miniquad-draw` items: `miniquad_draw::hex`, `Batch`, `Renderer`,
//! `Color`, and `Transform2D`. See `docs/hex-2d-contract.md` sections
//! 3 and 4 (MADR 0012, issue #134) for the frozen board, color,
//! export, pointer, HTML host, release, and WebGL-build contract this
//! file implements exactly. This example does not copy layout math,
//! and has no simulation, pathfinding, terrain, network, or GL HUD.
//!
//! Build WebGL1 (default):
//!
//! ```sh
//! cargo build --release --target wasm32-unknown-unknown \
//!     --manifest-path companions/draw/Cargo.toml --example hex_board
//! ```
//!
//! Build WebGL2:
//!
//! ```sh
//! HEX_BOARD_WEBGL=2 cargo build --release --target wasm32-unknown-unknown \
//!     --manifest-path companions/draw/Cargo.toml --example hex_board
//! ```
//!
//! Check only, without a full build:
//!
//! ```sh
//! cargo check --target wasm32-unknown-unknown \
//!     --manifest-path companions/draw/Cargo.toml --example hex_board
//! ```

use miniquad::*;
use miniquad_draw::hex::{HexCoord, HexError, HexLayout, HexOrientation};
use miniquad_draw::{Batch, Color, Renderer, Transform2D};
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};

/// The board holds every cell within this lattice distance of `(0, 0)`:
/// 37 cells (section 3.2).
const BOARD_DISTANCE: u32 = 3;
/// `37` cells: `BOARD_DISTANCE = 3` on each axis (section 3.2).
const BOARD_MAX_CELLS: u32 = 37;
/// Below this logical `min(w, h)`, in px, the board is too small to
/// draw (radius would fall below `8`; section 3.2).
const MIN_BOARD_SIZE: f32 = 104.0;
/// The largest circumradius the board ever uses, in logical px.
const MAX_BOARD_RADIUS: f32 = 40.0;
/// One logical px of fill inset from the cell circumradius (section 3.2).
const FILL_INSET: f32 = 3.0;
/// The marker circumradius, as a fraction of the cell circumradius.
const MARKER_FRACTION: f32 = 0.4;
/// Circle fan segments for every drawn hex (flat-top hexagon).
const HEX_SEGMENTS: u32 = 6;

/// `last_input` and `hex_probe_cell_at` result codes (section 3.4).
const INPUT_NONE: u32 = 0;
const INPUT_CELL: u32 = 1;
const INPUT_OUTSIDE: u32 = 2;
const INPUT_INVALID: u32 = 3;
const INPUT_TOO_SMALL: u32 = 4;

static ORIENTATION: AtomicU32 = AtomicU32::new(0);
static THEME: AtomicU32 = AtomicU32::new(0);
static SELECTED_VALID: AtomicU32 = AtomicU32::new(0);
static SELECTED_Q: AtomicI32 = AtomicI32::new(0);
static SELECTED_R: AtomicI32 = AtomicI32::new(0);
static RELEASE_REQUESTED: AtomicU32 = AtomicU32::new(0);
static RESOURCES_LIVE: AtomicU32 = AtomicU32::new(1);
static RELEASE_DONE: AtomicU32 = AtomicU32::new(0);
static LAST_INPUT: AtomicU32 = AtomicU32::new(INPUT_NONE);
/// The cell of the last pointer input that reached a board cell, kept
/// separate from `hex_probe_last_q`/`hex_probe_last_r` (section 3.4).
static LAST_Q: AtomicI32 = AtomicI32::new(0);
static LAST_R: AtomicI32 = AtomicI32::new(0);
/// The cell of the last `hex_probe_cell_at` call that returned `0`
/// (section 3.4). `hex_probe_cell_at` never touches selection or
/// `last_input`: it is pure.
static PROBE_LAST_Q: AtomicI32 = AtomicI32::new(0);
static PROBE_LAST_R: AtomicI32 = AtomicI32::new(0);
static LAYOUT_RADIUS_BITS: AtomicU32 = AtomicU32::new(0);
static LAYOUT_ORIGIN_X_BITS: AtomicU32 = AtomicU32::new(0);
static LAYOUT_ORIGIN_Y_BITS: AtomicU32 = AtomicU32::new(0);
static CELLS_DRAWN: AtomicU32 = AtomicU32::new(0);
static TRIANGLES: AtomicU32 = AtomicU32::new(0);

/// One theme's opaque sRGB colors (section 3.3).
struct Theme {
    clear: Color,
    cell: Color,
    selected: Color,
    marker: Color,
}

/// Builds an opaque [`Color`] from an `0xRRGGBB` sRGB literal, dividing
/// each 8-bit channel by `255`.
const fn rgb(hex: u32) -> Color {
    let r = ((hex >> 16) & 0xff) as f32 / 255.0;
    let g = ((hex >> 8) & 0xff) as f32 / 255.0;
    let b = (hex & 0xff) as f32 / 255.0;
    Color::new(r, g, b, 1.0)
}

const THEMES: [Theme; 3] = [
    // 0: light
    Theme {
        clear: rgb(0xFFFFFF),
        cell: rgb(0x7D90A8),
        selected: rgb(0x0A2F6E),
        marker: rgb(0xFFFFFF),
    },
    // 1: dark
    Theme {
        clear: rgb(0x101418),
        cell: rgb(0x56667A),
        selected: rgb(0xB8D8FF),
        marker: rgb(0x101418),
    },
    // 2: high contrast
    Theme {
        clear: rgb(0x000000),
        cell: rgb(0xFFFFFF),
        selected: rgb(0xFFD400),
        marker: rgb(0x000000),
    },
];

fn theme(index: u32) -> &'static Theme {
    &THEMES[index as usize]
}

fn orientation_from_atomic(value: u32) -> HexOrientation {
    if value == 1 {
        HexOrientation::PointyTop
    } else {
        HexOrientation::FlatTop
    }
}

/// `true` for the 37 cells of the board (section 3.2): a cell at
/// lattice distance `<= BOARD_DISTANCE` of `(0, 0)`.
fn on_board(cell: HexCoord) -> bool {
    HexCoord::new(0, 0)
        .expect("(0, 0) is always a valid HexCoord")
        .distance(cell)
        <= BOARD_DISTANCE
}

/// Builds the 37-cell board, in the build order of section 3.2: `q`
/// from `-3` to `3`, then `r` from `-3` to `3`, skipping any cell with
/// distance `> BOARD_DISTANCE`.
fn board_cells() -> Vec<HexCoord> {
    let d = BOARD_DISTANCE as i32;
    let mut cells = Vec::with_capacity(BOARD_MAX_CELLS as usize);
    for q in -d..=d {
        for r in -d..=d {
            if let Ok(cell) = HexCoord::new(q, r) {
                if on_board(cell) {
                    cells.push(cell);
                }
            }
        }
    }
    cells
}

/// Builds a [`HexLayout`] from the current layout atomics. Returns
/// `Err` if the radius atomic is `0` (the too-small state has no
/// layout) or if the stored values are no longer in range. Used by
/// both the pointer handler and `hex_probe_cell_at`, so both read
/// exactly the layout the last frame drew.
fn layout_from_atomics() -> Option<HexLayout> {
    let radius_bits = LAYOUT_RADIUS_BITS.load(Ordering::Relaxed);
    if radius_bits == 0 {
        return None;
    }
    let radius = f32::from_bits(radius_bits);
    let origin = (
        f32::from_bits(LAYOUT_ORIGIN_X_BITS.load(Ordering::Relaxed)),
        f32::from_bits(LAYOUT_ORIGIN_Y_BITS.load(Ordering::Relaxed)),
    );
    let orientation = orientation_from_atomic(ORIENTATION.load(Ordering::Relaxed));
    HexLayout::new(orientation, radius, origin).ok()
}

/// Classifies a `layout.cell_at(point)` result into a `last_input` /
/// `hex_probe_cell_at` code (sections 3.4 and 3.5): a board cell is
/// `INPUT_CELL`; a cell outside the board, or `CoordinateOutOfRange`,
/// is `INPUT_OUTSIDE`; any other [`HexError`] is `INPUT_INVALID`.
fn classify(result: &Result<HexCoord, HexError>) -> (u32, Option<HexCoord>) {
    match result {
        Ok(cell) if on_board(*cell) => (INPUT_CELL, Some(*cell)),
        Ok(_) => (INPUT_OUTSIDE, None),
        Err(HexError::CoordinateOutOfRange) => (INPUT_OUTSIDE, None),
        Err(_) => (INPUT_INVALID, None),
    }
}

struct HexBoard {
    ctx: Box<dyn RenderingBackend>,
    renderer: Option<Renderer>,
    cells: Vec<HexCoord>,
}

impl HexBoard {
    fn new() -> HexBoard {
        let mut ctx: Box<dyn RenderingBackend> = window::new_rendering_backend();
        let renderer = Renderer::new(ctx.as_mut());
        HexBoard {
            ctx,
            renderer: Some(renderer),
            cells: board_cells(),
        }
    }

    /// Recomputes the logical layout from the current window size, and
    /// publishes it to the layout probe atomics (section 3.2). Returns
    /// `None` in the too-small state (`min(w, h) < MIN_BOARD_SIZE`).
    fn current_layout(&self) -> Option<HexLayout> {
        let (sw, sh) = window::screen_size();
        let dpi = window::dpi_scale();
        let w = sw / dpi;
        let h = sh / dpi;
        let min_wh = w.min(h);

        let (radius, origin) = if min_wh < MIN_BOARD_SIZE {
            (0.0_f32, (0.0_f32, 0.0_f32))
        } else {
            let radius = MAX_BOARD_RADIUS.min((min_wh / 13.0).floor());
            (radius, ((w / 2.0).floor(), (h / 2.0).floor()))
        };

        LAYOUT_RADIUS_BITS.store(radius.to_bits(), Ordering::Relaxed);
        LAYOUT_ORIGIN_X_BITS.store(origin.0.to_bits(), Ordering::Relaxed);
        LAYOUT_ORIGIN_Y_BITS.store(origin.1.to_bits(), Ordering::Relaxed);

        if radius <= 0.0 {
            return None;
        }
        let orientation = orientation_from_atomic(ORIENTATION.load(Ordering::Relaxed));
        HexLayout::new(orientation, radius, origin).ok()
    }

    /// Releases the renderer's GPU resources exactly once (section
    /// 3.7): called from `draw` on the frame after
    /// `hex_board_request_release`. Never exports the `Stage`/`HexBoard`
    /// pointer itself; only scalar atomics cross the WASM boundary.
    fn release(&mut self) {
        if let Some(renderer) = self.renderer.take() {
            renderer.destroy(self.ctx.as_mut());
        }
        RESOURCES_LIVE.store(0, Ordering::Relaxed);
        RELEASE_DONE.store(1, Ordering::Relaxed);
    }
}

impl EventHandler for HexBoard {
    fn update(&mut self) {}

    fn draw(&mut self) {
        // Already released: draw nothing (section 3.7, step 3).
        if RESOURCES_LIVE.load(Ordering::Relaxed) == 0 {
            return;
        }
        // A release request arrived: this is the release frame. It
        // destroys the renderer and draws nothing more.
        if RELEASE_REQUESTED.load(Ordering::Relaxed) == 1 {
            self.release();
            return;
        }

        let theme_index = THEME.load(Ordering::Relaxed).min(2);
        let colors = theme(theme_index);

        let layout = match self.current_layout() {
            Some(layout) => layout,
            None => {
                // Too small: draw the clear color only, keep the
                // selection, and report no drawn cells (section 3.2).
                CELLS_DRAWN.store(0, Ordering::Relaxed);
                TRIANGLES.store(0, Ordering::Relaxed);
                let c = colors.clear;
                self.ctx
                    .begin_default_pass(PassAction::clear_color(c.r, c.g, c.b, 1.0));
                self.ctx.end_render_pass();
                self.ctx.commit_frame();
                return;
            }
        };

        // `HexLayout` is a logical-pixel, DPI-independent space
        // (`docs/hex-2d-contract.md` section 1.2). The GPU adapter's
        // `target_size` and scissor rect are physical pixels
        // (`docs/drawing-companion.md`), so every pushed transform is
        // composed with a uniform scale by `dpi_scale` here, and
        // `Renderer::draw` gets the physical `screen_size()` in the
        // same space as the geometry it draws.
        let (sw, sh) = window::screen_size();
        let dpi = window::dpi_scale();
        let to_physical = Transform2D::scaling(dpi, dpi);

        let selected_valid = SELECTED_VALID.load(Ordering::Relaxed) == 1;
        let selected_cell = HexCoord::new(
            SELECTED_Q.load(Ordering::Relaxed),
            SELECTED_R.load(Ordering::Relaxed),
        )
        .ok();

        let mut batch = Batch::new();
        let fill_radius = layout.radius() - FILL_INSET;
        for &cell in &self.cells {
            let fill_color = if selected_valid && selected_cell == Some(cell) {
                colors.selected
            } else {
                colors.cell
            };
            let transform = layout
                .cell_transform(cell)
                .expect("every board cell has a finite in-range transform")
                .then(to_physical);
            batch
                .circle((0.0, 0.0), fill_radius, HEX_SEGMENTS, fill_color, transform)
                .expect("the board fill radius stays in bounds");
        }

        let mut triangles = self.cells.len() as u32 * HEX_SEGMENTS;
        if let (true, Some(cell)) = (selected_valid, selected_cell) {
            if on_board(cell) {
                let transform = layout
                    .cell_transform(cell)
                    .expect("the selected board cell has a finite in-range transform")
                    .then(to_physical);
                batch
                    .circle(
                        (0.0, 0.0),
                        MARKER_FRACTION * layout.radius(),
                        HEX_SEGMENTS,
                        colors.marker,
                        transform,
                    )
                    .expect("the marker radius stays in bounds");
                triangles += HEX_SEGMENTS;
            }
        }

        CELLS_DRAWN.store(self.cells.len() as u32, Ordering::Relaxed);
        TRIANGLES.store(triangles, Ordering::Relaxed);

        let c = colors.clear;
        self.ctx
            .begin_default_pass(PassAction::clear_color(c.r, c.g, c.b, 1.0));
        if let Some(renderer) = self.renderer.as_mut() {
            renderer.draw(self.ctx.as_mut(), &batch, (sw, sh));
        }
        self.ctx.end_render_pass();
        self.ctx.commit_frame();
    }

    fn resize_event(&mut self, _width: f32, _height: f32) {
        // The layout is recomputed from `window::screen_size()` at the
        // start of every `draw` (section 3.2: "Recalculate the layout
        // on each resize_event and at the next frame").
    }

    fn mouse_button_down_event(&mut self, button: MouseButton, x: f32, y: f32) {
        if button != MouseButton::Left {
            return;
        }
        let dpi = window::dpi_scale();
        let logical = (x / dpi, y / dpi);

        let layout = match layout_from_atomics() {
            Some(layout) => layout,
            None => {
                LAST_INPUT.store(INPUT_TOO_SMALL, Ordering::Relaxed);
                return;
            }
        };

        let result = layout.cell_at(logical);
        let (code, cell) = classify(&result);
        LAST_INPUT.store(code, Ordering::Relaxed);
        if let (INPUT_CELL, Some(cell)) = (code, cell) {
            SELECTED_Q.store(cell.q(), Ordering::Relaxed);
            SELECTED_R.store(cell.r(), Ordering::Relaxed);
            SELECTED_VALID.store(1, Ordering::Relaxed);
            LAST_Q.store(cell.q(), Ordering::Relaxed);
            LAST_R.store(cell.r(), Ordering::Relaxed);
        }
    }
}

#[no_mangle]
pub extern "C" fn hex_board_set_orientation(o: u32) -> i32 {
    if o == 0 || o == 1 {
        ORIENTATION.store(o, Ordering::Relaxed);
        0
    } else {
        1
    }
}

#[no_mangle]
pub extern "C" fn hex_board_set_theme(t: u32) -> i32 {
    if t <= 2 {
        THEME.store(t, Ordering::Relaxed);
        0
    } else {
        1
    }
}

#[no_mangle]
pub extern "C" fn hex_board_select(q: i32, r: i32) -> i32 {
    match HexCoord::new(q, r) {
        Ok(cell) if on_board(cell) => {
            SELECTED_Q.store(q, Ordering::Relaxed);
            SELECTED_R.store(r, Ordering::Relaxed);
            SELECTED_VALID.store(1, Ordering::Relaxed);
            LAST_INPUT.store(INPUT_CELL, Ordering::Relaxed);
            0
        }
        _ => {
            LAST_INPUT.store(INPUT_OUTSIDE, Ordering::Relaxed);
            1
        }
    }
}

#[no_mangle]
pub extern "C" fn hex_board_clear_selection() -> i32 {
    SELECTED_VALID.store(0, Ordering::Relaxed);
    SELECTED_Q.store(0, Ordering::Relaxed);
    SELECTED_R.store(0, Ordering::Relaxed);
    0
}

#[no_mangle]
pub extern "C" fn hex_board_request_release() -> i32 {
    if RELEASE_REQUESTED.swap(1, Ordering::Relaxed) == 1 {
        1
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn hex_probe_cell_at(x_bits: u32, y_bits: u32) -> i32 {
    let point = (f32::from_bits(x_bits), f32::from_bits(y_bits));
    let layout = match layout_from_atomics() {
        Some(layout) => layout,
        // Section 3.4: `hex_probe_cell_at` only ever returns 0, 1, or 2.
        // The too-small state shares code 2 ("invalid input or too
        // small") with any other `HexError`; it never returns the
        // `last_input`-only code 4.
        None => return 2,
    };
    let result = layout.cell_at(point);
    let (code, cell) = classify(&result);
    if let (INPUT_CELL, Some(cell)) = (code, cell) {
        PROBE_LAST_Q.store(cell.q(), Ordering::Relaxed);
        PROBE_LAST_R.store(cell.r(), Ordering::Relaxed);
        return 0;
    }
    // `hex_probe_cell_at` is pure: section 3.4 result codes `1` and
    // `2` share this function's own invalid/too-small code
    // (`INPUT_INVALID` also covers a non-finite or out-of-bound point).
    if code == INPUT_OUTSIDE {
        1
    } else {
        2
    }
}

#[no_mangle]
pub extern "C" fn hex_probe_last_q() -> i32 {
    PROBE_LAST_Q.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_last_r() -> i32 {
    PROBE_LAST_R.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_selected_valid() -> u32 {
    SELECTED_VALID.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_selected_q() -> i32 {
    SELECTED_Q.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_selected_r() -> i32 {
    SELECTED_R.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_last_input() -> u32 {
    LAST_INPUT.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_layout_radius_bits() -> u32 {
    LAYOUT_RADIUS_BITS.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_layout_origin_x_bits() -> u32 {
    LAYOUT_ORIGIN_X_BITS.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_layout_origin_y_bits() -> u32 {
    LAYOUT_ORIGIN_Y_BITS.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_orientation() -> u32 {
    ORIENTATION.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_cells_drawn() -> u32 {
    CELLS_DRAWN.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_probe_triangles() -> u32 {
    TRIANGLES.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn resources_live() -> u32 {
    RESOURCES_LIVE.load(Ordering::Relaxed)
}

#[no_mangle]
pub extern "C" fn hex_board_release_done() -> u32 {
    RELEASE_DONE.load(Ordering::Relaxed)
}

fn main() {
    let webgl_version = if option_env!("HEX_BOARD_WEBGL") == Some("2") {
        conf::WebGLVersion::WebGL2
    } else {
        conf::WebGLVersion::WebGL1
    };

    let conf = conf::Conf {
        window_title: "2D hex board".to_string(),
        high_dpi: true,
        platform: conf::Platform {
            webgl_version,
            ..Default::default()
        },
        ..Default::default()
    };
    miniquad::start(conf, move || Box::new(HexBoard::new()));
}
