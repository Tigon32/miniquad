//! `miniquad-voxel`: an optional, bounded offline voxel terrain and
//! visible-face meshing companion for Miniquad.
//!
//! This crate is **not** part of the Miniquad core crate and is not a
//! workspace member of it. It is a standalone package that depends on
//! `miniquad` the same way an application would. See
//! `docs/offline-voxel.md` for the full guide: domain and resource
//! contracts (bounded chunk dimensions, bounded resident-chunk count,
//! chunk-boundary face culling), frame composition, and the relation
//! to MADR 0008 ("Keep optional voxel simulation outside Miniquad
//! core", proposed, tracking issue #29).
//!
//! # Layout
//!
//! - [`math`]: a tiny pure vector/matrix module (no external math
//!   dependency).
//! - [`chunk`]: [`chunk::Chunk`], a bounded dense voxel grid with
//!   explicit, checked dimension and volume limits.
//! - [`world`]: [`world::World`], a bounded grid of resident chunks
//!   with a chunk-boundary-aware solidity query.
//! - [`mesh`]: [`mesh::build_chunk_mesh`], visible-face meshing with
//!   neighbor-chunk face culling, into reusable [`mesh::MeshBuffers`].
//! - [`terrain`]: a small deterministic seeded terrain generator and
//!   demo material palette. Not a general noise library.
//! - [`camera`]: [`camera::OrbitCamera`], a pure orbit camera driven by
//!   arrow-key and mouse-drag deltas.
//! - [`sim`]: [`sim::Sim`], the shared pure simulation core (world,
//!   seed, speed, revision) used by the native server and by WASM, in
//!   both offline and mixed-mode builds. See
//!   `docs/architecture/voxel-protocol.md`.
//! - [`protocol`]: the bounded `VXP1` wire codec used only by the
//!   mixed-mode server and client. No codec function panics; every
//!   length is checked before it is read or allocated.
//! - [`hud`]: the pure seven-segment glyph table and panel/cell
//!   geometry math for the mixed-mode in-frame HUD. No GPU code.
//!
//! This crate has **no GPU code** outside its examples. `miniquad` is
//! a **dev-dependency** here: the `offline` and `mixed` examples are
//! the only parts of this companion that touch
//! `miniquad::RenderingBackend`, matching the pattern in
//! `companions/draw/src/gpu.rs`. The `sim` and `protocol` modules, and
//! the `vx-server` binary, depend on nothing but `std`.

pub mod camera;
pub mod chunk;
pub mod hex;
pub mod hex_pick;
pub mod hud;
pub mod math;
pub mod mesh;
pub mod protocol;
pub mod sim;
pub mod terrain;
pub mod world;
