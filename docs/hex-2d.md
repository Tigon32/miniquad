# Draw and select a 2D hex grid

**STE-aligned draft.** Full ASD-STE100 dictionary review not done.

This guide shows the optional 2D hex layout in `miniquad-draw`.
It does not add a renderer to Miniquad core.

A **filled 2D hexagon** is a six-segment circle. `Batch::circle` can draw it.
A **2D hex layout** adds axial cell positions, pixel placement, corners,
neighbors, and pointer selection. It has no layer.
A **Hexagonal-prism voxel** adds an integer layer in 3D. Use the optional
`miniquad-voxel` package for that shape. The 2D drawing companion does not
depend on the voxel package.

## Add the optional package

For an in-repository consumer, use these path dependencies:

```toml
[dependencies]
miniquad = { path = "../../" }
miniquad-draw = { path = "../../companions/draw" }
```

Adjust the paths to your checkout. The
[`experiments/hex-2d-consumer`](../experiments/hex-2d-consumer/) crate shows
a complete downstream use of the public API.

## Place and draw cells

Create one layout. Use logical pixels for its radius, origin, and pointer
position. The origin is at the top-left of the drawing area. The Y axis
points down.

```rust
use miniquad_draw::hex::{HexCoord, HexLayout, HexOrientation};

let layout = HexLayout::new(HexOrientation::FlatTop, radius, origin)?;
let cell = HexCoord::new(q, r)?;
let transform = layout.cell_transform(cell)?;
batch.circle((0.0, 0.0), radius - 3.0, 6, color, transform)?;
let selected = layout.cell_at(pointer_in_logical_pixels)?;
```

Use `HexOrientation::PointyTop` for pointy-top cells. Use
`HexCoord::distance` to limit the board. The example uses distance `3`,
which gives 37 cells. The layout checks coordinate and pixel bounds. Handle
its errors; it does not replace an invalid cell with another cell.

`cell_at` expects a point in the same logical-pixel space as the layout
origin. Convert pointer coordinates for the canvas offset and device-pixel
scale before calling it. Do not call it on pixels transformed by shear or
non-uniform scaling.

## Build and test the example

Build the native example:

```sh
cargo build --manifest-path companions/draw/Cargo.toml --example hex_board
```

The browser harness builds separate WebGL1 and WebGL2 fixtures, then tests
the example in Chromium, Firefox, and WebKit:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node experiments/hex-2d-browser/build.mjs
./node_modules/.bin/playwright test --config experiments/hex-2d-browser/playwright.config.mjs
```

The Firefox media-emulation transition test is skipped because its emulation
sends no preference-change event. The high-contrast selection test runs in all
three engines. Desktop WebKit is not an iOS Safari test.

See the [2D hex contract](hex-2d-contract.md) for the board, controls,
selection rules, resource release checks, test commands, and known limits.
