# MADR 0011: Add optional hexagonal-prism voxels beside cubic voxels

* Status: **Proposed** (requires implementation and test evidence before acceptance)
* Date: 2026-11-11
* Tracking: [#130](https://github.com/Tigon32/miniquad/issues/130), [#131](https://github.com/Tigon32/miniquad/issues/131), [#132](https://github.com/Tigon32/miniquad/issues/132); related [#29](https://github.com/Tigon32/miniquad/issues/29)
* Scope: optional voxel companion `companions/voxel/` only; no change to the Miniquad core, ABI v3, or the root `Cargo.toml`
* Related: [MADR 0008](0008-optional-voxel-topologies.md)
* Contract: [hexagonal-prism voxel contract](../hex-voxel-contract.md)
* Writing review: **STE-aligned draft**. Full ASD-STE100 dictionary review not done.

## Context

The voxel companion has only cubic voxels. The owner asks for optional hexagonal-prism voxels.
A hexagonal-prism voxel is a flat hexagon cell with one integer layer height.
Cubic voxels stay the default. Hex work must not block or change #29 or VXP1.
The external project `ForlornU/VoxelsBeta` at `1f852c4214ba211cece444c5b423e43bebf8acf1` (MIT, Godot 4.5, GDScript) is a design reference only. We do not copy or port its code or text. #130 records what we read from it.

## Decision drivers

1. Small, pure Rust, no new dependency, no `unsafe`, no I/O.
2. Reuse the cubic `Chunk`, `ChunkDims`, `World`, `ChunkCoord`, `MeshBuffers`, and `Vertex` without a change.
3. Exact integer rules for neighbors, chunks, and shared corners. No crack at a cell or chunk seam.
4. Checked limits. An error, not a panic, at each limit.

## Options and decisions

| Topic | Options | Decision | Reason |
| --- | --- | --- | --- |
| Coordinates | axial `(q, r)` + layer; cube `(q, r, s)`; odd-q/even-q offset; doubled | **Axial + integer layer** | Each neighbor delta is in `-1..=1` per axis and is the same for each cell. Cube adds a redundant value. Offset needs parity tables. Doubled wastes half the index space. |
| Orientation | flat-top; pointy-top | **Flat-top** | The `q` axis maps to world `+X`, the same direction as cubic `x`. Both are correct. We select one and freeze it. |
| Chunk shape | axial rhombus; offset rectangle; hexagonal area | **Axial rhombus `W × H × D`** | It maps one-to-one to `ChunkDims` and the dense `Chunk` index. Euclidean division on each axis gives the chunk. A rectangle needs parity. A hex area does not tile with simple chunk coordinates. |
| Storage | dense array; sparse map | **Dense `Chunk`** | Same bounds as cubic (`MAX_CHUNK_DIM`, `MAX_CHUNK_VOLUME`). Resident chunks stay in the cubic `World` map. |
| Integration | separate `hex` module; topology parameter on cubic types | **Separate `miniquad_voxel::hex`** | Cubic types and tests stay source-compatible. A topology parameter changes each cubic signature. |
| Meshing | visible faces; greedy merge | **Visible faces only** | Hexagon tops cannot merge into rectangles. Side merges need extra rules and give T-junctions. The `block-mesh` method is cubic only. |
| Cap triangulation | center fan (7 vertices); corner fan (6 vertices) | **Corner fan from corner 0** | A hexagon is convex. 36 vertices and 20 triangles for one prism, against 38 and 24. |
| Corner positions | `center + radius·(cos, sin)`; integer lattice | **Integer lattice, then one `f32` multiply** | Adjacent cells get bit-identical corners. Trigonometric sums can differ in the last bit. |
| Mesh space | chunk-local plus offset; world space | **World space, bounded coordinates** | No per-chunk offset. Coordinates are bounded to `-65_536..=65_535`, so lattice values are exact in `f32`. |
| Missing neighbor | solid; not solid | **Not solid (face visible)** | Same as the cubic mesher. The application rebuilds affected chunks when a neighbor chunk becomes resident. |
| Index limit | none; `u16` limit | **Error above 65 536 vertices** | WebGL1 needs `u16` indices. The mesher counts before it allocates. |

The exact types, signatures, face order, corner table, winding, and errors are in section 1 of the [contract](../hex-voxel-contract.md).

## Effects

* Good: one new module and one line in `lib.rs`. Cubic behavior and the dependency graph do not change.
* Good: diagonal-chunk neighbors (`(x+1, z-1)` and `(x-1, z+1)`) use the existing per-axis rule.
* Bad: the fixed cell size and layer height cannot change at runtime. A future change needs a revision.
* Bad: no greedy meshing, no texture atlas, no transparent hex materials, no smooth normals.
* Bad: hex and cubic images are different geometry. A cost comparison cannot claim equal images.

## Evidence status

No hex implementation, test run, or browser run exists for this decision.
The decision stays **Proposed** until the #130 tests pass with recorded commands.
