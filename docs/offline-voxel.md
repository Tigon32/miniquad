# Offline voxel companion: a bounded WASM-only vertical slice

* Date: 2026-11-11
* Scope: `companions/voxel/` (the `miniquad-voxel` crate) and this guide
* Related issue: [#29](https://github.com/Tigon32/miniquad/issues/29)
* Related decision: MADR 0008 — "Keep optional voxel simulation outside Miniquad core" (`docs/adr/0008-optional-voxel-topologies.md`, status **Proposed**)
* Adoption boundary reference: MADR 0009 — "Keep browser adoption tools outside the core library" (`docs/adr/0009-optional-browser-adoption-layer.md`, status **Proposed**). Read at commit `87e8e50` on another branch; not re-linked as an accepted decision here.
* Source reviewed: `Tigon32/miniquad`, branch `feat/offline-voxel`, built on `454792c46febefc476e1df153a5efed8bbb2ef79`
* Writing review: **STE-aligned draft**. Full dictionary review not done.

## Problem

Issue #29 asks for a small, optional voxel capability with two possible
execution modes (WASM-only offline, and mixed WASM + server-side
execution), plus mixed 2D/3D rendering in one frame. MADR 0008 selects
**mode A (WASM-only, offline-first)** as the first prototype, kept
outside the Miniquad core crate. This guide and the `miniquad-voxel`
crate implement one bounded vertical slice of mode A only. **Mode B
(mixed WASM + server-side execution) is not implemented and remains
open.** This work does not close issue #29.

## Ownership and package boundary

`companions/voxel/` is a **standalone Rust crate** (`miniquad-voxel`).
It declares its own empty `[workspace]` table, so it is never pulled
into the root `miniquad` crate's build even if that crate later gains a
workspace. It is not a Cargo workspace member of the root crate, and
the root `Cargo.toml` is not changed. It depends on `miniquad` by path
(`../../`), the same way an external application would depend on a
published `miniquad` version. It adds **no other dependency**: it does
not use `glam` (already an approved root `dev-dependency`, but not
needed here); it implements its own tiny `Vec3`/`Mat4` math in
`src/math.rs` instead. The core dependency graph (the root crate's
`Cargo.toml` and `Cargo.lock`) is unchanged by this package.

This matches the resource-ownership intent of MADR 0009's table, even
though that MADR's scope is browser-adoption tooling, not voxel work:
the optional package owns its own GPU resources, with explicit package
teardown, not an addition to the core ABI.

## What this slice implements (and what it does not)

Implemented:

- A bounded, dense voxel [`chunk`](../companions/voxel/src/chunk.rs)
  grid with checked dimension and volume limits.
- A bounded grid of resident [`chunk`s](../companions/voxel/src/world.rs)
  (`World`), with a chunk-boundary-aware solidity query.
- Visible-face [`mesh`](../companions/voxel/src/mesh.rs)ing with
  neighbor-chunk face culling, into reusable, growable buffers.
- A deterministic seeded [`terrain`](../companions/voxel/src/terrain.rs)
  generator and a 3-material demo palette.
- A pure [`camera`](../companions/voxel/src/camera.rs) (orbit, arrow
  keys and mouse drag).
- The `offline` example: one small bounded terrain scene, a perspective
  camera with depth test/write, and one moving/animated world-space 2D
  sprite, in one Miniquad/WebGL frame. No network request.
- An optional, bounded "app parameters" export surface matching the
  `miniquad-starter` browser template's contract (speed and two
  colors), so a parent host page can reuse one `setParameters` call
  shape across example applications.

