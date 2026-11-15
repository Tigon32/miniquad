# 2D hex layout contract

* Status: **Proposed** (layout API merged; browser example is in PR #172)
* Decision: [MADR 0012](adr/0012-optional-2d-hex-layouts.md)
* Issues: [#133](https://github.com/Tigon32/miniquad/issues/133) (layout and selection), [#134](https://github.com/Tigon32/miniquad/issues/134) (browser example)
* Source base: `9379de78757b393cbf4e82843bd06fb0ba01cc68`
* 3D reference: `docs/hex-voxel-contract.md` at `7183afcad706b7a4c7e0b0ea697f6f3d44ff676c`, sections 1.3 to 1.5 and 1.10
* Writing review: **STE-aligned draft**. Full ASD-STE100 dictionary review not done.

This document is the frozen interface for the optional 2D hex layout.
Section 1 is the layout contract for #133.
Sections 3 and 4 are the browser example and its tests for #134.
Do not change a frozen signature without a revision of this document.
This document is not evidence that the code exists or passes tests.

## 1. Layout contract (#133)

### 1.1 Location and limits of the change

* New file: `companions/draw/src/hex.rs`. Public path: `miniquad_draw::hex`.
* `companions/draw/src/lib.rs` gets one new line: `pub mod hex;`. Add no crate-root re-export.
* Do not change `geometry.rs`, `batch.rs`, `gpu.rs`, `color.rs`, or `transform.rs`.
* No `unsafe`, no I/O, no global state, no allocation, no new dependency.
* No dependency on `miniquad-voxel`. No change to Miniquad core, ABI v3, or `js/`.

### 1.2 Coordinates, axes, and the 3D mapping

* A cell is `HexCoord { q, r }`: axial `q` and axial `r`. There is no layer.
* Pixel space is logical pixels, top-left origin, `+x` right, `+y` down, as in `geometry.rs`.
* The 3D contract maps world `(x, z)` to 2D `(u, v)` as `u = x`, `v = z`.
  This contract uses that mapping. In flat-top, with `radius = 1` and `origin = (0, 0)`,
  the 2D center and corners of `(q, r)` are the 3D `(x, z)` values of `HexCell(q, r, layer)`.
* Corner `k` (`k = 0..6`) of a flat-top cell is at angle `60°·k` from `+x`.
  Angles increase from `+x` toward `+y`. In Y-down space, this is clockwise on the screen.
* Pointy-top is the flat-top layout turned by `+30°` around `origin`.
  Corner `k` of a pointy-top cell is at `30° + 60°·k`. Side order and corner order do not change.
  Pointy-top is a 2D option only. The 3D contract has no pointy-top topology.

### 1.3 Side order (same as the 3D side faces 0..6)

| Side `k` | `(dq, dr)` | 3D face | Corners | Flat-top direction | Pointy-top direction |
| --- | --- | --- | --- | --- | --- |
| 0 | `(+1, 0)` | `PosQ` | 0, 1 | 30° | 60° |
| 1 | `(0, +1)` | `PosR` | 1, 2 | 90° | 120° |
| 2 | `(-1, +1)` | `NegQPosR` | 2, 3 | 150° | 180° |
| 3 | `(-1, 0)` | `NegQ` | 3, 4 | 210° | 240° |
| 4 | `(0, -1)` | `NegR` | 4, 5 | 270° | 300° |
| 5 | `(+1, -1)` | `PosQNegR` | 5, 0 | 330° | 0° |

The opposite side of `k` is `(k + 3) % 6`.

### 1.4 Limits

```rust
pub const HEX_COORD_MIN: i32 = -65_536;   // same value as the 3D bound
pub const HEX_COORD_MAX: i32 = 65_535;
pub const HEX_MIN_RADIUS: f32 = 1.0;      // logical pixels
pub const HEX_MAX_RADIUS: f32 = 16_384.0; // logical pixels
```

* `q` and `r` must each be in `HEX_COORD_MIN..=HEX_COORD_MAX`.
* `radius` is the circumradius (center to corner) in logical pixels.
* Each component of `origin`, of a pixel input, and of a pixel output must have
  an absolute value of at most `geometry::MAX_COORDINATE` (`1.0e6`).
* Reason for the minimum radius: near `1.0e6`, the `f32` step is `0.0625` px.
  The apothem at `radius = 1` is `0.866` px. Thus a cell center round trip stays exact.
* A cell with a center or corner outside the pixel bound is valid as a cell.
  `center`, `corners`, and `cell_transform` return `PixelOutOfRange` for it. Nothing is clamped.

### 1.5 Canonical lattice

Calculate positions from integers, then scale once. Use `f64` and convert the result to `f32`.
Use the literal `S64 = 0.866_025_403_784_438_6_f64` (`√3 / 2`).
Do not use `sin`, `cos`, `mul_add`, or `center + offset` for `center` or `corners`.

```text
KX = [ 2, 1, -1, -2, -1,  1]      KZ = [ 0, 1,  1,  0, -1, -1]     (3D corner table)
KU = [ 1, 0, -1, -1,  0,  1]      KV = [ 1, 2,  1, -1, -2, -1]     (pointy-top table)

R = radius as f64, ox = origin.0 as f64, oy = origin.1 as f64   (all lattice integers in i64)

FlatTop:   X = 3*q + KX[k]          Z = 2*r + q + KZ[k]
           x = ox + (X as f64) * (R * 0.5)
           y = oy + (Z as f64) * (R * S64)
           center: X = 3*q, Z = 2*r + q

PointyTop: U = (q - r) + KU[k]      V = 3*(q + r) + KV[k]
           x = ox + (U as f64) * (R * S64)
           y = oy + (V as f64) * (R * 0.5)
           center: U = q - r, V = 3*(q + r)

result = (x as f32, y as f32)
```

The pointy-top table is the flat-top table turned by `+30°`.
Adjacent cells give the same integer pair for a shared corner. Thus the `f32` values are bit-equal.
The largest lattice value is below `2^19`. All lattice integers are exact in `f64` and `f32`.

### 1.6 Point to cell and the tie rule

`cell_at` selects the cell whose center is nearest to the point. Use this exact procedure:

1. Reject a non-finite component: `NonFiniteInput`. Reject a component with
   `|value| > MAX_COORDINATE`: `PixelOutOfRange`.
2. `dx = (px as f64) - ox`, `dy = (py as f64) - oy`.
3. Lattice values. Each is one division:
   * FlatTop: `a = dx / (R * 0.5)`, `b = dy / (R * S64)`.
   * PointyTop: `a = dx / (R * S64)`, `b = dy / (R * 0.5)`.
4. Fractional axial values:
   * FlatTop: `qf = a / 3.0`, `rf = (b - qf) / 2.0`.
   * PointyTop: `qf = (a + b / 3.0) / 2.0`, `rf = (b / 3.0 - a) / 2.0`.
5. Cube rounding: `sf = -qf - rf`. Round each with `f64::round`. If `|q - qf|` is
   strictly the largest difference, set `q = -r - s`. Else if `|r - rf| > |s - sf|`, set `r = -q - s`.
   Convert to `i64` (the values are below `2^23` because of step 1).
6. Candidates: the rounded cell and its 6 neighbors in side order, in `i64`.
7. Distance measure, with integer constants only (4 times the squared distance divided by `R²`):
   * FlatTop: `D = (a - 3q)² + 3·(b - (2r + q))²`.
   * PointyTop: `D = 3·(a - (q - r))² + (b - 3(q + r))²`.
8. **Tie rule:** select the smallest `D`. At equal `D`, select the smallest `(q, r)`
   in lexicographic order (smallest `q`, then smallest `r`). This is tie rule A of the 3D contract.
9. If the selected cell is outside `HEX_COORD_MIN..=HEX_COORD_MAX`: `CoordinateOutOfRange`.
   Do not select a different cell.

The rule is exact for the lattice values `a` and `b`.
A point on an edge or a vertex in pixel space is a tie only when its lattice values are exact.
Example: at `origin = (400, 300)`, `radius = 40`, the pixel `(460, 300)` gives `a = 3`, `b = 0`.
The function is pure. Equal input bits give equal results on native and WASM.

### 1.7 Public items

```rust
use crate::transform::Transform2D;

pub const HEX_COORD_MIN: i32 = -65_536;
pub const HEX_COORD_MAX: i32 = 65_535;
pub const HEX_MIN_RADIUS: f32 = 1.0;
pub const HEX_MAX_RADIUS: f32 = 16_384.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct HexCoord { /* private: q: i32, r: i32 (this field order gives the tie order) */ }

impl HexCoord {
    pub fn new(q: i32, r: i32) -> Result<HexCoord, HexError>;
    pub const fn q(self) -> i32;
    pub const fn r(self) -> i32;
    pub fn neighbor(self, side: usize) -> Result<HexCoord, HexError>;
    pub fn distance(self, other: HexCoord) -> u32;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HexOrientation { FlatTop, PointyTop }

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HexLayout { /* private: orientation, radius: f32, origin: (f32, f32) */ }

impl HexLayout {
    pub fn new(orientation: HexOrientation, radius: f32, origin: (f32, f32))
        -> Result<HexLayout, HexError>;
    pub const fn orientation(self) -> HexOrientation;
    pub const fn radius(self) -> f32;
    pub const fn origin(self) -> (f32, f32);
    pub fn center(self, cell: HexCoord) -> Result<(f32, f32), HexError>;
    pub fn corners(self, cell: HexCoord) -> Result<[(f32, f32); 6], HexError>;
    pub fn cell_transform(self, cell: HexCoord) -> Result<Transform2D, HexError>;
    pub fn cell_at(self, point: (f32, f32)) -> Result<HexCoord, HexError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HexError { NonFiniteInput, InvalidRadius, CoordinateOutOfRange, PixelOutOfRange, InvalidSide }
```

`HexError` implements `Display` and `std::error::Error`.

### 1.8 Rules for each item

* `HexCoord::new`: `CoordinateOutOfRange` if `q` or `r` is outside the bound.
* `neighbor`: `side >= 6` gives `InvalidSide`. Use `checked_add`, then the bound.
  A result outside the bound gives `CoordinateOutOfRange`. It never panics or wraps.
* `distance`: `(|dq| + |dr| + |dq + dr|) / 2` in `i64`. Same value as the 3D `planar_distance`.
* `HexLayout::new`: check in this order. A non-finite `radius` or `origin` component gives
  `NonFiniteInput`. A finite `radius` outside `HEX_MIN_RADIUS..=HEX_MAX_RADIUS` gives `InvalidRadius`.
  An `origin` component with `|value| > MAX_COORDINATE` gives `PixelOutOfRange`.
  A valid layout is always invertible, because it is a uniform scale, a translation, and a rotation.
* `center`, `corners`: section 1.5. If any output component has `|value| > MAX_COORDINATE`,
  return `PixelOutOfRange` and no partial result.
* `cell_transform`: the transform that `Batch::circle((0.0, 0.0), r, 6, color, t)` needs.
  FlatTop: `Transform2D::translation(cx, cy)`.
  PointyTop: `Transform2D::rotation(core::f32::consts::FRAC_PI_6).then(Transform2D::translation(cx, cy))`.
  `(cx, cy)` is `center(cell)`. Errors are the errors of `center`.
  The fan rim is near the canonical corners. It is not bit-equal to them (`sin` and `cos` in `f32`).
* `cell_at`: section 1.6. It does a fixed amount of work (7 candidates). It does not enumerate cells.

The layout has no general `Transform2D`. For pan and zoom, make a new layout with a new
`origin` and `radius`. Do not use `cell_at` on pixels that a different drawing transform moved.
The layout API adds no board type and no cell enumeration. An application owns its board and its limit.

### 1.9 Drawing recipes (no new shape method)

* Filled cell: `batch.circle((0.0, 0.0), fill_radius, 6, color, layout.cell_transform(cell)?)`.
* Outline: `batch.polyline(&closed_corners, thickness, color, Transform2D::IDENTITY)`,
  where `closed_corners` is the 6 corners plus corner 0 again.
  The current polyline has butt caps and no joins. Each corner shows a notch or an overlap.
  Do not claim correct joins.
* Exact shared edges: 4 `Batch::triangle` calls from the canonical corners (fan from corner 0).
  This is an application recipe. It is not a new public method.

### 1.10 Required tests

Unit tests in `companions/draw/src/hex.rs`:

* Side table: the deltas and the order of section 1.3. `neighbor(k)` then `neighbor((k+3)%6)` returns the cell.
* `neighbor` at `HEX_COORD_MAX` with `+1` and at `HEX_COORD_MIN` with `-1` gives `CoordinateOutOfRange`. `neighbor(6)` gives `InvalidSide`.
* `distance`: 0 for equal cells, 1 for each neighbor, and the value for `(HEX_COORD_MIN, HEX_COORD_MAX)` to `(HEX_COORD_MAX, HEX_COORD_MIN)`.
* Literal 3D agreement (flat-top, `radius = 1`, `origin = (0, 0)`): for cells `(0,0)`, `(-3,2)`, `(7,-5)`,
  `(HEX_COORD_MIN, HEX_COORD_MAX)`, `(HEX_COORD_MAX, HEX_COORD_MIN)`, the corner `x` is bit-equal to `X as f32 * 0.5`,
  and the corner `y` is within `4 * f32::EPSILON * max(1, |y|)` of `Z as f32 * 0.866_025_4_f32`, with `X`, `Z` from section 1.5.
* Shared corners, both orientations: for each side `k` of `(0,0)`, `(-4,-3)`, and `(-2,5)`, corners `k` and `(k+1)%6`
  are bit-equal to corners `(k+4)%6` and `(k+3)%6` of `neighbor(k)`.
* Geometry, both orientations: 6 equal sides and each corner at distance `radius` from the center, within `1e-5 * radius`.
  Pointy-top corners equal flat-top corners turned by `+30°` around `origin`, within `1e-5 * radius`.
* Round trip, both orientations, radii `1`, `40`, `16_384`, origins `(0, 0)` and `(-123.5, 77.25)`, cells `(0,0)`, `(-3,2)`, `(1000,-777)`,
  and the two corner cells of the bound: if `center` succeeds, `cell_at(center)` returns the cell.
  For each corner `k`, the point `center + 0.75·(corner_k - center)` (calculated in `f64`, then converted to `f32`) returns the cell.
* Exact ties at `origin = (400, 300)`, `radius = 40`:

  | Orientation | Point | Kind | Result |
  | --- | --- | --- | --- |
  | FlatTop | `(440, 300)` | vertex of `(0,0)`, `(1,0)`, `(1,-1)` | `(0, 0)` |
  | FlatTop | `(460, 300)` | edge of `(1,-1)` and `(1,0)` | `(1, -1)` |
  | FlatTop | `(340, 300)` | edge of `(-1,0)` and `(-1,1)` | `(-1, 0)` |
  | FlatTop | `(360, 300)` | vertex of `(0,0)`, `(-1,0)`, `(-1,1)` | `(-1, 0)` |
  | PointyTop | `(400, 340)` | vertex of `(0,0)`, `(1,0)`, `(0,1)` | `(0, 0)` |
  | PointyTop | `(400, 360)` | edge of `(1,0)` and `(0,1)` | `(0, 1)` |
  | PointyTop | `(400, 240)` | edge of `(-1,0)` and `(0,-1)` | `(-1, 0)` |
  | PointyTop | `(400, 260)` | vertex of `(0,0)`, `(-1,0)`, `(0,-1)` | `(-1, 0)` |

  Call each case 3 times. The results are equal. (A design probe of section 1.6 gave these results.)
* Errors: `NaN` and infinite `radius`, `origin`, and point components; `radius` `0.0`, `-1.0`, `0.999`, `16_384.5`;
  origin component `1.0e6 + 1.0`; a point component `1.0e6 + 1.0`; a point that selects a cell outside the bound
  (flat-top, `radius = 1`, `origin = (0, 0)`, point `(98_305.0, 0.0)`); `center` of `(HEX_COORD_MAX, 0)` at `radius = 16_384`.
* Existing fan covers both orientations: for flat-top and pointy-top, `geometry::circle((0.0, 0.0), R, 6, color, layout.cell_transform(c)?)`
  gives 7 vertices and 18 indices, and rim vertex `k + 1` is within `1e-4 * R + 4e-3` of `corners(c)[k]`, for `|center| <= 1e4`.

Cross-contract test (separate crate, section 2):

* For cells `(0,0)`, `(-3,2)`, `(7,-5)`, and the two bound corners: `neighbor(k)` equals `HexCell::neighbor(HexFace::SIDES[k])` without layer.
* Flat-top, `radius = 1`, `origin = (0, 0)`: `center` and `corners[k]` equal the 3D `(x, z)` of `center()` and `corners()[k]`.
  `x` is bit-equal. `z` is within `4 * f32::EPSILON * max(1, |z|)`.
* `distance` equals `planar_distance`.
* `cell_at` at the 3D center `(x, z)` returns `(q, r)`. The 3D `hex_cell_at_xz` is not required for this test.

## 2. Test crates and checks

* `experiments/hex-2d-consumer/`: a fresh crate that depends on `miniquad-draw` by path.
  It uses only `miniquad_draw::hex` items and `Batch::circle`. Build it for native and `wasm32-unknown-unknown`.
* `experiments/hex-2d-cross-contract/`: a test crate that depends on `miniquad-draw` and `miniquad-voxel` by path.
  It runs only where `miniquad_voxel::hex` exists (merged to public `master` at
  `de6bff785d1ec71bad1b47ef032d19405c6fd7e2`, PR #136). On a base without it, record the test as **blocked**.
  The 2D implementation does not wait for it.
* Commands to record:

```sh
cargo test --manifest-path companions/draw/Cargo.toml --lib
cargo check --manifest-path companions/draw/Cargo.toml --target wasm32-unknown-unknown --lib
cargo build --manifest-path experiments/hex-2d-consumer/Cargo.toml
cargo build --manifest-path experiments/hex-2d-consumer/Cargo.toml --target wasm32-unknown-unknown
cargo test --manifest-path experiments/hex-2d-cross-contract/Cargo.toml
node scripts/check-docs.mjs
```

Native compilation is not native runtime proof. Pure tests do not prove browser appearance.

## 3. Browser example contract (#134)

### 3.1 Files

| File | Content |
| --- | --- |
| `companions/draw/examples/hex_board.rs` | Scene, exports, and probes. One `[[example]]` entry in `companions/draw/Cargo.toml`. |
| `tests/browser/hex-2d.html` | Host page with the HTML controls of section 3.5 |
| `experiments/hex-2d-browser/tests/hex-2d.spec.mjs` | Browser tests of section 4 |
| `experiments/hex-2d-browser/**` | Private fixtures and server, port `4292` only |
| `docs/hex-2d.md` | Downstream guide |

The example uses only `miniquad_draw::hex`, `Batch`, `Renderer`, `Color`, and `Transform2D`.
It does not copy layout math. It has no simulation, pathfinding, terrain, network, or GL HUD.

### 3.2 Board

* Board: all cells `(q, r)` with `HexCoord::new(0, 0).distance(cell) <= 3`.
  This gives exactly 37 cells, from `-3` to `3` on each axis. Limit `BOARD_MAX_CELLS = 37`.
* Build order: `q` from `-3` to `3`, then `r` from `-3` to `3`. Skip cells with distance `> 3`.
* Logical canvas size `(w, h) = screen_size / dpi_scale`. Set `conf.high_dpi = true`.
* `radius = min(40, floor(min(w, h) / 13))`. `origin = (floor(w / 2), floor(h / 2))`.
  The flat-top board is `11 × radius` wide and about `12.13 × radius` high. Pointy-top swaps the two values.
* If `min(w, h) < 104` (radius below 8), the state is **too small**. Draw the clear color only.
  Keep the selection. Recalculate the layout on each `resize_event` and at the next frame.
* Fill radius: `radius - 3`. The 3 px inset gives a gutter of `5.20` px (`6 × 0.866`) between adjacent fills at each radius.
  The gutter shows the clear color. Thus the example does not depend on bit-equal fan edges.
* Draw each cell with `Batch::circle((0.0, 0.0), radius - 3.0, 6, color, layout.cell_transform(cell)?)`.
* Selected cell: fill with the selected color. Then draw a marker:
  `Batch::circle((0.0, 0.0), 0.4 * radius, 6, marker, layout.cell_transform(cell)?)`.
  The marker is the shape cue. Selection does not depend on color only.
* No outline and no alpha blending. All colors are opaque. Painter order: cells in build order, then the marker.
  The example does not use `Batch::polyline`, so the butt-cap and unjoined-corner limit of section 1.9 does not apply to it.
* Per frame: one `Batch`, one `Renderer::draw`. Vertices: `37 × 7 + 7 = 266`. Indices: `38 × 18 = 684`. Triangles: 228 (selected) or 222.

### 3.3 Colors

sRGB, 8 bits for each channel, opaque. Contrast ratios are WCAG 2 relative-luminance values from a design calculation.

| Theme | Clear and gutter | Cell | Selected fill | Marker | Cell/clear | Selected/cell | Marker/selected |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `0` light | `#FFFFFF` | `#7D90A8` | `#0A2F6E` | `#FFFFFF` | 3.27 | 3.91 | 12.77 |
| `1` dark | `#101418` | `#56667A` | `#B8D8FF` | `#101418` | 3.15 | 4.00 | 12.60 |
| `2` high contrast | `#000000` | `#FFFFFF` | `#FFD400` | `#000000` | 21.00 | 1.43 | 14.67 |

In high contrast, the selected fill is near the cell color. The black marker identifies the selection.
The host selects the theme with `js/host-preferences.mjs`: `forced-colors: active` or
`prefers-contrast: more` gives `2`, else `prefers-color-scheme: dark` gives `1`, else `0`.
Forced colors do not change canvas pixels. The HTML controls use system colors in forced colors.

### 3.4 Exports and probes (this example only)

All exports use scalars only. State is in `static` atomics (`AtomicU32`, `AtomicI32`).
No export returns or stores a pointer to `Stage` or to WASM memory. These exports are not part of ABI v3.

| Export | Result |
| --- | --- |
| `hex_board_set_orientation(o: u32) -> i32` | `0` flat-top, `1` pointy-top: returns `0`. Else `1`, no change. |
| `hex_board_set_theme(t: u32) -> i32` | `0`, `1`, `2`: returns `0`. Else `1`, no change. |
| `hex_board_select(q: i32, r: i32) -> i32` | Board cell: `0`, selection set. Else `1`, selection not changed. |
| `hex_board_clear_selection() -> i32` | Always `0` |
| `hex_board_request_release() -> i32` | `0` first request, `1` if a request already exists |
| `hex_probe_cell_at(x_bits: u32, y_bits: u32) -> i32` | Logical-pixel `f32` bits, current layout. `0` board cell, `1` outside board or outside the bound, `2` invalid input or too small. No selection change. |
| `hex_probe_last_q() -> i32`, `hex_probe_last_r() -> i32` | Cell of the last `hex_probe_cell_at` result `0` |
| `hex_probe_selected_valid() -> u32` | `1` or `0` |
| `hex_probe_selected_q() -> i32`, `hex_probe_selected_r() -> i32` | Selected cell (`0, 0` if none) |
| `hex_probe_last_input() -> u32` | Last pointer or select result: `0` none, `1` cell, `2` outside board, `3` invalid, `4` too small |
| `hex_probe_layout_radius_bits() -> u32` | `f32` bits of the current radius (`0` if too small) |
| `hex_probe_layout_origin_x_bits() -> u32`, `..._y_bits() -> u32` | `f32` bits of the current origin |
| `hex_probe_orientation() -> u32` | `0` or `1` |
| `hex_probe_cells_drawn() -> u32` | `37` or `0` |
| `hex_probe_triangles() -> u32` | Triangles in the last frame |
| `resources_live() -> u32` | `1` while the `Renderer` exists, `0` after release |
| `hex_board_release_done() -> u32` | `1` after the release frame |

Commands change atomics. The next `update` or `draw` applies them.
`hex_probe_cell_at` reads the layout atomics and makes a `HexLayout`. It is pure.

### 3.5 Pointer input

* Left `mouse_button_down_event(x, y)`: `logical = (x / dpi_scale, y / dpi_scale)`, then `layout.cell_at`.
* A board cell sets the selection and `last_input = 1`. A cell outside the board, or `CoordinateOutOfRange`,
  sets `last_input = 2` and does not change the selection. Another `HexError` sets `3`. Too small sets `4`.
* The browser bridge removes the canvas and container offset. The test of section 4.4 checks this.

### 3.6 HTML host and keyboard

Host document order:

1. `<h1>2D hex board</h1>`
2. `<fieldset>` with `<legend>Orientation</legend>`: two native radio inputs, `Flat-top` (checked) and `Pointy-top`.
3. `<fieldset>` with `<legend>Select a cell</legend>`: `<label>q <input type="number" min="-3" max="3" step="1" value="0"></label>`,
   the same for `r`, a `Select cell` button, and a `Clear selection` button.
4. `<button>Release scene</button>`
5. `<div id="scene">`: the runtime frame of MADR 0009, `aria-hidden="true"`, `tabindex="-1"` on the frame.
6. `<p id="hex-status" role="status" aria-live="polite">`

* The scene is pointer-only. All functions also work from the HTML controls. The frame ignores keyboard input.
* Tab order: radios, `q`, `r`, `Select cell`, `Clear selection`, `Release scene`, then the next page element.
  Arrow keys change the radio value (native behavior). Enter or Space activates a button.
  Enter in `q` or `r` activates `Select cell`. Focus does not enter the frame. No element traps Tab.
* `:focus-visible` gives a 3 px solid outline in `currentColor` with a 2 px offset. Do not remove it.
* `Select cell` with a non-integer or empty value, or a cell outside the board (for example `q=3 r=3`):
  status shows the error. The selection does not change. The input gets `aria-invalid="true"` until the next valid select.
* Status text, one line each:
  * `Scene: starting` / `Scene: running` / `Scene: board too small` / `Scene: released` / `Scene: error <message>`
  * `Orientation: flat-top` or `Orientation: pointy-top`
  * `Selected: q=<q> r=<r>` or `Selected: none`
  * `Last input: none` / `Last input: cell q=<q> r=<r>` / `Last input: outside board` / `Last input: invalid value`
* The host updates the status after each control action, and after each `pointerup` in `#scene`
  when the runtime frame count increases by 1. The host does not poll in a loop.
* Layout: `#scene` is square (`aspect-ratio: 1`), `width: min(480px, 100vw - 32px)`.
  At a viewport width of `600` px or more, the controls are at the left and the scene at the right.
  Below `600` px, the controls are above the scene in one column. Nothing scrolls horizontally at `320` px.
* Empty state: before startup and after release, draw nothing. The status shows the scene state.

### 3.7 Release protocol

1. If `app.state` is `paused`, call `app.resume()`.
2. Call `hex_board_request_release()`. It stores one atomic request.
3. The next `draw` calls `Renderer::destroy`, sets `resources_live = 0` and `hex_board_release_done = 1`, and draws nothing more.
4. The host waits for `resources_live() == 0`, for a maximum of 2000 ms, one check for each animation frame.
   At timeout, the status shows `Scene: error release timeout`. The host continues to step 5.
5. The host calls `app.dispose()`. Status: `Scene: released`.

Never export a raw `Stage` pointer. Disposal does not prove immediate memory reclamation.

### 3.8 WebGL builds

* Two builds of the same source: WebGL1 is the default. WebGL2 uses `HEX_BOARD_WEBGL=2` at compile time (`option_env!`)
  and sets `conf.platform.webgl_version = WebGLVersion::WebGL2`.
* Output names: `hex_board_webgl1.wasm` and `hex_board_webgl2.wasm`.
* A fallback from WebGL2 to WebGL1 is a test failure, not a pass.

## 4. Browser tests (#134)

### 4.1 Environment

* Server on `127.0.0.1:4292`. Chromium, Firefox, and WebKit, each with WebGL1 and WebGL2 runs.
  Record browser version and OS. A missing engine is **blocked**. Desktop WebKit does not prove iOS Safari.
* Init script in each frame: wrap `HTMLCanvasElement.prototype.getContext` and record each requested type
  and its result. Count `createBuffer`/`deleteBuffer`, `createProgram`/`deleteProgram`, and `createTexture`/`deleteTexture`.
* Assert the context: WebGL1 run, a non-null `"webgl"` context and no `WebGL2RenderingContext`.
  WebGL2 run, a non-null `"webgl2"` context and `instanceof WebGL2RenderingContext`.
* Network: record all requests. Only same-origin HTML, JS, and WASM requests are allowed.

### 4.2 Standard layout for pixel and pointer tests

* `#scene` at page offset left `37` px and top `53` px (host padding), `480 × 480` CSS px.
* Expected layout: `radius = 36`, `origin = (240, 240)`. Assert it through the layout probes first.
* Backing-store sample = `floor(logical × dpr)` on each axis, for `dpr` 1 and 2.
  Assert canvas `width == 480 × dpr`.
* Tolerance: each channel within `8` of the expected 8-bit value. Sample only points at least 2 logical px from a fill edge.

### 4.3 Pixel samples (theme `0`, then repeat each orientation in theme `1` and `2`)

Selected cell `(-2, 1)` through `hex_board_select(-2, 1)`.

| Orientation | Logical point | Expected |
| --- | --- | --- |
| FlatTop | `(240, 240)` center `(0,0)` | cell |
| FlatTop | `(430, 333.53)` 5 px inside the fill corner of `(3,0)` | cell |
| FlatTop | `(439, 333.53)` 6 px outside the fill corner of `(3,0)` | clear |
| FlatTop | `(267, 255.59)` gutter of `(0,0)` and `(1,0)` | clear |
| FlatTop | `(132, 240)` center `(-2,1)` | marker |
| FlatTop | `(154, 240)` | selected fill |
| PointyTop | `(240, 240)` | cell |
| PointyTop | `(333.53, 430)` 5 px inside the fill corner of `(3,0)` | cell |
| PointyTop | `(333.53, 439)` | clear |
| PointyTop | `(255.59, 267)` gutter of `(0,0)` and `(1,0)` | clear |
| PointyTop | `(146.47, 186)` center `(-2,1)` | marker |
| PointyTop | `(146.47, 208)` | selected fill |

The selected fill extends from the marker corner (`14.4` px) to the fill corner (`33` px).
`hex_probe_cells_drawn() == 37`. `hex_probe_triangles() == 228`.

### 4.4 Pointer selection

Use `page.mouse.click` at page point `(37 + x, 53 + y)` for logical `(x, y)`. Repeat at `dpr` 1 and 2.
After each click, wait for one frame, then read the selection probes. Repeat each click 3 times. Results are equal.

| Orientation | Logical `(x, y)` | Kind | Selected |
| --- | --- | --- | --- |
| FlatTop | `(240, 240)` | center | `(0, 0)` |
| FlatTop | `(132, 240)` | center, negative `q` | `(-2, 1)` |
| FlatTop | `(276, 240)` | vertex tie | `(0, 0)` |
| FlatTop | `(294, 240)` | edge tie | `(1, -1)` |
| FlatTop | `(186, 240)` | edge tie | `(-1, 0)` |
| FlatTop | `(204, 240)` | vertex tie | `(-1, 0)` |
| FlatTop | `(470, 240)` | outside board | no change, `last_input = 2` |
| PointyTop | `(240, 276)` | vertex tie | `(0, 0)` |
| PointyTop | `(240, 294)` | edge tie | `(0, 1)` |
| PointyTop | `(240, 186)` | edge tie | `(-1, 0)` |
| PointyTop | `(240, 204)` | vertex tie | `(-1, 0)` |
| PointyTop | `(146, 186)` | near center, negative `q` | `(-2, 1)` |
| PointyTop | `(240, 470)` | outside board | no change, `last_input = 2` |

Each edge of `(0, 0)`, both orientations: the point at `0.8 × 31.177` px from the center in the side direction
(section 1.3), rounded to integer logical px, selects `(0, 0)`. The point at `1.2 × 31.177` px selects `neighbor(k)`.
Compare each click result with `hex_probe_cell_at` at the same logical point.

Resize: set `#scene` to `360 × 360`. Expect `radius = 27`, `origin = (180, 180)`.
Clicks at `(180, 180)` and `(99, 180)` (flat-top) select `(0, 0)` and `(-2, 1)`. Repeat at `dpr` 1 and 2.
Too small: set `#scene` to `96 × 96`. Expect `hex_probe_cells_drawn() == 0`, status `Scene: board too small`,
selection kept, and a click gives `last_input = 4`.

### 4.5 Keyboard and accessibility

* From the page start, Tab visits the order of section 3.6. One more Tab after `Release scene` leaves the controls.
  Shift+Tab returns in reverse order. Focus never goes into the frame.
* Each focused control has a visible outline (computed `outline-style` not `none`).
* Select `q=-3 r=0` with the keyboard: status `Selected: q=-3 r=0`, probe agrees.
  Select `q=3 r=3`: status shows an error, `aria-invalid="true"`, selection not changed.
* Width `320` px: no horizontal scroll (`scrollWidth <= clientWidth`), the controls are above the scene.
* Emulate `prefers-color-scheme: dark` and `forced-colors: active`. Assert theme `1` and theme `2` pixels.

### 4.6 Release and resource bounds

* Three cycles on one page: mount, wait for 3 frames, select a cell, release (section 3.7), dispose.
* After each release: `resources_live() == 0` within 2000 ms, `hex_board_release_done() == 1`,
  and live buffers, programs, and textures created by the scene are `0`.
  If Miniquad creates objects before the scene, record that baseline with evidence and subtract it.
* Run one cycle with `app.pause()` before release. The protocol resumes and completes.
* Do not claim leak freedom or memory reclamation from a stable WASM memory size.

### 4.7 Downstream consumer

* `experiments/hex-2d-consumer/` (section 2) also draws the 37-cell board with `Batch::circle` in a small `EventHandler`.
  Record the dependency path, source SHA, and exact commands. Native compilation is not native runtime proof.

### 4.8 Commands to record

```sh
node experiments/hex-2d-browser/build.mjs
./node_modules/.bin/playwright test --config experiments/hex-2d-browser/playwright.config.mjs
cargo build --release --target wasm32-unknown-unknown --manifest-path companions/draw/Cargo.toml --example hex_board
HEX_BOARD_WEBGL=2 cargo build --release --target wasm32-unknown-unknown --manifest-path companions/draw/Cargo.toml --example hex_board
npm run lint:js
node scripts/check-docs.mjs
```

Record each test that did not run, with the reason.

## 5. Risks and limits

* The fan rim of `Batch::circle` is not bit-equal to the canonical corners. The gutter hides this.
  An application without a gutter that needs exact seams uses the triangle recipe of section 1.9.
* `Batch::polyline` has butt caps and no joins. A closed hex outline shows corner defects.
* Exact pixel-space ties occur only where the lattice values are exact. Other near-edge points are deterministic, not geometric ties.
* The high-contrast selected fill has a low contrast with the cell color. The marker is the cue.
* The cross-contract test needs `miniquad_voxel::hex`. It runs on this base, which contains
  `companions/voxel`. On a base without it, record the test as **blocked**.
* Anti-aliasing can change edge pixels. The samples stay at least 2 logical px from an edge.
