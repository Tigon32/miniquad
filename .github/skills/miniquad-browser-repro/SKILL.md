---
name: miniquad-browser-repro
description: Reproduce Miniquad WebGL1/2, loader and DOM input defects using actual browser behavior and capture comparable regression evidence.
---

# Reproduce browser runtime behavior

Use for WebGL context, GPU resource, event/focus, loader and rendering failures. Relevant issues: #11, #13, #15. A browser is the test surface; a Rust compile, ESLint pass or mocked WebGL object is not equivalent.

## Minimal reproducible lane

1. Freeze exact Rust source SHA, `js/gl.js` revision, WASM build flags, demo and browser/OS/GPU versions. Serve assets over HTTP with correct WASM content type and no hidden CDN dependencies. Do not execute unreviewed remote scripts.
2. Observe a first rendered frame, initialization errors, WebGL version selection, extension availability, console messages and fatal/soft failure. Assert that missing canvas, denied context, wrong MIME, 404, missing exports, and version mismatch do **not** silently report success.
3. Exercise a specific event matrix: focus/blur/visibility, keydown-repeat/key-up (especially Cmd/Ctrl), mouse up outside canvas, touchcancel, clipboard focus isolation, unicode filenames and large/failed file drops. Record JS invocation sequence and Rust-observed events.
4. Exercise GPU lifecycle: create/bind/update/delete/recreate texture/buffer; offscreen render passes; WebGL context lost/restored; framebuffers and extension gating. Separate WebGL1 vs WebGL2 results.
5. Where possible run automated Chromium, Firefox and WebKit acceptance on the same demo. WebKit on a desktop runner is **not** evidence of iOS Safari; use a separately labelled manual mobile test.
6. Isolate browser profiles and sessions; do not drive a real user session or reuse a contaminated cache. Capture screenshots and logs only after removing private data; do not commit captures or credentials.

## Outcome states

**Reproduced** (steps and artifact), **not reproduced in named environment**, **blocked** (specific missing harness/device), or **unverified source hypothesis**. Include expected/actual outputs and a smallest failing fixture. Add a behavioral regression test that fails on baseline before proposing a fix. Link evidence to the relevant keeper issue; never write “browser-tested” without a real browser run.
