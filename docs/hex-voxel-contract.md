# Hexagonal-prism voxel contract

* Status: **Proposed** (design contract; no implementation on `master`)
* Decision: [MADR 0011](adr/0011-optional-hexagonal-prism-topology.md)
* Issues: [#130](https://github.com/Tigon32/miniquad/issues/130) (geometry), [#131](https://github.com/Tigon32/miniquad/issues/131) (browser), [#132](https://github.com/Tigon32/miniquad/issues/132) (protocol, deferred)
* Source base: `9379de78757b393cbf4e82843bd06fb0ba01cc68`
* Writing review: **STE-aligned draft**. Full ASD-STE100 dictionary review not done.

This document is the frozen interface for the optional hex work in `companions/voxel/`.
Section 1 is the geometry contract for #130.
Do not change a frozen signature without a revision of this document.
This document is not evidence that the code exists or passes tests.

## 1. Geometry contract (#130)

### 1.1 Location and limits of the change

* New file: `companions/voxel/src/hex.rs`. Public path: `miniquad_voxel::hex`.
  The implementation can use private submodules. The public items stay at `miniquad_voxel::hex::*`.
* `companions/voxel/src/lib.rs` gets one new line: `pub mod hex;`.
* Do not change `chunk.rs`, `world.rs`, `mesh.rs`, `terrain.rs`, `camera.rs`, `math.rs`, or the cubic tests.
* Reuse without change: `chunk::{Chunk, ChunkDims, VoxelId, AIR}`, `world::{World, ChunkCoord}`, `mesh::{MeshBuffers, Vertex}`.
* No `unsafe`, no I/O, no global state, no new dependency, no root `Cargo.toml` change.

### 1.2 Coordinates and axes

A cell is `HexCell { q, r, layer }`: axial `q`, axial `r`, and integer layer.
The orientation is **flat-top**. World axes are right-handed with `+Y` up, as in the cubic companion.

| Hex value | Chunk axis | `ChunkCoord` field | `Chunk::get` argument |
| --- | --- | --- | --- |
| `q` | width `W = dims.x` | `x` | `x` |
| `layer` | height `H = dims.y` | `y` | `y` |
| `r` | depth `D = dims.z` | `z` | `z` |

A chunk is an **axial rhombus**: `W × D` cells in `(q, r)`, `H` layers.
Chunk resolution uses Euclidean division on each axis:

```text
chunk.x = q.div_euclid(W)      local[0] = q.rem_euclid(W)
chunk.y = layer.div_euclid(H)  local[1] = layer.rem_euclid(H)
chunk.z = r.div_euclid(D)      local[2] = r.rem_euclid(D)
```

Example with `W = 8`: `q = -1` gives `chunk.x = -1`, `local[0] = 7`.
Because each axial neighbor delta is in `-1..=1` on each axis, this is the same rule as `World::is_solid`.
A lateral neighbor can be in a **diagonal** chunk, for example `(chunk.x + 1, chunk.z - 1)` from local `(W-1, r=0)`.

### 1.3 Coordinate bound

```rust
pub const HEX_COORD_MIN: i32 = -65_536;
pub const HEX_COORD_MAX: i32 = 65_535;
```

`q`, `r`, and `layer` must each be in `HEX_COORD_MIN..=HEX_COORD_MAX`.
Reason: the corner lattice values (section 1.5) stay below `2^18`. All are exact in `f32` (exact to `2^24`).
The `f32` step near the bound is at most `2^-6` world units. Geometry does not collapse at the bound.
A value outside the bound is an error. The code never wraps or saturates a coordinate.

### 1.4 Faces, order, neighbors, normals

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HexFace { PosQ, PosR, NegQPosR, NegQ, NegR, PosQNegR, Top, Bottom }
```

| Index | Face | `(dq, dr, dlayer)` | Opposite | Corners | Outward normal `[x, y, z]` |
| --- | --- | --- | --- | --- | --- |
| 0 | `PosQ` | `(+1, 0, 0)` | 3 `NegQ` | 0, 1 | `[S, 0, 0.5]` |
| 1 | `PosR` | `(0, +1, 0)` | 4 `NegR` | 1, 2 | `[0, 0, 1]` |
| 2 | `NegQPosR` | `(-1, +1, 0)` | 5 `PosQNegR` | 2, 3 | `[-S, 0, 0.5]` |
| 3 | `NegQ` | `(-1, 0, 0)` | 0 `PosQ` | 3, 4 | `[-S, 0, -0.5]` |
| 4 | `NegR` | `(0, -1, 0)` | 1 `PosR` | 4, 5 | `[0, 0, -1]` |
| 5 | `PosQNegR` | `(+1, -1, 0)` | 2 `NegQPosR` | 5, 0 | `[S, 0, -0.5]` |
| 6 | `Top` | `(0, 0, +1)` | 7 `Bottom` | top ring | `[0, 1, 0]` |
| 7 | `Bottom` | `(0, 0, -1)` | 6 `Top` | bottom ring | `[0, -1, 0]` |

`S = 0.866_025_4_f32` (`√3 / 2`). Side `k` points at angle `30° + 60°·k` in the `x`–`z` plane, where angle `θ` is the direction `(cos θ, 0, sin θ)`.
The side normal is the unit vector from the cell center to the neighbor center.
For a side, `opposite = (k + 3) % 6`.

### 1.5 World transform and canonical corners

```rust
pub const HEX_RADIUS: f32 = 1.0;        // center-to-corner distance
pub const HEX_LAYER_HEIGHT: f32 = 1.0;
pub const HEX_X_STEP: f32 = 0.5;        // HEX_RADIUS / 2
pub const HEX_Z_STEP: f32 = 0.866_025_4; // HEX_RADIUS * √3 / 2
```

The values are fixed. There is no runtime cell-size setting.
Corner `k` (`k = 0..6`) is at angle `60°·k`. Calculate it from integers only:

```text
KX = [ 2, 1, -1, -2, -1,  1]
KZ = [ 0, 1,  1,  0, -1, -1]
X  = 3*q + KX[k]           (i32, bounded)
Z  = 2*r + q + KZ[k]       (i32, bounded)
x  = (X as f32) * HEX_X_STEP
z  = (Z as f32) * HEX_Z_STEP
y  = (layer as f32) * HEX_LAYER_HEIGHT        bottom ring
y  = ((layer + 1) as f32) * HEX_LAYER_HEIGHT  top ring
center = ((3*q) as f32 * HEX_X_STEP,
          ((2*layer + 1) as f32) * (HEX_LAYER_HEIGHT * 0.5),
          ((2*r + q) as f32) * HEX_Z_STEP)
```

Adjacent cells give the same integer pair `(X, Z)` for a shared corner. Thus the `f32` values are bit-identical, and no crack can occur.
Do not calculate corners with `sin`, `cos`, or `center + offset`.
Mesh positions are **world space**. The hex example applies no per-chunk offset. (The cubic `append_mesh` offset does not apply.)

### 1.6 Triangles and winding

Front faces are counter-clockwise seen from outside, as in the cubic `face_corners` rule and `FrontFaceOrder::CounterClockwise`.
`b` is the base vertex index of the face. All indices are `u32` in `MeshBuffers.indices`.

| Face | Vertex order | Indices |
| --- | --- | --- |
| Side `k`, `j = (k+1)%6` | bottom `k`, top `k`, top `j`, bottom `j` | `b+[0,1,2, 0,2,3]` |
| `Top` | top ring `0, 5, 4, 3, 2, 1` | `b+[0,1,2, 0,2,3, 0,3,4, 0,4,5]` |
| `Bottom` | bottom ring `0, 1, 2, 3, 4, 5` | `b+[0,1,2, 0,2,3, 0,3,4, 0,4,5]` |

The top and bottom caps are 4-triangle fans from corner 0, with no center vertex.
One isolated prism gives 8 faces, **36 vertices, 60 indices, 20 triangles**.
A shared side has the same two corner positions in reverse order on the two cells.
Each vertex of a face has the face normal (flat normals) and the palette color.

### 1.7 Public items

```rust
use crate::chunk::{ChunkDims, VoxelId};
use crate::mesh::MeshBuffers;
use crate::world::{ChunkCoord, World};

pub const HEX_MAX_MESH_VERTICES: usize = 65_536; // u16 index range for WebGL1

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct HexCell { /* private: q: i32, r: i32, layer: i32 */ }

impl HexCell {
    pub fn new(q: i32, r: i32, layer: i32) -> Result<HexCell, HexError>;
    pub const fn q(self) -> i32;
    pub const fn r(self) -> i32;
    pub const fn layer(self) -> i32;
    pub fn neighbor(self, face: HexFace) -> Result<HexCell, HexError>;
    pub fn planar_distance(self, other: HexCell) -> u32;
    pub fn to_chunk_local(self, dims: ChunkDims) -> Result<(ChunkCoord, [u32; 3]), HexError>;
    pub fn from_chunk_local(chunk: ChunkCoord, local: [u32; 3], dims: ChunkDims)
        -> Result<HexCell, HexError>;
    pub fn center(self) -> [f32; 3];
    pub fn corners(self) -> [[f32; 3]; 12]; // 0..6 bottom ring, 6..12 top ring
}

impl HexFace {
    pub const ALL: [HexFace; 8];   // index order of section 1.4
    pub const SIDES: [HexFace; 6]; // indices 0..6
    pub const fn index(self) -> usize;
    pub const fn opposite(self) -> HexFace;
    pub const fn delta(self) -> (i32, i32, i32); // (dq, dr, dlayer)
    pub fn normal(self) -> [f32; 3];
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HexError { CoordinateOutOfRange, InvalidDims }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HexMeshError {
    ChunkNotResident,
    ChunkOutOfRange,
    UnknownMaterial(VoxelId),
    InvalidColor(VoxelId),
    MeshTooLarge { vertices: usize },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HexDirtyChunks { /* private: [ChunkCoord; 9], len */ }
impl HexDirtyChunks { pub fn as_slice(&self) -> &[ChunkCoord]; }

pub fn hex_dirty_chunks(cell: HexCell, dims: ChunkDims) -> Result<HexDirtyChunks, HexError>;

pub fn build_hex_chunk_mesh(
    world: &World,
    coord: ChunkCoord,
    palette: &[[f32; 4]],
    out: &mut MeshBuffers,
) -> Result<(), HexMeshError>;
```

`HexError` and `HexMeshError` implement `Display` and `std::error::Error`.

### 1.8 Rules for each item

* `HexCell::new`: returns `CoordinateOutOfRange` if a value is outside section 1.3.
* `neighbor`: uses `checked_add`, then the bound. At `HEX_COORD_MAX` with `+1`, or at `HEX_COORD_MIN` with `-1`, it returns `CoordinateOutOfRange`. It never panics.
* `planar_distance`: `(|dq| + |dr| + |dq + dr|) / 2` in `i64`. It ignores `layer`. The maximum value fits in `u32`.
* `to_chunk_local`: calls `dims.validate()`; on failure returns `InvalidDims`. Then section 1.2.
* `from_chunk_local`: `InvalidDims` as above. `local[i] >= dims` or a result outside the bound gives `CoordinateOutOfRange`. Calculate in `i64`.
* `hex_dirty_chunks`: returns the chunk of `cell` first. Then, for each face in `HexFace::ALL` order, the neighbor chunk if it is new. A neighbor outside the bound is skipped. The maximum length is 9 (`W = D = H = 1`). An interior cell gives exactly 1 chunk.
* `build_hex_chunk_mesh`:
  1. Clear `out`. On each error, `out` stays empty.
  2. `world.get(coord)` is `None`: `ChunkNotResident`.
  3. A cell of the chunk is outside the bound: `ChunkOutOfRange`. (Check the minimum and maximum cell of each axis in `i64`.)
  4. Pass 1: for each non-`AIR` cell, check the material. `id as usize >= palette.len()` gives `UnknownMaterial(id)`. A color component that is not finite or is outside `0.0..=1.0` gives `InvalidColor(id)`. Count visible faces with checked arithmetic.
  5. If the vertex count is more than `HEX_MAX_MESH_VERTICES`: `MeshTooLarge { vertices }`.
  6. Reserve the exact vertex and index counts. Pass 2 writes the faces.
* Cell order: `z` (r) outer, then `y` (layer), then `x` (q), as in the cubic mesher. Face order: `HexFace::ALL`.
* A face is visible if the neighbor is not solid. A neighbor is **not solid** if its chunk is not resident (same rule as the cubic mesher), or if `neighbor()` returns an error.
  When a neighbor chunk becomes resident, the application rebuilds the chunks from `hex_dirty_chunks` or the adjacent chunks.
* A successful mesh has fewer than `65_537` vertices. Thus each index fits in `u16`. The example converts with `u16::try_from` and handles the error path without `expect`.
  If the example joins two chunk meshes into one buffer, it must check the total count against `HEX_MAX_MESH_VERTICES` first.

### 1.9 Required geometry tests

Use the test list in #130. Add these exact checks:

* For each side `k`, `normal(k)` is within `1e-5` of the normalized `center(neighbor) - center(cell)` in `x`–`z`.
* For each face triangle, `(v1 - v0) × (v2 - v0) · normal > 0`.
* For `PosQ` of cell `A` and `NegQ` of `A.neighbor(PosQ)`: the two bottom corners are bit-equal and in reverse order. Repeat for one cell at negative coordinates and one cell near the bound.
* Cross-chunk tests at `q = 0`, `q = W-1`, `r = 0`, `r = D-1`, and the diagonal corner (local `(W-1, *, 0)` with neighbor chunk `(x+1, *, z-1)`), with the neighbor chunk resident and not resident.
* Dirty sets: interior cell gives 1 chunk. Edge and corner cells give the exact ordered list.


### 1.10 Mapping to 2D screen space

A future 2D adapter uses the same axial cells and the same corner lattice. It does not define a second topology.
Map world `(x, z)` to 2D Y-down `(u, v)` as `u = x`, `v = z` (a view from `+Y` with screen up `-Z`).
In 2D the cell is flat-top, and corner `k` is at `60°·k` clockwise from `+u`.
The 2D cell size can scale `(u, v)` uniformly. Pointy-top 2D is a 30° rotation of the drawing only. It is not a 3D option in this contract.

## 2. Picking contract (#131)

Location: `companions/voxel/src/hex_pick.rs`, public path `miniquad_voxel::hex_pick`, one `pub mod hex_pick;` line in `lib.rs`. Owner: the #131 work.
It uses only the public items of section 1.7 and `camera::OrbitCamera`. Pure Rust, no `unsafe`, no I/O. All picking math is `f64`.

### 2.1 Public items

```rust
use crate::camera::OrbitCamera;
use crate::hex::{HexCell, HexError, HexFace};
use crate::world::World;

pub const HEX_PICK_MAX_STEPS: u32 = 4_096;
pub const HEX_PICK_MAX_VIEWPORT: f64 = 16_384.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HexRay { pub origin: [f64; 3], pub dir: [f64; 3] } // dir has unit length

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HexPickParams { pub max_distance: f64, pub max_steps: u32, pub min_layer: i32, pub max_layer: i32 }

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HexHit { pub cell: HexCell, pub face: Option<HexFace>, pub distance: f64 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HexPickError { InvalidViewport, InvalidPixel, InvalidCamera, InvalidParams }

pub fn ray_from_pixel(camera: &OrbitCamera, pixel: [f64; 2], viewport: [f64; 2])
    -> Result<HexRay, HexPickError>;
pub fn hex_cell_at_xz(x: f64, z: f64, layer: i32) -> Result<HexCell, HexError>;
pub fn pick_hex(world: &World, ray: &HexRay, params: &HexPickParams)
    -> Result<Option<HexHit>, HexPickError>;
```

`HexPickError` implements `Display` and `std::error::Error`.

### 2.2 Pixel to ray

* `pixel` and `viewport` use the same unit: backing-store pixels (`offsetX × devicePixelRatio`). A probe at a pixel center uses `i + 0.5`.
* `viewport` values must be finite, `> 0`, and `<= HEX_PICK_MAX_VIEWPORT`: else `InvalidViewport`. `pixel` must be finite and in `0..=viewport`: else `InvalidPixel`.
* `ndc_x = 2·px/w − 1`, `ndc_y = 1 − 2·py/h`, `aspect = w/h`, `t = tan(22.5°)` (the 45° field of view in `camera.rs`).
* Eye: the `camera.rs` formula `target + distance·(cos p·sin y, sin p, cos p·cos y)`. Forward `f = normalize(target − eye)`, right `s = normalize(f × +Y)`, up `u = s × f`.
* `dir = normalize(f + ndc_x·t·aspect·s + ndc_y·t·u)`, `origin = eye`. A non-finite or zero-length value gives `InvalidCamera`.
* Device pixel ratio 1 and 2 give the same ray, because both values scale by the same power of two.
* Test: project a world point with `projection_matrix(aspect).mul(&view_matrix())`. Convert to a pixel. The ray from that pixel passes within `1e-4` of the point.

### 2.3 Point to cell (tie rule A)

`hex_cell_at_xz` returns the cell whose center is nearest to `(x, z)`.
Hex cells are the nearest-center regions of the center lattice, so this is exact inside a cell.
Calculate fractional axial values, round to a candidate, then compare the candidate and its 6 neighbors by squared distance.
Use the analytic lattice in `f64`: center `(1.5·q, (2·r+q)·√3/2)`.
Do not use the rounded `f32` mesh centers or normals for this calculation or the walk.
Mesh rounding must not change an analytic edge or vertex tie.
**Tie rule A:** at equal distance (a point on an edge or a vertex), select the smallest `(q, r)` in lexicographic order.
A non-finite input or a cell outside the bound gives `CoordinateOutOfRange`.

### 2.4 Bounded walk (tie rule B)

1. Check `params`: `max_distance` finite and `> 0`; `max_steps` in `1..=HEX_PICK_MAX_STEPS`; `min_layer <= max_layer`, both in the bound. Else `InvalidParams`. Check `ray`: finite, `|dir| = 1 ± 1e-9`. Else `InvalidParams`.
2. Clip the ray to the slab `y ∈ [min_layer·h, (max_layer+1)·h]` and to `[0, max_distance]`. No interval: `Ok(None)`. A horizontal ray outside the slab: `Ok(None)`. A horizontal ray inside the slab continues; it can hit a side face.
3. Start cell: tie rule A at the clipped entry point. First entry face: `Top` if the ray entered through the slab top, `Bottom` through the slab bottom, `None` if the origin is in the slab.
4. In each column, the exit is the side `k` with the smallest `t_k = (a − (o − c)·n_k) / (d·n_k)` for `d·n_k > 0`, where `o` is the ray origin, `c` the column center in `x`–`z`, and `a = √3/2` the apothem.
   **Tie rule B:** at equal `t_k` (an edge or vertex crossing), select the lowest face index. The next column is `neighbor(k)` and its entry face is `opposite(k)`.
   Three cells meet at a vertex. A cycle is not possible, because each step crosses a side with `d·n_k > 0`.
5. In a column with interval `[t_in, t_out]`, visit the layers from `y(t_in)` to `y(t_out)` in ray order. On an exact layer boundary, use the layer that the ray moves into (`floor` for `dy >= 0`, `ceil − 1` for `dy < 0`). The second and later layers in a column have entry face `Top` (`dy < 0`) or `Bottom` (`dy > 0`).
6. Each visited cell is one step. The first solid cell gives `Some(HexHit { cell, face, distance: t })`. A cell in a missing chunk is air. A neighbor outside the bound, `t > max_distance`, or `max_steps` reached gives `Ok(None)`.

A ray with `dx = dz = 0` stays in the start column. A ray in the plane of a side stays deterministic by rule B.

### 2.5 Required picking tests

Center of a top face; a point `0.01` inside each of the 6 edges; one vertex (rule A result asserted); across the chunk seam; negative `q` and `r`; a side-face hit; a horizontal ray above the terrain (no hit); a ray out of range (no hit); `max_steps = 1` (no hit beyond the first cell); repeat each case 3 times with equal results.

## 3. Browser example contract (#131)

### 3.1 Scene `offline_hex`

* File `companions/voxel/examples/offline_hex.rs` and one `[[example]]` entry in `companions/voxel/Cargo.toml`. The cubic `offline` example does not change.
* Fixed seed `20261111`. `ChunkDims::new(8, 4, 8)`. Two resident chunks: `ChunkCoord::new(-1, 0, 0)` and `ChunkCoord::new(0, 0, 0)`. Column height from `terrain::column_height(seed, q, r, 1, 3)`. Same `terrain::PALETTE`. Opaque terrain, vertex colors, flat normals.
* One mesh per chunk with `build_hex_chunk_mesh`. Convert indices with `u16::try_from`. An error sets the status to `error` and draws no terrain. No `expect` on these paths.
* Frame order of MADR 0008: clear, terrain (depth test and write, back-face cull, counter-clockwise front), world-space sprite (depth test, no depth write, alpha blend), then HUD.
* Camera: `OrbitCamera` with fixed start values recorded in the guide `docs/offline-hex-voxel.md`.
* No network request for gameplay.

### 3.2 HUD and HTML status

* Use the shared cubic HUD code when the integrator supplies it. Do not write a second HUD framework. Until then, draw no GPU HUD and use the HTML status only.
* HUD cells: mode `LOC`, the status chip, and the revision. Same glyphs, black at alpha 0.85, `#F2F2F2` glyphs, green/amber/red chips. Revision above `999999` shows `rEEEEEE`.
* New hex semantic needs: none in the seven-segment cells. The topology and the picked cell are in HTML only.
* HTML: a `<section aria-label="Hex voxel scene">` with `role="status"` and `aria-live="polite"` text: `Topology: hexagonal prism`, `Mode: offline`, `Revision: <full u32>`, `Picked: q=<q> r=<r> layer=<layer> face=<name>` or `Picked: none`. Buttons: `Place column`, `Release`. Each control has a visible label and works with the keyboard.

### 3.3 Probes and release

* Probes only in this example, with the cubic bounded export rules and atomics. No export stores a pointer to `Stage`: `hex_probe_pick(px_bits: u32, py_bits: u32) -> i32` (`f32` bits of a backing-store pixel; `0` hit, `1` no hit, `2` invalid input), `hex_probe_picked_valid() -> u32`, `hex_probe_picked_q() -> i32`, `hex_probe_picked_r() -> i32`, `hex_probe_picked_layer() -> i32`, `hex_probe_picked_face() -> u32` (face index, `8` for none), `hex_probe_triangles() -> u32`, `resources_live() -> u32`.
  If the integrator supplies a shared probe or release interface first, use it in place of these names.
* Release: one atomic release request, then the next `draw` deletes all GPU objects, then `resources_live() == 0`. A paused host resumes the loop until the release completes, then disposes the frame.

### 3.4 Browser tests

* Private port `4290`. Separate WebGL1 and WebGL2 runs. Assert the context type in each run.
* Silhouette: project a top hexagon edge midpoint and one vertex with the camera matrices. Sample at `±2` backing-store pixels along the screen normal. Inside: terrain color within tolerance. Outside: clear color.
* Seam: sample points on the projected chunk seam (`q = −1 | 0`). Expect terrain color, no clear-color gap, and no extra side face color.
* Picking: a synthetic pointer event at a projected cell-top center gives that cell and face `Top` through the probe.
* DPR 1 and 2: assert the backing store is `css × dpr`. Repeat silhouette and picking. The picked cell is equal.
* Occlusion: the sprite center has the sprite tint. After `Place column` on the cell between camera and sprite, the same pixel has terrain color.
* Release: three mount and release cycles. After each, `resources_live() == 0` and the real GL objects are deleted (count `create*`/`delete*` calls). WASM linear memory does not grow after cycle 1.
* Downstream: a fresh crate under `tests/` depends on `miniquad-voxel` by path, uses only `hex` and `hex_pick` public items, and builds for native and `wasm32-unknown-unknown`.
* Measurement: cubic and hex runs use equal browser, device, canvas, DPR, seed, and cell count. Record costs and variance only. The images differ, so make no equal-image or optimization claim. Record GPU and native timing as `null` when not measurable.
* Record the browser, version, and OS. The host is a shared Mac. Desktop WebKit does not prove iOS Safari.
