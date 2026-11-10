# Mobile browser qualification procedure

* Defined: 2026-11-10
* Status: **Procedure defined; physical mobile runs not executed**
* Scope: [browser acceptance #11](https://github.com/Tigon32/miniquad/issues/11), [WebGL runtime #13](https://github.com/Tigon32/miniquad/issues/13)
* Browser bridge: deploy version-matched `js/gl.js` and compiled `quad.wasm` / `offscreen.wasm`

## Purpose and qualification boundary

Playwright Chromium, Firefox, and desktop WebKit are desktop engine tests.
Desktop Playwright WebKit **does not qualify iOS Safari**. A mobile
Chrome-on-Android run cannot qualify every Android device or GPU.

Keep mobile state as **Not tested** until actual device evidence is recorded.
The project must not claim supported mobile browser versions or release
readiness solely from desktop tests.

## Required physical-device sessions

Record a separate session for each target. Use a device with a known OS
release, browser version and GPU/SoC. Do not invent versions from a
user-agent string or infer that a device has been exercised.

| Target | Required environment | Current status |
| --- | --- | --- |
| Safari on iOS | Physical iPhone, iOS and Safari versions recorded | Not tested |
| Chrome on Android | Physical Android device, Android and Chrome versions recorded | Not tested |

Run on HTTPS from a versioned, reproducible deployment of the checked-in
JavaScript bridge and WASM assets. Record the exact Git commit and artifact
hashes. Capture the browser console and screenshots/recordings with sensitive
data removed. No credentials or personal clipboard content belong in logs.

## Behavior checklist

For each device and browser, record **Pass**, **Fail**, **Unsupported**, or
**Not tested**, with a link to independent evidence.

1. Load the page, verify WASM MIME and matching ABI, and observe a first
   non-black frame without console or HTTP errors.
2. Resize/rotate the viewport and verify canvas pixel dimensions and DPI
   scale. Observe animation progress after the change.
3. Focus the canvas, press/release keyboard keys where a hardware keyboard
   exists, and confirm no stuck keys after losing focus.
4. Test pointer down/up, touch start/move/end and touch cancel. Verify that
   release outside the canvas does not leave a held button.
5. Paste known synthetic test content through a **user-authorized gesture**;
   verify UTF-8 text and that unrelated input fields retain their clipboard
   behavior. Record permission denial separately.
6. Exercise WebGL1 and WebGL2 where available. Record the supported
   `WEBGL_depth_texture` and render-target capabilities; do not silently
   convert unsupported features into a pass.
7. Render a color offscreen pass, bind/unbind a render target, and inspect
   the presented output. Test depth-attached offscreen passes only where
   the required depth-texture capability is supported.
8. Trigger `WEBGL_lose_context` if the extension is available. Verify
   observable fail-stop; a restored browser context does not mean Miniquad's
   GPU buffers, textures, and pipelines have been rebuilt.
9. Repeat file drops only where the browser supports them. Check count,
   byte limits, malformed reads and asynchronous completion without
   unintended memory growth. Record unsupported drag-and-drop separately.
10. Record browser crashes, memory-pressure termination, unexpected dialogs
    and any manual rollback or reload needed.

## Evidence receipt template

```text
Session ID:
Date and tester:
Git SHA / WASM hash / JS hash:
Physical device model / SoC / GPU:
Operating system / browser version:
HTTPS deployment URL (without secrets):
WebGL version and supported extensions:
Scenario ID / action / expected / observed / pass-fail-unsupported:
Browser console and HTTP/network evidence:
Screenshots, trace or video reference:
Residual defects and keeper issue:
Reviewer and disposition:
```

## Release and issue closure

Desktop browser runs may establish desktop acceptance. They cannot substitute
for a physical mobile session. If a device session is not required for a
specific browser-first change, record the scope limit explicitly.

Issue #11 may close its **test-harness deliverable** when the desktop engines,
behavioral scenarios and manual mobile procedure have executable evidence.
Mobile support itself remains unqualified until physical-device receipts are
available. Release readiness has an independent gate in
[issue #19](https://github.com/Tigon32/miniquad/issues/19).
