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

## Revision 1: mixed-mode transport (2026-11-11)

The offline slice exists in `companions/voxel/` (PR #125). This revision selects the mode B prototype before code. The [voxel protocol](../architecture/voxel-protocol.md) is the interface contract.

| Option | Result |
| --- | --- |
| WebSocket | Rejected for v1. It needs a handshake, framing, masking, and ping rules. No approved dependency supplies this. Do not write a general WebSocket server. |
| HTTP snapshot polling, Rust `std` server | **Selected.** One request at a time, `Connection: close`, strict bounded parser, binary frames. |
| Node gateway to a Rust child | Accepted only as a same-origin test forwarder. It copies bytes and has no simulation. |
| Streamed video (option C) | Deferred. No client-GPU limit justifies it. |

Decisions:

1. A shared pure Rust `Sim` (world, speed, revision) and `protocol` codec run in the native server and in browser WASM. Offline mode applies the same `Command` values locally.
2. The server binary uses only `std`. `miniquad` becomes a dev-dependency of the companion, so the library and server have zero dependencies. Lyon and `block-mesh` are permitted only in benchmarks, not at runtime.
3. Core ABI v3 does not change. The mixed client uses optional application exports with fixed-size staging buffers. No export holds a pointer to `Stage`.
4. Server mode never falls back to local generation. If the server is not available, the client shows the status and keeps the last snapshot read-only.
5. The scene draws a bounded seven-segment HUD in the frame. Semantic HTML controls stay in the embedding host.
6. GPU release is explicit: an `AtomicBool` request, one release in the next `draw`, and `resources_live = 0` before the host disposes the frame.
7. The server is a local loopback prototype. It is not an Internet service. It has no TLS, authentication, or access control claims.

Review perspectives: the SME selected polling because one in-flight request removes reordering. The adversary required body, header, and time limits, duplicate replay, and no silent fallback. The advisor removed WebSocket, TLS, a scene graph, and physics. The judge accepts this design as **Proposed** until the browser and server evidence passes.

## Open questions

- Which transparent-face and lighting rules are required after the first slice?
- What are the measured maximum acceptable chunk sizes on target devices?
- Does polling latency meet the input-to-visible target? Measure before a WebSocket review.

## Evidence status

The offline slice has unit and browser evidence in PR #125. Mode B has no implementation or measurement. The decision remains proposed and issue #29 remains open.
