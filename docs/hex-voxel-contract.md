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

## 2. Picking and browser contract (#131)

Status: in work. A separate commit adds this section.
Reserved location: `companions/voxel/src/hex_pick.rs` (public path `miniquad_voxel::hex_pick`), owned by the #131 work.
The picker uses only public items from section 1.7.
