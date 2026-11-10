---
name: miniquad-browser-repro
description: Run Miniquad in a browser and reproduce WebGL, loader, and input errors with clear test evidence.
---

# Test Miniquad in a browser

Use this skill for browser input, WASM startup, WebGL, and GPU resource faults.
Read issues [#11](https://github.com/Tigon32/miniquad/issues/11), [#13](https://github.com/Tigon32/miniquad/issues/13), and [#15](https://github.com/Tigon32/miniquad/issues/15).

## Prepare the test

1. Record the Rust and JavaScript source revisions.
2. Build a WASM example with the required flags.
3. Serve the WASM and JavaScript files over HTTP.
4. Record the browser, OS, GPU, and WebGL version.
5. Use a clean browser profile. Do not use a personal browser session.

## Run the test

1. Start the example. Confirm that the browser draws the first frame.
2. Test a missing canvas, missing WASM file, wrong MIME type, and wrong ABI version.
3. If startup fails, confirm that the game does not report a successful start.
4. Test focus, blur, keyboard release, repeat events, and the mouse button release outside the canvas.
5. Test clipboard text and a file drop with Unicode names.
6. Test resize, display scale, texture creation, texture deletion, and offscreen rendering.
7. Test WebGL1 and WebGL2 separately.
8. Test context loss and restoration when the browser supports the test.
9. Collect console errors, expected results, and actual results.
10. Keep personal data out of the test records.

## Report the result

Use one result for each test: **passed**, **failed**, **not reproduced**, or **blocked**.
State which browser ran each test.
Do not say that desktop WebKit is a test of iOS Safari.
Do not say that a Rust build is a browser test.
Add the source SHA and a link to the correct issue.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