Explicitly **not** implemented in this slice (left to later issue #29
work, per MADR 0008's open questions and acceptance criteria):

- Mode B (server-side execution), any network transport, protocol
  versioning, reconnection, or resync.
- Voxel edits (chunk mutation after generation), dirty-chunk tracking,
  or cache eviction under load (the `World::evict` function exists and
  is unit-tested, but the example never calls it).
- A screen-space HUD. The HTML HUD is expected to live in the
  **external parent embedding host**, per the issue #29 adoption
  sequence and MADR 0009's embedding-host/runtime-frame boundary. This
  crate draws no 2D orthographic overlay.
- Transparent-material ordering beyond the single opaque terrain +
  single alpha-blended sprite case; a scene with several transparent
  layers needs an explicit sorting policy this slice does not need.
- Greedy meshing (merging coplanar faces). Only per-voxel visible-face
  culling is implemented; this bounds face count but does not minimize
  triangle count.
- A measured benchmark. This guide and its code are a vertical slice
  with passing unit tests and two successful compiles (native debug,
  `wasm32-unknown-unknown` release); they are **not** a performance
  measurement. See `.github/skills/miniquad-performance-proof/` before
  claiming a frame-time or memory number.

## Domain and resource contracts

Implementing MADR 0008's "Domain and resource contracts" section for
this slice:

| Contract | Implementation |
| --- | --- |
| Bound chunk dimensions before allocating | `ChunkDims::validate` rejects a zero axis, an axis over `MAX_CHUNK_DIM` (64), and an overflowed or over-`MAX_CHUNK_VOLUME` (64³) volume, before `Chunk::new` allocates its `Vec`. Overflow uses checked `u64` arithmetic so a crafted huge input cannot reach undefined behavior on a 32-bit target such as `wasm32-unknown-unknown`. |
| Bound resident-chunk count before allocating | `World::new` rejects `max_resident_chunks == 0`. `World::insert` rejects adding a *new* chunk coordinate once the configured limit is reached (replacing an already-resident coordinate is still permitted). |
| Only generate visible faces; verify chunk-boundary faces | `mesh::build_chunk_mesh` emits a face only when the neighbor voxel (in this chunk, or in a resident neighbor chunk) is not solid. See "Chunk-boundary policy" below for the explicit choice when a neighbor chunk is not resident. |
| Release CPU/GPU references on eviction | `World::evict` removes and returns the chunk, dropping the `World`'s own reference; the CPU `Vec<VoxelId>` allocation is freed when the caller drops the returned `Chunk`. The `offline` example does not evict chunks (static scene), so this path is unit-tested but not exercised by the example; GPU mesh buffers belong to the example, not this crate (see "GPU resource ownership" below). |
| Pure simulation module reusable native/WASM | `chunk`, `world`, `mesh`, `terrain`, `camera`, and `math` contain no `miniquad::RenderingBackend` calls and no platform-specific code; only `examples/offline.rs` touches the GPU. Both `cargo test --lib` (native) and `cargo build --release --target wasm32-unknown-unknown --example offline` compile from the same source. |
| Deterministic seed/time for tests | `terrain::column_height` and `terrain::generate_chunk` use a pure integer hash of `(seed, x, z)` with no system time or RNG; the `offline` example uses a fixed `WORLD_SEED` constant. Tests assert the same seed produces identical output across two calls. |

### Chunk-boundary policy

When `mesh::build_chunk_mesh` needs to resolve a voxel one step outside
the chunk being meshed, it asks `World::is_solid`, which looks up the
neighbor chunk coordinate. **If that neighbor chunk is not resident,
the voxel is treated as not solid**, so the boundary face stays
visible. This is a conservative choice: it never hides a face behind an
unloaded neighbor, at the cost of a few extra triangles at the edge of
the loaded world. `mesh::tests::resident_neighbor_chunk_culls_boundary_face`
and `mesh::tests::missing_neighbor_chunk_leaves_boundary_face_visible`
cover both sides of this policy.

### GPU resource ownership

| Resource | Owner | Release action |
| --- | --- | --- |
| Voxel/world/mesh CPU data (`Chunk`, `World`, `MeshBuffers`) | `miniquad-voxel` crate types, owned by the example's `Stage` | Dropped with `Stage`; `World::evict` is the explicit mid-run release path (unit-tested, not exercised by the example) |
| Terrain GPU vertex/index buffers, pipeline | `offline` example `Stage` | Not explicitly destroyed in this slice; released when the process/context ends. A longer-lived host integration (issue #124-style) would need explicit `RenderingBackend::delete_buffer`/pipeline teardown, matching MADR 0009's resource-ownership table; this vertical slice does not implement remount/dispose. |
| Sprite GPU vertex/index buffers, pipeline | `offline` example `Stage` | Same as above |
| Mesh CPU buffers (`MeshBuffers`) | Built once at `Stage::new` into one combined terrain buffer | Not rebuilt per frame; the sprite moves through a uniform transform only, so **no mesh buffer is reallocated or rewritten per frame** |

## Frame composition

The `offline` example follows MADR 0008's frame-composition order,
limited to the parts this slice implements:

1. Clear the color and depth buffer (`PassAction::Clear`).
2. Draw the opaque 3D voxel terrain: perspective camera, `depth_test:
   LessOrEqual`, `depth_write: true`, back-face culling, one
   `view_projection` uniform.
3. Draw the world-space 2D sprite: `depth_test: LessOrEqual` (terrain
   in front still occludes it), **`depth_write: false`** (so the
   sprite never blocks terrain drawn in the same frame), straight-alpha
   blending enabled (`BlendFactor::Value(SourceAlpha)` /
   `OneMinusValue(SourceAlpha)`). Drawn after the opaque terrain.
4. The screen-space 2D HUD step from MADR 0008 is **not drawn by this
   crate**; it is explicitly left to the external embedding host (step
   5, below).
5. State restore, resize, and context-loss handling: `resize_event`
   updates the stored aspect ratio; this slice does not implement
   explicit context-loss recovery (no remount path), which is an open
   item shared with MADR 0009's runtime-frame contract.

## Camera and sprite

- `camera::OrbitCamera` orbits a fixed target at a fixed distance.
  Arrow keys step yaw/pitch (`Left`/`Right` = yaw, `Up`/`Down` =
  pitch); dragging with the left mouse button rotates by the drag
  delta. Both input paths call the same clamped `rotate` method, so
  pitch cannot exceed `±1.5` radians from either path.
- The moving 2D sprite demonstrates both "animated height" and "moving
  sprite" from the issue #29 adoption sequence with one object: it
  circles the gap between the two demo chunks (`cos`/`sin` of elapsed
  time) while bobbing vertically (`sin` of elapsed time at a different
  rate). Its speed is scaled by the `mq_param_set_f32(1, speed)`
  parameter (see below).

## Optional app-parameters export surface

`examples/offline.rs` exposes the same small, optional surface as
`templates/browser/rust/src/main.rs` in the `miniquad-starter`
companion, so a parent host page can reuse one `setParameters` contract
across example applications without new core ABI additions:

- `mq_params_version() -> u32`: always `1`.
- `mq_param_set_f32(1, value) -> i32`: sprite animation speed, range
  `0..=2`. Returns `0` on success, `1` for a non-finite or
  out-of-range value, `2` for an unknown `id`.
- `mq_param_set_rgba8(1, color) -> i32`: sprite tint.
- `mq_param_set_rgba8(2, color) -> i32`: background clear color.
  Returns `0` on success, `2` for an unknown `id`.

`color` is `0xRRGGBBAA`, straight alpha, sRGB channel bytes. State is
held in `AtomicU32` statics with `Ordering::Relaxed`, matching the
starter's pattern; this does not change the Miniquad core ABI.

## WebGL1 / native GL scope

Shaders are written once, as `#version 100` GLSL, for both the
`wasm32-unknown-unknown` WebGL backend and the native `Backend::OpenGl`
desktop backend — the same pattern as `templates/browser/rust/src/main.rs`.
**No Metal shader source is supplied.** If `ctx.info().backend` ever
reports `Backend::Metal` (for example, a future default-backend
change), the example calls `panic!` with an explicit message rather
than silently failing. This repository does not claim a tested native
runtime for this example: native compilation was checked
(`cargo build --example offline`, exit code 0, this machine, macOS,
`Backend::OpenGl`), but the example's on-screen output was **not**
visually verified outside a browser. The compiled WASM output is the
artifact intended for browser pixel/frame testing by the parent
integration.

## Tests

`companions/voxel/src/*.rs` contain 32 unit tests covering:

- Small cases: an empty chunk mesh, a single solid voxel (6 faces).
- Adjacent-voxel and chunk-boundary culling: two adjacent voxels inside
  one chunk (10 visible faces); two adjacent chunks with a resident
  neighbor (boundary face culled) and without one (boundary face
  stays visible).
- Oversized input: a chunk dimension over `MAX_CHUNK_DIM`, an
  overflow-safe volume check for `u32::MAX`-sized dimensions, a world
  configured with zero `max_resident_chunks`, and inserting past
  `max_resident_chunks`.
- Determinism: the same `(seed, x, z)` produces the same column height
  and the same generated chunk across two calls.
- Reused mesh buffers: building into the same `MeshBuffers` twice
  reuses (does not shrink) its `Vec` capacity.

## Commands run and results

All commands below were run from `companions/voxel/` (or with
`--manifest-path companions/voxel/Cargo.toml`), on this machine
(macOS), against source `454792c46febefc476e1df153a5efed8bbb2ef79` plus
the changes in this slice.

| Command | Result |
| --- | --- |
| `cargo fmt` | Ran; no diff produced (already formatted) |
| `cargo test` | **Passed** — 32 unit tests, 0 failed; 0 doc-tests |
| `cargo build --example offline` (native, dev profile) | **Passed** — compiles under `Backend::OpenGl`; not run/screenshotted |
| `cargo build --release --target wasm32-unknown-unknown --manifest-path companions/voxel/Cargo.toml --example offline` | **Passed** — compiles to WASM; not yet pixel-tested in a browser by this change |

No browser run, pixel comparison, or frame-timing measurement is
included in this slice. That evidence is expected from the parent
integration's browser harness, per the task handoff for this work.

## Risks and open items

- **Mode B is not implemented.** This slice only satisfies the
  WASM-only half of MADR 0008's vertical-slice acceptance criteria.
  Issue #29 must stay open until mode B (or a documented decision to
  drop it) is addressed.
- **No context-loss or teardown path.** Unlike the `miniquad-draw`
  companion's `Renderer::destroy`, this example does not implement
  explicit GPU resource teardown or a remount contract. A future
  integration through the browser-adoption layer (issue #124) needs
  this before the example can be safely mounted/unmounted repeatedly.
- **No HUD in this crate.** The "screen-space 2D HUD" frame step from
  MADR 0008 is intentionally deferred to the external embedding host;
  this example draws nothing in that role. A future slice should link
  a concrete HUD host page once one exists.
- **Flat per-voxel face shading only**, no texture atlas, no greedy
  meshing, no transparency sorting beyond one sprite. These are
  explicitly out of scope per "What this slice implements" above.
- **No performance evidence.** Triangle counts and buffer sizes are
  small by construction (two 8×12×8 chunks), but no frame-time, memory,
  or WASM/JS byte measurement was taken. Do not cite this slice as a
  performance baseline.
- **Native example compiles but was not run.** Only the
  `wasm32-unknown-unknown` build is the intended target for this
  slice's browser-pixel verification; the native build was checked for
  compile success only, on this machine, as a secondary confidence
  check.

This guide does not claim issue #29 is complete. MADR 0008 remains
**Proposed**.
