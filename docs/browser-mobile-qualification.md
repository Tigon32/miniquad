# Manual mobile-browser qualification

Review date: 2026-11-10  
Tracking: [browser acceptance #11](https://github.com/Tigon32/miniquad/issues/11), [WebGL runtime #13](https://github.com/Tigon32/miniquad/issues/13)

**Status: Procedure defined. No iOS or Android device execution is claimed.**

## Test environment

Build the matching release WASM for both the basic quad and offscreen examples. Serve
`js/gl.js` and the WASM files together over HTTPS or a trusted local development
connection. Do not use a stale cached loader with a newer WASM ABI. Record the
deployed Git commit and `crate_version()` value.

The offscreen browser fixture explicitly requests WebGL2 on WASM because its
depth render target cannot be assumed available on WebGL1. This does not
qualify WebGL1 depth targets, which remain a separate limitation.

## Devices and provenance

For each test record device model, operating system build, browser version,
GPU (if visible), source commit, fixture URL, run date, and the operator. Minimum
manual lanes are:

| Lane | Required browser | Qualification state |
| --- | --- | --- |
| iPhone or iPad | Safari on an actual iOS/iPadOS device | **Not run** |
| Android phone or tablet | Chrome on an actual Android device | **Not run** |
| Desktop Linux CI | Playwright Chromium, Firefox, WebKit | See exact workflow run for results |

Playwright WebKit is not actual iOS Safari. Android Chrome is not qualified by
desktop Chromium. Do not silently substitute either.

## Manual acceptance script

1. Load the quad fixture; confirm a moving, visibly rendered image and no
   unhandled JavaScript or HTTP errors.
2. Resize or rotate the device; record display pixel ratio, CSS dimensions,
   drawing buffer size and whether the animation continues.
3. Focus the canvas. Press and release keyboard buttons where supported;
   verify correct transitions. Tap and drag, including a two-finger gesture;
   record pointer and touch event behavior.
4. Focus a separate text input; verify copy, cut and paste do not overwrite it.
   Focus the canvas and test approved clipboard gestures only with nonsensitive
   text. Record permission prompts or restrictions.
5. Load the offscreen fixture. Verify a non-default framebuffer is bound,
   the final image is presented and the render target is complete. Record
   whether WebGL2 and depth attachments are supported.
6. Exercise the browser's context-loss test extension only if available.
   Confirm frames stop and a reload is required after restoration.
7. Test missing WASM, unsupported WebGL context and an ABI mismatch. The
   browser must report a visible failure, not a silent blank success.
8. Record a screenshot, console log, browser/device details and pass/fail
   for every applicable step.

If a capability is unavailable, record **Unsupported**, not **Passed**.
For a failure, attach a minimal reproduction and link the corresponding
GitHub issue.

## Evidence needed to qualify a lane

Publish the exact tested revision, browser/OS/device versions, results for
each step, screenshots and captured console/network logs. A reviewer must
compare them with the desktop CI matrix and explicitly approve the lane
before any mobile support claim. Until that record exists, mobile Safari and
Android Chrome remain **unqualified**.
