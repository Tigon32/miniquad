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
| Picking | physics collider; nearest center from a random start; analytic walk | **Analytic bounded walk through prisms** | Miniquad has no physics. A random start is not deterministic. The walk has a step limit and two written tie rules. |
| 2D hexagons | separate 2D topology; projection of the same cells | **Same cells, `u = x`, `v = z` (Y-down)** | One topology for 2D and 3D adapters. Pointy-top is a 2D drawing rotation only. |
| HUD | new hex HUD; shared cubic HUD | **Shared cubic HUD, HTML for hex data** | No second HUD framework. The seven-segment cells need no new hex values. |

The exact types, signatures, face order, corner table, winding, and errors are in section 1 of the [contract](../hex-voxel-contract.md).
The picking rules are in section 2. The browser example and its tests are in section 3.

## Effects

* Good: one new module and one line in `lib.rs`. Cubic behavior and the dependency graph do not change.
* Good: diagonal-chunk neighbors (`(x+1, z-1)` and `(x-1, z+1)`) use the existing per-axis rule.
* Bad: the fixed cell size and layer height cannot change at runtime. A future change needs a revision.
* Bad: no greedy meshing, no texture atlas, no transparent hex materials, no smooth normals.
* Bad: hex and cubic images are different geometry. A cost comparison cannot claim equal images.

## Deferred decision: mixed mode for hex worlds (#132)

Status: **not decided**. Do not start before both gates pass:

1. The VXP1 mixed-mode slice for #29 passes its own tests.
2. This MADR's coordinate rules are implemented and the #130 tests pass.

| Option | Detection of a wrong peer | Notes |
| --- | --- | --- |
| New protocol version with a topology field in `Hello` and `Snapshot` | Explicit `Version` error from a VXP1 peer | Highest change cost. Clear compatibility table. |
| Topology bit in reserved `flags` | VXP1 peers reject non-zero `flags` | Small change. Uses the reserved field for a meaning, not an extension. |
| Topology implied by `world_id` | None. A peer cannot detect a mismatch | Rejected: a cubic client can draw hex bytes as cubes with no error. |
| Offline hex only | Not applicable | Valid only as a recorded decision with evidence. Do not select it only to close #132. |

Record the selection in a new MADR or a revision, with codec and parity evidence. Until then, hex is offline only, and VXP1 does not change.

## Evidence status

The pure geometry implementation exists at `0d03cebea542314f4312ed21de912a60dc626fe0`.
The #130 integration adds checks for all six shared sides, every lateral chunk
boundary, the emitted triangle winding, and the exact 84 exterior faces of a
solid 3x3x3 block.
On macOS arm64, `cargo test --manifest-path companions/voxel/Cargo.toml` passed
67 tests. The companion WASM check and the 10 root library tests also passed.
The PR records the exact source revision and full commands.
No browser or network result is claimed here. The decision stays **Proposed**.
