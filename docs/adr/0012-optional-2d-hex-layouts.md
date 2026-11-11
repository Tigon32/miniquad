# Add an optional 2D hex layout to the drawing companion

* Status: **Proposed**
* Date: 2026-11-11
* Scope: Optional drawing companion `companions/draw`. Miniquad core is not in scope.
* Related issues: [#133](https://github.com/Tigon32/miniquad/issues/133), [#134](https://github.com/Tigon32/miniquad/issues/134)
* Related decisions: [MADR 0009](0009-optional-browser-adoption-layer.md), [MADR 0011](0011-optional-hexagonal-prism-topology.md) (3D hexagonal prism, merged to `master` at `de6bff785d1ec71bad1b47ef032d19405c6fd7e2`, PR #136)
* Contract: [2D hex contract](../hex-2d-contract.md)
* Writing review: **STE-aligned draft**. Full ASD-STE100 dictionary review not done.

## Context and Problem Statement

The drawing companion can draw a filled regular hexagon.
`geometry::circle(center, radius, 6, color, transform)` gives a flat-top hexagon.
A rotation of `PI / 6` gives a pointy-top hexagon.
Two out-of-tree Rust probes passed for this geometry. No browser test ran.

The companion has no hex-grid layout and no pixel-to-cell selection.
Each application must write cell placement, negative-coordinate rules, and edge ties.
The 3D work (#130, MADR 0011) uses flat-top axial `(q, r)` cells on the world X/Z plane.
It does not supply a Y-down 2D layout. A 3D ray picker does not replace a 2D hit test.

## Decision Drivers

* Keep Miniquad core, ABI v3, and default cubic behavior unchanged.
* Add no external dependency and no dependency between the two companions.
* Use one axial convention for 2D and 3D. Prevent drift between the two direction tables.
* Make shared corners exact and make edge and vertex ties deterministic.
* Keep the API small. Do not add a hex renderer or a polygon engine.

## Considered Options

| Option | Benefit | Cost |
| --- | --- | --- |
| A. Application recipe in a guide only | No new public items | Each application copies the tie rule and range checks. No permanent tests. |
| B. One pure module `miniquad_draw::hex` in the drawing companion | Same crate as `Batch::circle` and `Transform2D`. No new dependency. | Six neighbor deltas and six corner offsets also exist in `miniquad_voxel::hex`. |
| C. A new shared pure-math crate for 2D and 3D | One copy of the tables | New package, new release unit, and a new dependency for both companions, for about 12 integer constants |
| D. `miniquad-draw` depends on `miniquad-voxel` | One copy of the tables | A 2D user gets the voxel crate. The 2D work waits for the 3D work. |

## Decision Outcome

**Proposed:** option B.
Add one pure module `companions/draw/src/hex.rs`, public path `miniquad_draw::hex`.
The module uses the axial convention, side order, and corner lattice of MADR 0011.
It adds a caller-selected circumradius, a pixel origin, and a 2D orientation.
It uses existing `Batch::circle`, `Batch::polyline`, and `Transform2D` for drawing.
It adds no public shape method. `circle(..., 6, ...)` already fills a cell.

The module has a private copy of the six side deltas and the six corner offsets.
To prevent drift, a cross-contract test compares the 2D module with `miniquad_voxel::hex`.
The test is in a separate test crate that depends on both companions by path.
Neither companion gets a new dependency. The 2D module builds without the 3D module.
If the parent integrator wants one source for the tables, this is a later extraction (option C).
That extraction needs a new decision. This decision does not require it.

## Rejected Options

* A: issue #133 requires permanent tests and a public API.
* C: a new crate costs more than the duplication of 12 integer constants with a lock test.
* D: it couples the 2D release to 3D meshing, chunk, and world types.

## Consequences

* Good: a downstream 2D application can place and select cells through public optional APIs.
* Good: shared corners are bit-equal, because they come from one integer lattice.
* Good: ties use exact constants. Repeated calls give the same cell on native and WASM.
* Bad: two small constant tables exist. The cross-contract test is the control.
  `miniquad_voxel::hex` is on this integration base (PR #136), so the cross-contract test runs,
  not blocked. On a base without it, record the test as **blocked**; the 2D unit tests still
  compare with the literal values of the 3D contract on their own.
* Bad: the layout supports a similarity transform only (scale, translation, and the 30° orientation).
  An application with another drawing transform must not use `cell_at` on transformed pixels.
* Neutral: the browser example of #134 is optional. It does not change the companion API.

## Verification

Use the test lists in the [2D hex contract](../hex-2d-contract.md).
Run the companion unit tests, native and WASM compile checks, and `node scripts/check-docs.mjs`.
Browser appearance is not proved by pure geometry tests.

This decision stays **Proposed** until implementation evidence is reviewed.
This record is already in the [decision index](README.md) and the [glossary](../glossary.md)
(Axial coordinate, 2D hex layout).
