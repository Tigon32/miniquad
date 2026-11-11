# Hexagonal-prism voxel geometry: `companions/voxel/src/hex.rs`

* Scope: `companions/voxel/src/hex.rs` (crate `miniquad-voxel`, public path `miniquad_voxel::hex`) and this guide
* Related issue: [#130](https://github.com/Tigon32/miniquad/issues/130) (geometry; this guide)
* Related decision: MADR 0011 — "Optional hexagonal-prism topology" (`docs/adr/0011-optional-hexagonal-prism-topology.md`, status **Proposed**)
* Frozen interface: `docs/hex-voxel-contract.md`, section 1 (authoritative for every signature, constant, and formula below)
* Source base: `9379de78757b393cbf4e82843bd06fb0ba01cc68`
* Writing review: **STE-aligned draft**. Full dictionary review not done.

This guide explains the hexagonal-prism voxel cell, the `hex` module's
public API, and its tested limits. It does not repeat every line of
`docs/hex-voxel-contract.md`; read that document first for the
authoritative signatures. This guide adds a coordinate diagram and a
plain explanation for readers who have not read the contract.

## What this module is (and is not)

The `hex` module adds an **optional, additive** hexagonal-prism voxel
cell shape beside the existing cubic voxel system in
`companions/voxel/`. It does not change `chunk.rs`, `world.rs`,
`mesh.rs`, `math.rs`, or any existing cubic test. It reuses the
existing `Chunk`, `ChunkDims`, `World`, `ChunkCoord`, `MeshBuffers`, and
`Vertex` types without change; there is no `HexChunkDims` or
`HexWorld`. A hex cell's `(q, layer, r)` axes map onto an existing
chunk's `(x, y, z)` axes (see the table below). `World` does not store a
topology flag. The call site selects `mesh::build_chunk_mesh` (cubic) or
`hex::build_hex_chunk_mesh` (hex). The selected mesher interprets all
neighbor chunks with the same topology. Mixing adjacent cubic and hex
chunks needs a separate boundary policy; this module does not supply it.

Not implemented, and out of scope for this module:

* A picker, a browser example, or any UI. Issue #131 owns 3D picking
  and the offline browser example. Issues #133 and #134 own the
  separate 2D layouts and example. Issue #132 owns the network decision.
* Greedy meshing. Only per-cell visible-face culling is implemented.
* Any change to the cubic mesher's error semantics. The cubic mesher
  falls back to a white color for an unknown material; the hex mesher
  rejects an unknown material or an invalid color as an error (section
  1.8 of the contract). This difference is deliberate, not an
  oversight.

## Coordinates: flat-top axial `(q, r)` plus an integer `layer`

A hex cell is `HexCell { q, r, layer }` (all `i32`, private fields,
built only through the checked `HexCell::new`). The hexagon is
**flat-top**: two sides are parallel to the `X` axis in the X/Z plane. `q`
and `r` are axial coordinates on one flat-top hex layer; `layer` is an
integer extrusion height, one layer per unit, matching the cubic `y`
axis idea of "one more voxel up".

```text
Flat-top hex cell at (q, r), one layer:

          ______
         /      \
         \______/

Top view: X increases right; Z increases down.

                    NegR (0,-1)
    NegQ (-1,0)                    PosQNegR (+1,-1)
                       (q,r)
    NegQPosR (-1,+1)                PosQ (+1,0)
                    PosR (0,+1)
```

Increasing `q` by one adds `1.5` to X and `sqrt(3)/2` to Z.
Increasing `r` by one adds `sqrt(3)` to Z and does not change X.

`Top` and `Bottom` move by one `layer` step (`+1`/`-1`) with no change
to `q`/`r`; they are each other's opposite, matching the cubic "up"/
"down" idea.

### Mapping onto a `Chunk`/`World`

| Hex value | Chunk axis | `ChunkCoord` field | `Chunk::get`/`get_mut` argument |
| --- | --- | --- | --- |
| `q` | width `W = dims.x` | `x` | `x` |
| `layer` | height `H = dims.y` | `y` | `y` |
| `r` | depth `D = dims.z` | `z` | `z` |

`HexCell::to_chunk_local`/`from_chunk_local` resolve a cell to
`(ChunkCoord, [u32; 3])` with Euclidean division/remainder on each
axis, the same rule `World::is_solid` already uses for the cubic axes.
Because a lateral neighbor can change both `q` and `r` in one step
(`PosQNegR` and `NegQPosR`; see below), a lateral neighbor chunk can be
**diagonal**, for example `(chunk.x + 1, chunk.z - 1)` from local
`(q = W - 1, r = 0)`.

### `HexFace`: angle order, not axis order

```rust
pub enum HexFace {
    PosQ,      // 0: delta ( 1,  0,  0)
    PosR,      // 1: delta ( 0,  1,  0)
    NegQPosR,  // 2: delta (-1,  1,  0)
    NegQ,      // 3: delta (-1,  0,  0)
    NegR,      // 4: delta ( 0, -1,  0)
    PosQNegR,  // 5: delta ( 1, -1,  0)
    Top,       // 6: delta ( 0,  0,  1) (q, r unchanged; +1 layer)
    Bottom,    // 7: delta ( 0,  0, -1) (q, r unchanged; -1 layer)
}
```

The six lateral faces are in **angle order** around the hexagon, not
axis order. `HexFace::opposite` is `(index + 3) % 6` for a lateral face
and the `Top`/`Bottom` swap for the two vertical faces. `HexFace::ALL`
lists all eight in the order above; `HexFace::SIDES` lists only the six
lateral faces, same order.

### Coordinate bound

```rust
pub const HEX_COORD_MIN: i32 = -65_536;
pub const HEX_COORD_MAX: i32 = 65_535;
```

`q`, `r`, and `layer` must each stay inside this bound. `HexCell::new`
and `HexCell::neighbor` return `Err(HexError::CoordinateOutOfRange)`
rather than wrap, saturate, or silently collapse the coordinate. This
keeps every corner lattice value (next section) exact in `f32` even at
the bound; the module never trades precision for an unchecked wide
coordinate range.

## World-space transform: integer lattice, no trigonometry

`HexCell::center` and `HexCell::corners` compute world-space positions
from an **integer lattice**, not `sin`/`cos`. This keeps neighboring
cells' shared corners bit-identical (exact-match, not epsilon-close),
so adjacent prisms are watertight.

```rust
pub const HEX_RADIUS: f32 = 1.0;
pub const HEX_LAYER_HEIGHT: f32 = 1.0;
pub const HEX_X_STEP: f32 = 0.5;          // = 1.0 / 2.0
pub const HEX_Z_STEP: f32 = 0.866_025_4;  // = 3.0_f32.sqrt() / 2.0
```

For corner `k` (`0..=5`) of cell `(q, r)`:

```text
KX = [ 2,  1, -1, -2, -1,  1]
KZ = [ 0,  1,  1,  0, -1, -1]

X = 3 * q + KX[k]
Z = 2 * r + q + KZ[k]

x = X as f32 * HEX_X_STEP   // 0.5
z = Z as f32 * HEX_Z_STEP   // 0.866_025_4
```

`HexCell::corners` returns `[[f32; 3]; 12]`: indices `0..6` are the
bottom ring (`y = layer as f32 * HEX_LAYER_HEIGHT`), indices `6..12`
are the top ring at the same `(x, z)` (`y = (layer + 1) as f32 *
HEX_LAYER_HEIGHT`). `HexCell::center` is the prism centre at
`y = (layer + 0.5) * HEX_LAYER_HEIGHT`.

## Mesh building: `build_hex_chunk_mesh`

```rust
pub fn build_hex_chunk_mesh(
    world: &World,
    coord: ChunkCoord,
    palette: &[[f32; 4]],
    out: &mut MeshBuffers,
) -> Result<(), HexMeshError>
```

Like the cubic mesher, this clears `out` and appends only the
**visible** faces of the chunk at `coord`: a face is visible when its
neighbor cell is air, or the neighbor chunk is not resident, or the
neighbor coordinate is out of `HexCell`'s bound. A missing/unresolvable
neighbor counts as "not solid", matching `World::is_solid`'s existing
cubic policy.

Two differences from the cubic mesher, both deliberate (frozen by the
contract, not an accident of this implementation):

* **Checked exact-count, not worst-case reservation.** The function
  makes two passes over the chunk: pass 1 validates every non-air
  cell's material id and palette color, and counts the exact vertex
  total with checked (overflow-safe) arithmetic; pass 2 (only reached
  if pass 1 succeeds) reserves exactly that much buffer capacity and
  builds the geometry. If the exact vertex count would exceed
  `HEX_MAX_MESH_VERTICES` (`65_536`, the `u16` mesh-index limit), the
  function returns `Err(HexMeshError::MeshTooLarge { vertices })` with
  the **exact** over-limit count, and `out` is left empty — no partial
  buffer, no panic, no silent truncation.
* **Unknown material or invalid color is an error**, not a fallback
  color. `HexMeshError::UnknownMaterial(id)` when
  `id as usize >= palette.len()`; `HexMeshError::InvalidColor(id)` when
  any channel of `palette[id as usize]` is non-finite or outside
  `0.0..=1.0`. (The cubic mesher instead falls back to white for an
  unrecognized material; the hex mesher does not repeat that
  trade-off.)

Each solid cell contributes up to 8 faces (6 lateral, `Top`,
`Bottom`), iterated in `z, y, x` outer-to-inner order (matching the
chunk's own storage order) with faces visited in `HexFace::ALL` order.

### Triangulation: corner fan, no center vertex

* **Side face** `k` (one of the six lateral faces) is one quad, built
  from 4 of the 12 corners: `bottom k`, `top k`, `top j`, `bottom j`
  (`j = (k + 1) % 6`), indices `[0, 1, 2, 0, 2, 3]` relative to that
  quad's own 4 vertices.
* **Top** and **Bottom** caps are each a 6-vertex ring (`Top` ring
  order `0, 5, 4, 3, 2, 1`; `Bottom` ring order `0..6`), triangulated
  as a 4-triangle fan from index 0, **no added center vertex**: indices
  `[0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]`.

An isolated prism (all 8 faces visible) is therefore exactly **36
vertices, 60 indices, 20 triangles** (6 sides × 4 vertices + 2 caps ×
6 vertices = 36; 6 sides × 2 triangles + 2 caps × 4 triangles = 20).

Every vertex's `normal` is `HexFace::normal()` for its face — flat
per-face shading, matching the cubic mesher. Winding is
counter-clockwise viewed from outside the prism, for every triangle of
every face (checked directly by unit test, not inferred).

## Editing: dirty chunk set

```rust
pub fn hex_dirty_chunks(cell: HexCell, dims: ChunkDims) -> Result<HexDirtyChunks, HexError>
```

Returns the chunk the edited cell lives in, plus every **distinct**
neighbor chunk reachable from that cell via one `HexFace::ALL` step
that lands in a different, in-bound chunk (`CoordinateOutOfRange`
neighbors are skipped, not reported as a dirty chunk). The cell's own
chunk is always first; neighbor chunks follow in `HexFace::ALL` order,
each only once. An interior cell yields 1 chunk; a cell on one q/r
chunk edge yields 2; a cell at a non-diagonal chunk corner yields 3;
a cell at the one diagonal-touching corner per chunk
(`q = W - 1, r = 0` via `PosQNegR`, or `q = 0, r = D - 1` via
`NegQPosR`) yields 4, including the diagonal chunk. `HexDirtyChunks`
holds up to 9 entries (the theoretical maximum across all three axes)
with a tracked length; `as_slice()` exposes only the filled entries.

## Limits (tested, not estimated)

* Coordinate bound: `HEX_COORD_MIN..=HEX_COORD_MAX` (`-65_536..=65_535`)
  for `q`, `r`, and `layer`, each independently checked.
* Mesh size: `HEX_MAX_MESH_VERTICES = 65_536` (the `u16` index limit).
  Exceeding it returns `Err(HexMeshError::MeshTooLarge { vertices })`
  with the exact count, computed before any buffer allocation.
* `ChunkDims`/volume/material bounds are the existing, unchanged cubic
  limits in `chunk.rs`; this module does not relax or tighten them.
* No performance claim is made for this module. No paired
  before/after measurement was run on this shared, non-dedicated
  machine.

## External reference (evidence only, not a source of code or text)

Issue #130 names `ForlornU/VoxelsBeta` (MIT license) as a prior-art
reference for hexagonal-prism voxel meshing, at commit
`1f852c4214ba211cece444c5b423e43bebf8acf1`. This module's author read
about that project only through the already-completed research linked
from issue #130; no file, code, or text from that repository was
opened, copied, ported, or executed while writing this module. Every
formula above (direction order, corner lattice, triangulation, world
transform) was derived from `docs/hex-voxel-contract.md` and verified
by this module's own unit tests, not copied from an external source.
`ForlornU/VoxelsBeta` is a GDScript (Godot) project; this module is
plain Rust with no GDScript, Godot, or scripting-runtime dependency.

## Tests

`cargo test --lib --manifest-path companions/voxel/Cargo.toml` runs the
`hex` module's unit tests alongside the unchanged existing cubic tests,
in the same binary. The `hex` tests cover, among other cases: lateral
neighbor/opposite round trips at the origin, at negative `q`/`r`, and
at the coordinate bound (including the out-of-range error); per-face
normal alignment with the neighbor direction (`1e-5` tolerance);
counter-clockwise winding for every triangle of every face; shared
corners between adjacent cells reversing exactly (watertight check);
an isolated prism's exact vertex/index/triangle counts; a solid 3×3×3
block's exact exterior-only face count; chunk-boundary face culling on
a plain axis and on both diagonal corners; exact dirty-chunk-set
contents for an interior, edge, non-diagonal-corner, and
diagonal-corner cell; and rejection (with an empty output buffer) of an
out-of-range chunk, a non-resident chunk, an unknown material, an
invalid (including non-finite) color, and a mesh that would exceed the
vertex budget.
