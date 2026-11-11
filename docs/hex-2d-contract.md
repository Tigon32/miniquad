# 2D hex layout contract

* Status: **Proposed** (design contract; no implementation on `master`)
* Decision: [MADR 0012](adr/0012-optional-2d-hex-layouts.md)
* Issue: [#133](https://github.com/Tigon32/miniquad/issues/133) (layout and selection)
* Source base: `9379de78757b393cbf4e82843bd06fb0ba01cc68`
* 3D reference: `docs/hex-voxel-contract.md` at `7183afcad706b7a4c7e0b0ea697f6f3d44ff676c`, sections 1.3 to 1.5 and 1.10
* Writing review: **STE-aligned draft**. Full ASD-STE100 dictionary review not done.

This document is the frozen interface for the optional 2D hex layout.
Section 1 is the layout contract for #133.
This file holds only the pure layout/picking contract (#133).
The browser example and its tests (#134) have a separate contract and are not part of this file.
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

## 3. Risks and limits

* The fan rim of `Batch::circle` is not bit-equal to the canonical corners. The gutter hides this.
  An application without a gutter that needs exact seams uses the triangle recipe of section 1.9.
* `Batch::polyline` has butt caps and no joins. A closed hex outline shows corner defects.
* Exact pixel-space ties occur only where the lattice values are exact. Other near-edge points are deterministic, not geometric ties.
* The cross-contract test needs `miniquad_voxel::hex`. Without it, record the test as **blocked**.
  (This base already carries `companions/voxel`, so the test is expected to run, not be blocked.)
* Anti-aliasing can change edge pixels. The samples stay at least 2 logical px from an edge.

The browser example contract, its tests, and the browser-only risk notes (high-contrast fill
cue, resize/status polling, etc.) are issue #134 and are not part of this file.
