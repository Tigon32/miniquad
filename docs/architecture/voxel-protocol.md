# Voxel mixed-mode protocol v1

* Status: **Partially implemented**. The shared `Sim`/world/mesh/terrain code, the native `vx-server`, and the `mixed` WASM example exist, with passing Rust unit/integration tests and a Chromium/Firefox/WebKit functional suite (`tests/browser/voxel-mixed.privatefixture.mjs`): frozen offline/mixed scene and edit parity, sprite depth occlusion, a DPR1-vs-DPR2 framebuffer-scaling check, separate real WebGL1/WebGL2 build and context assertions, and a native server restart/outage/resync check all pass. Measured performance/footprint evidence (bytes, memory, RSS, timing) is not done yet. See [MADR 0008](../adr/0008-optional-voxel-topologies.md) and [#29](https://github.com/Tigon32/miniquad/issues/29).
* Scope: `companions/voxel/` only. Core ABI v3 does not change.
* Writing review: **STE-aligned draft**.

## Topology

`browser host (fetch) -> same-origin forwarder -> Rust std server (authority)`.
The runtime frame WASM never calls the network. The embedding host copies bytes between `fetch` and the staging exports.
The test forwarder in `tests/browser/serve.mjs` sends `POST /vx/v1/sync` to `127.0.0.1:${VOXEL_SERVER_PORT:-4230}`. It copies at most the protocol limits and returns `502` when the server is not available.

> Correction (evidence: parent integration instruction during #29 implementation): the original default port `4174` conflicts with the port the parent's generated starter project already uses. `vx-server` and this document now use **4230** as the default, with `VOXEL_SERVER_PORT` as the override. `4231` is reserved for this companion's own ephemeral test fixture server, not the authoritative server.

## Shared Rust types

* `sim::Command`: `SetVoxel { x: i16, y: i16, z: i16, id: u8 }`, `SetSpeed { milli: u16 }` with `milli <= 2000`.
* `sim::Sim`: `World`, `seed`, `speed_milli`, `rev: u32`. `apply(Command) -> Result<(), SimError>` rejects out-of-scene coordinates and unknown materials. Each accepted command adds 1 to `rev`. A rejected command changes nothing.
* `sim::Sim::state_hash() -> u64`: FNV-1a 64 over `rev`, `speed_milli`, and each chunk in sorted coordinate order: coordinate, then voxel bytes. All integers are little-endian.
* Scene: seed `20261111`, chunk dimensions 8x12x8, chunks `(0,0,0)` and `(1,0,0)`, `MAX_RESIDENT_CHUNKS = 4`.

## Frame header (24 bytes, little-endian)

| Offset | Field | Rule |
| --- | --- | --- |
| 0 | magic `VXP1` | Else error `Malformed` |
| 4 | `version: u16` | Must be `1`. Else error `Version` |
| 6 | `kind: u8` | Client: 1 `Hello`, 2 `Inputs`. Server: 16 `Snapshot`, 17 `Delta`, 18 `Error` |
| 7 | `flags: u8` | Must be `0` |
| 8 | `world_id: u32` | Server CLI value. Client sends 0 in `Hello` |
| 12 | `seq: u32` | Client: request sequence. Server: response sequence |
| 16 | `rev: u32` | Client: last applied revision. Server: revision after this frame |
| 20 | `body_len: u32` | Must equal remaining bytes. Client max 1024, server max 16384 |

## Bodies

* `Hello`: empty. The server replies with a `Snapshot`.
* `Inputs`: `count: u16` (0..=64), then `count` records of 8 bytes: `op: u8` (1 voxel, 2 speed), `id: u8`, `x: i16`, `y: i16`, `z: i16`. For op 2, `x` holds `milli` as `u16` bits, and `id`, `y`, `z` are 0.
* `Snapshot`: `seed: u32`, `speed_milli: u16`, `chunk_count: u16` (<= 4). For each chunk: `cx, cy, cz: i16`, `dx, dy, dz: u8`, `pad: u8 = 0`, `rle_len: u32`, then RLE pairs `(run: u8 1..=255, id: u8)`. The dimensions must equal the world dimensions. `rle_len` must be even. The decoded length must equal the chunk volume exactly.
* `Delta`: `base_rev: u32`, `count: u16` (0..=64), then 8-byte command records. These records are the applied commands from `base_rev` to header `rev`.
* `Error`: `code: u16`: 1 `Version`, 2 `World`, 3 `Malformed`, 4 `TooLarge`, 5 `Stale`, 6 `Gap`, 7 `Rejected`.

The decoder checks each length before it reads or allocates. Each codec function returns `Result`. No codec path can panic.

## Sequence and revision rules

* The client sends one request at a time. `Hello` resets the client `seq` to 0. Each `Inputs` request uses `seq + 1`.
* Server, for each `Inputs`: if `world_id` differs, send `World`. If `seq` equals the last seq, send the cached last response again and do not apply the commands. If `seq` is lower, send `Stale`. If `seq` is more than last + 1, send `Gap`.
* The server keeps a ring of the last 64 applied commands. If the client `rev` is in the ring range, it sends a `Delta`. Otherwise it sends a `Snapshot`. This includes a client `rev` that is newer than the server `rev`, for example after a server restart.
* Client: it ignores a response with `seq` not newer than the last response. It discards a `Delta` with `base_rev != rev` and sends `Hello`. On `Version`, it stops and shows the error. It does not retry. On `World`, `Gap`, or `Stale`, it sends `Hello`.

## HTTP limits (server)

Only `POST /vx/v1/sync` and `GET /health` are accepted. Other requests receive `404` or `405`.
The request line must be at most 1 KiB. Headers must be at most 8 KiB and at most 32 lines.
`Content-Length` is required and must be at most 1048 bytes. `Transfer-Encoding` causes `400`. The content type must be `application/octet-stream`.
Read and write timeouts are 2 s. The server sends `Connection: close` and processes one connection at a time. It binds `127.0.0.1` only.
Protocol errors use HTTP `200` with an `Error` frame. HTTP parser errors use `400` with an empty body.

## Client staging exports (mixed build only)

| Export | Contract |
| --- | --- |
| `vx_net_in_ptr() -> *mut u8`, `vx_net_in_cap() -> u32` | Static inbound buffer of 16408 bytes owned by WASM. JS writes at most `cap` bytes. |
| `vx_net_in_commit(len: u32) -> i32` | Decodes into a one-slot mailbox. 0 ok, 1 invalid frame, 2 slot full, 3 too long. |
| `vx_net_build_request() -> u32`, `vx_net_out_ptr() -> *const u8` | Writes the next request into the outbound buffer. Returns 0 while the inbound slot is not applied. |
| `vx_net_set_status(code: u32) -> i32` | Host transport state for the HUD: 0 connecting, 1 online, 2 offline, 3 version error. |
| `vx_input(op, id, x, y, z) -> i32` | The same trace entry point in both modes. Offline applies the input in the next `update`. Mixed queues it, up to 64 entries. |
| `vx_state_hash_lo/hi() -> u32`, `vx_world_rev() -> u32` | Semantic parity probes. |
| `vx_has_snapshot() -> u32` | Whether `vx_world_rev()` reflects an actual applied snapshot yet (`0`/`1`). Mirrors the HUD's own gate on the same flag; the host's full revision text (`voxel-revision.mjs`) uses it to distinguish "no snapshot yet" from a real revision of `0`. |
| `vx_sprite_pixel() -> u32` | Sprite centre in canvas pixels as `x << 16 \| y`. |
| `vx_release_gpu()`, `vx_resources_live() -> u32` | Explicit GPU release protocol. |

The mailbox is a module `static` (`Mutex` or a WASM `thread_local`). `Stage` reads it in `update`.

> Correction: `vx_release_gpu` must release GPU resources even while the host has the app paused, and a paused app never runs another `draw` call to service that release. No export stores a pointer to a `Stage` value: `vx_release_gpu` only sets an `AtomicBool` flag, read and serviced exclusively by the next `draw` call. Because `draw` does not run while paused, the *host* (not the WASM export) is responsible for the full release sequence: resume the app if it is paused, call `vx_release_gpu()` to set the flag, wait (bounded) for `vx_resources_live() == 0`, and call `dispose()` in a `finally` regardless of whether that wait observed zero in time. See "Rendering and GPU resources" below for the exact bound.

During a disconnect, the client discards queued inputs and counts them. The world stays read-only. Before the first snapshot, the client draws only the clear colour and the HUD.
The host retries after 250 ms × 2^n, at most 4 s. It uses `AbortController` with a 2 s limit for each request and polls each 100 ms.

## Revision overflow

`Sim::apply` checks `rev.checked_add(1)` before any other check or mutation. At `rev == u32::MAX`, every command (even an otherwise valid one) is rejected with `SimError::RevisionOverflow`, mapped to the wire `Error` frame's `ErrorCode::Rejected` (7) exactly like every other rejection. `rev` never wraps back to `0`: it stays monotonically increasing, or the `Sim` stops changing.

The HUD's six-digit revision cell shows `------` before the first snapshot, the zero-padded decimal value for `rev` in `0..=999_999`, and `EEEEEE` for `rev >= 1_000_000` (`hud::classify_revision`). This is a **display** limit only, not a transport error: the host's semantic status text always carries the full, true `u32` revision (read via the WASM export's return value, reinterpreted unsigned with `>>> 0` on the JS side). `companions/voxel/web/voxel-revision.mjs` implements this host-side formatting (`toUnsignedU32`, `formatHostRevision`); `tests/voxel-revision.test.mjs` covers its boundaries (`None`, `0`, `42`, `999999`, `1000000`, and the `0xFFFFFFFF -> 4294967295` conversion) as pure Node tests, deliberately not as a million-edit browser run.

## Rendering and GPU resources

* The client keeps one vertex and one index buffer for each meshed chunk. An edit marks its chunk dirty. A boundary edit also marks the neighbour chunk dirty. The client rebuilds at most 2 dirty chunks in each `update`. A chunk that leaves a snapshot is deleted at once.
* The HUD uses seven-segment quads for at most 16 digits: mode, status, and revision. It uses one stream buffer that is created once. Depth test is off and alpha blend is on.
* Release: `vx_release_gpu` sets an `AtomicBool`. The next `draw` deletes all buffers, pipelines, and shaders one time, sets `resources_live = 0`, and draws no scene after that. When the application is paused, the host calls the runtime `resume()` for this step. The host waits at most 1000 ms for `resources_live == 0` and then calls `dispose()` in all cases.
* The `webgl2` cargo feature sets `conf.platform.webgl_version = WebGL2`. The same GLSL 100 shaders and the same host bridge are used. The tests check the context type.
* `conf()` sets `high_dpi: true`. `src/conf.rs`'s `Conf::default()` is `high_dpi: false` (non-Android), and `js/gl.js`'s `dpi_scale()` only applies the real `devicePixelRatio` when `high_dpi` is `true`. Without this field the framebuffer was always CSS-pixel-sized, which silently defeats the "physical pixels" HUD and canvas requirement whenever the actual device scale is not 1. `examples/offline.rs` (parent-owned route, `tests/browser/serve.mjs`'s `/voxel.wasm`) has the same gap and was deliberately left unchanged here to avoid altering parent-owned test behaviour outside this scope.

## GL1/GL2 build artifacts

Two full, separate WASM builds exist to let a host or a test assert the actually negotiated GL context version, not only a compile-time feature flag:

* Default (WebGL1): `cargo build --release --target wasm32-unknown-unknown --example mixed --manifest-path companions/voxel/Cargo.toml` -> `companions/voxel/target/wasm32-unknown-unknown/release/examples/mixed.wasm`.
* Explicit WebGL1 (separate output tree): `cargo build --release --target wasm32-unknown-unknown --example mixed --manifest-path companions/voxel/Cargo.toml --target-dir companions/voxel/target-gl1` -> `companions/voxel/target-gl1/wasm32-unknown-unknown/release/examples/mixed.wasm`.
* WebGL2: `cargo build --release --target wasm32-unknown-unknown --example mixed --manifest-path companions/voxel/Cargo.toml --features webgl2 --target-dir companions/voxel/target-gl2` -> `companions/voxel/target-gl2/wasm32-unknown-unknown/release/examples/mixed.wasm`.

`tests/browser/voxel-mixed.privatefixture.mjs` serves these at the `/voxel-mixed-gl1.wasm` and `/voxel-mixed-gl2.wasm` routes (private fixture server, not the root `serve.mjs`) and proves the negotiated version by calling `canvas.getContext("webgl2")` after the runtime has already created its own context: browsers lock a canvas to its first-created context type, so a `null` result proves WebGL1 and a non-null result proves WebGL2. `companions/voxel/.gitignore` excludes `/target-gl1` and `/target-gl2`.

## Depth-state fix: sprite depth occlusion (previously a known blocker)

The fixed-trace sprite-occlusion assertion (a stone column placed between the camera and the sprite should replace the sprite's pixel tint with the terrain colour) previously failed and was kept as a `test.fail()` regression marker. Root cause traced to the parent-owned renderer: `src/graphics/gl.rs`'s `apply_pipeline` tied `GL_DEPTH_TEST` enablement solely to the pipeline's `depth_write` setting rather than treating `depth_test`/`depth_write` as independent GL state (as `src/graphics/metal.rs` already did), so a pipeline that wants a depth test without writing depth (exactly the sprite pipeline: `depth_test: LessOrEqual, depth_write: false`) never actually tested depth. A second, related bug existed in `clear()`: `glClear(GL_DEPTH_BUFFER_BIT)` is itself gated by the current depth mask, so a depth clear could silently no-op if a previous pipeline had left writes disabled.

Both are now fixed in this worktree: `apply_pipeline` enables `GL_DEPTH_TEST` whenever `depth_write || depth_test != Comparison::Always` and calls `glDepthMask` independently (tracked via a new `GlCache.depth_write` field); `clear()` forces the mask true before a depth clear and restores it afterward. A `glDepthMask` JS binding was added to `js/gl.js` (an already-declared, already-documented ABI gap that was simply never called before). See `graphics::gl::depth_state_tests` for the pure-logic unit coverage.

**ABI compatibility of the new `glDepthMask` call (verified, no version bump):** `src/native/wasm/webgl.rs` already declared `glDepthMask` and `docs/abi-v3-function-inventory.md`/`docs/abi-v3-contract.md` already documented it before this fix (confirmed: zero diff on those three files from this change); only `js/gl.js`'s *implementation* and `gl.rs`'s *call site* were missing, and both are added together in the same commit. Checked the loader's actual policy in `js/gl.js`'s `load()`: `validate_wasm_imports(compiled)` walks every import the compiled module actually requires and throws `"Missing required WASM import: <module>.<name>"` if the current `importObject` lacks it, strictly before `WebAssembly.instantiate` — i.e. before `start_wasm` ever reads `crate_version`. Verified this empirically (not just by reading the source): built `target/wasm32-unknown-unknown/release/examples/quad.wasm` with this fix, confirmed `glDepthMask` is now an actual compiled import (`WebAssembly.Module.imports` lists `{module:"env", name:"glDepthMask"}`, 97 total imports), ran the real `tests/browser/abi-contract.spec.mjs` in Chromium against the checked-in bridge (1 passed), and additionally extracted the live `validate_wasm_imports` function out of `js/gl.js` into a Node sandbox and ran it against that same compiled `quad.wasm` twice: once with the current bridge (no missing imports) and once with a simulated *older* bridge (every current `env` import kept except `glDepthMask` deleted) — the simulated-old case threw exactly `Missing required WASM import: env.glDepthMask`, confirming the existing, unmodified contract mechanism already fails visibly (not silently, not success-shaped) before any `crate_version` check for a bridge that predates this change. Per `docs/abi-v3-contract.md`'s stated policy ("a breaking export/import... change increments the ABI version"), this isn't a breaking addition: the name, signature and documentation already existed; only its reachability changed, and the existing generic import-validation gate already covers that case correctly. No ABI version bump, and no inventory/contract doc edit, is required.

Fixing the real GL bug also exposed a second, independent pre-existing design bug in this example's frozen (`speed: 0`) scene: the sprite's old fixed-height formula placed it embedded inside its own column's solid terrain, invisible only because the GL bug drew it unconditionally. `examples/mixed.rs` now floats the sprite above its own column's real height (via `vx_column_height`), and the frozen position was retargeted to a column verified (by ray-marching the exact camera/target geometry against the real terrain height grid) to be visible by default, with a specific neighbouring column verified to occlude it when edited. The sprite-occlusion test in `tests/browser/voxel-mixed.privatefixture.mjs` is now an ordinary (non-`test.fail()`) passing regression.

## Verification contract

* Fixed trace: speed 0, then `SetVoxel` edits for a chunk interior, a chunk boundary, an out-of-range voxel (rejected), and a stone column between the camera and the sprite.
* Semantic parity: the offline and server states have equal `state_hash` and `rev` after the trace. Pixel parity: with frozen animation and the default camera, at most 0.5% of pixels differ by more than 2/255.
* Expected regions: the HUD rectangle has HUD pixels. The sprite centre has the sprite tint before the column edit and terrain colour after it.
* Faults: server not started, server stopped and restarted (`Snapshot` resync), `version = 2`, wrong `world_id`, duplicate `seq`, `seq` gap, `body_len` too large, truncated RLE, and a slow request that times out. No fault may cause local generation.
* Restart/outage/resync evidence: `tests/browser/voxel-mixed.privatefixture.mjs` kills the real `vx-server` child process mid-session, confirms the host reaches the OFFLINE status text, confirms the scene keeps drawing read-only and a queued edit during the outage is discarded (not applied locally; `rev` unchanged), then spawns a fresh `vx-server` (which starts at `rev == 0` by design, no persistence) and confirms `vx_world_rev()` drops back to `0` after reconnect, proving a genuine full `Hello` resync rather than silent continuation.
* Host status-reporting: `onFrame` reads the frame kind and error code exported by `vx_net_last_frame_kind()`/`vx_net_last_error_code()` and calls `reportOnline()`/`reportVersionError()` accordingly. Earlier, nothing called these on the success path, so the HUD/host status could stay in a non-online state indefinitely even while genuinely connected, and the client could silently fall back to local-only edits while appearing connected. Fixed by wiring these exports into `tests/browser/voxel-mixed.html`'s frame loop.
* Metrics: gzip WASM+JS bytes, `memory.buffer.byteLength`, `performance.memory` or `null`, server RSS from `ps`, request and response bytes, first-frame time, and frame-interval p95/p99. Record GPU time and GPU memory as `null` when they are not measurable. **Not yet measured** — functional acceptance above is complete; this metrics work remains the next bounded deliverable.
