# Embed a browser application

Status: **STE-aligned draft**. See [MADR 0009](adr/0009-optional-browser-adoption-layer.md)
and [issue #121](https://github.com/Tigon32/miniquad/issues/121).

## Files and ownership

Deploy `js/miniquad.mjs`, `js/runtime.html`, `js/runtime.mjs`, and `js/gl.js`
together. Build the application WASM against the same Miniquad revision.
Serve all files from the same HTTP origin.
The [starter](https://github.com/Tigon32/miniquad/issues/124) prepares these files.

The host supplies a container with a nonzero width and height.
The module creates a same-origin frame and its canvas inside that container.
It does not accept a host-owned canvas. This is a deliberate limit.
The frame isolates runtime globals, not untrusted code.
Load only trusted applications and runtime files.

```js
import { mount } from "./miniquad.mjs";

const app = mount({
    container: document.querySelector("#scene"),
    wasmURL: new URL("./app.wasm", import.meta.url),
    title: "Animated curve",
    paused: false
});
try {
    await app.ready;
} catch (error) {
    document.querySelector("#status").textContent = error.message;
}
```

Use `runtimeURL` to select another location for `runtime.html`.
The runtime loads its bridge and module from sibling paths.
All URL values resolve against the host document unless they are absolute URL objects.
Use relative paths or URL objects for deployment under a subpath.

## Lifecycle

`ready` resolves after WASM startup. It does not prove that a visible pixel was drawn.
`state` is `starting`, `running`, `paused`, `failed`, `context-lost`, or `disposed`.
Mount does not take keyboard focus.

Call `pause()` to hold frame callbacks and block input to the frame.
Call `resume()` to release held callbacks. The application must bound its elapsed
time after a pause. Call `focus()` only while the application runs.
Initial `paused: true` prevents the first animation callback.

Call `dispose()` when the host removes its scene. Disposal is safe to repeat.
It stops frame scheduling, aborts runtime fetches, releases the WebGL context where
the extension is available, and removes the frame.
It rejects pending startup immediately. Later method calls fail with `disposed`.
Pass an `AbortSignal` as `signal` to dispose the application on cancellation.

Startup errors reject `ready` with a `MiniquadError` containing a `code`.
A lost WebGL context sets `state` to `context-lost`.
The frame dispatches `miniquaderror` with the error in `event.detail`.
Uncaught application errors set `state` to `failed` and dispatch the same event.
Dispose and mount again. Do not resume invalid GPU resources.

The browser owns the removed realm's memory reclamation.
Disposal does not run Rust `Drop` for every application resource.
It does not prove immediate operating-system memory release.
No memory or performance improvement is claimed.
Two simultaneous isolated instances are tested. Device context limits can be lower
than application demand. Prefer one scene with several viewports for large comparisons.

The existing classic-script `load(path)` entry point remains available.
It retains its standalone focus and one-application behavior.

## Optional application parameter contract

This contract is not part of the core ABI v3.
An application can export these scalar functions:

| Export | Contract |
| --- | --- |
| `mq_params_version() -> u32` | Return `1` |
| `mq_param_set_f32(id: u32, value: f32) -> i32` | ID `1`: speed, finite range 0 to 2 |
| `mq_param_set_rgba8(id: u32, rgba: u32) -> i32` | ID `1`: foreground; ID `2`: background |

Setters return `0` on success and a nonzero value on rejection.
Colors use packed `0xRRGGBBAA`, sRGB channels, and straight alpha.
The host passes four finite floats from 0 to 1. The wrapper rounds each channel
to the nearest 8-bit value. No pointers or strings cross this boundary.
The application must validate IDs and scalar ranges again.

After startup, check `app.supportsParameters`. Call:

```js
app.setParameters({
    speed: 0.5,
    foreground: [0.2, 0.8, 1, 1],
    background: [0.02, 0.03, 0.05, 1]
});
```

Unknown keys, invalid ranges, missing exports, and rejected values throw errors.
Validate the complete object before sending its fields.
Setters execute in object order. A rejection can leave earlier valid fields applied.
Do not treat a multi-field update as an atomic transaction.
The host owns HTML controls, text descriptions, theme choices, and error messages.
