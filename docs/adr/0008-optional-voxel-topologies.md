# MADR 0008: Keep optional voxel simulation outside Miniquad core

* Status: **Proposed** (requires prototype evidence before acceptance)
* Date: 2026-11-11
* Tracking: [#29](https://github.com/Tigon32/miniquad/issues/29)
* Scope: Optional example or independent crate; no change to the Miniquad public API

## Context

Miniquad supplies windowing, input, and rendering interfaces. It is not a game engine. Issue #29 asks for bounded voxel terrain and mixed 2D/3D rendering in two deployment modes. An offline browser application must work without a network connection. An optional server can own simulation state, but rendering normally remains on the client.

## Options

| Option | Topology | Benefits | Risks and verification |
| --- | --- | --- | --- |
| A: WASM-only | Rust simulation, mesher, and WebGL renderer in the browser | No server, simple offline distribution, no protocol synchronization | Measure WASM/JS size, client heap, first-frame time, frame interval and meshing cost |
| B: WASM + server-side execution | Native server owns world state; browser caches chunks and renders | Shared-world authority and optional central generation | Protocol/version skew, latency, disconnect, queue bounds, total client + server memory |
| C: Server-side rendering | Server sends video/images to the browser | Can reduce client GPU requirements | Bandwidth, latency, encoder costs and loss of local GPU rendering |

## Proposed decision

Prototype A first. Keep the voxel world, mesher, shaders, and optional server in an **independent example/workspace outside the core library**. Do not introduce voxel dependencies into normal Miniquad builds. Implement B as an opt-in alternative with the *same scene* and measurable output. Defer C unless a documented client-GPU constraint warrants a distinct architecture review.

This is a **proposed design**. It does not claim that A is faster or B uses less memory. Compare measured evidence before selecting a shipping mode.

## Domain and resource contracts

- Use integer voxel coordinates; bound chunk dimensions and number of resident chunks before allocating. Reject invalid, overflowed, or oversized chunk lengths.
- Define immutable world snapshot IDs and monotonic per-chunk revision numbers. An edit marks its chunk and affected neighboring faces dirty.
- Only generate visible faces. Verify faces at chunk boundaries and separate transparent surface ordering from opaque surfaces.
- Define limits for decoded chunk bytes, pending network messages, in-flight GPU uploads, and resident CPU/GPU buffers. On eviction, release CPU references and GPU handles.
- Store simulation logic in a pure Rust module reusable in native and `wasm32-unknown-unknown` builds. Keep transport and rendering adapters separate.
- For mode B, include protocol version, world ID, sequence number, snapshot/revision ID, bounded payload length and message type. Reject malformed, duplicate and out-of-order updates; request a new snapshot on detected gaps.
- On disconnect, stop authoritative state mutations, show a clear status, and either reconnect using a bounded exponential backoff or enter explicitly supported offline mode. Do not silently pretend a server-controlled world is local.

## Frame composition

1. Clear the target and depth buffer.
2. Draw opaque 3D voxel meshes with perspective projection and depth test/write enabled.
3. Draw the world-space 2D sprite with a documented depth, alpha-blend and sorting policy.
4. Draw the screen-space 2D HUD in orthographic space with depth writes disabled and alpha blending enabled.
5. Restore render state, handle resize/DPI and release resources when a context becomes invalid.

Test WebGL1 and WebGL2 individually. Do not claim that a WebKit desktop test validates iOS Safari.

## Vertical-slice acceptance

Use the same fixed seed and input trace in modes A and B. Draw one small terrain chunk, one moving 2D sprite and a text HUD. The offline build must make no network request for gameplay. For mode B, test initial snapshot, stale protocol version, duplicate and missing messages, delayed delivery, disconnect and resync. Check sprite occlusion and resource teardown after context loss.

Capture source SHA, browser version, device, build flags, compressed WASM+JS bytes, CPU/WASM heap, JS heap, GPU allocation where available, server heap separately, network transfer bytes, time to first frame, frame-interval p95/p99 and input-to-visible latency. Use repeated runs and report variance. Never substitute estimated values for measurements.

## Dependency and release policy

Before selecting an external meshing crate, record its license, version, maintenance status, feature/dependency impact, target support and measured correctness. Do not add a game engine to the core crate. Do not mark issue #29 complete until both vertical slices and executable browser scenarios have been tested with source-linked receipts.

## Open questions

- Which transparent-face and lighting rules are required for the initial slice?
- What are the measured maximum acceptable chunk sizes on target devices?
- Which transport produces the simplest bounded protocol behavior for B?
- Can the same visible output be maintained with both execution modes?

## Evidence status

No implementation, benchmark, browser run or accepted dependency selection is represented by this MADR. The decision remains proposed and issue #29 remains open.
