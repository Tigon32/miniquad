# Native platform qualification

* Date: 2026-11-10
* Review: **Source-based qualification record**, not a release approval

The proposed [platform support policy](platform-support-policy.md) ([MADR 0016](adr/0016-modern-platform-support-policy.md), **Proposed**) gives the target matrix and the legacy removal plan.
This record gives the observed state only.

## Android

The existing manual CI used the Docker image `notfl3/cargo-apk` without a digest.
This fork has not verified the image source, build inputs, software support status, or security updates.
The image was used through a mutable tag.
The old Android build job has been disabled.

**State:** Android build and runtime behavior are **not tested** by the current CI.
Do not report the Android target as supported or qualified based on an earlier green workflow.
The Rust Android backend remains in the source tree.

The source changes for [#149](https://github.com/Tigon32/miniquad/issues/149),
[#150](https://github.com/Tigon32/miniquad/issues/150), and
[#151](https://github.com/Tigon32/miniquad/issues/151) follow
[MADR 0022](adr/0022-android-quit-and-jni-thread-ownership.md), **Proposed**.
Host tests check complete asset reads and the quit mutex/callback sequence.
`cargo check --target aarch64-linux-android --lib --tests` checks Rust compilation.
It does not build the Java application or run the Android backend.
Device tests for heap use, JNI thread exit, Back, and quit remain **blocked**.
Keep these issues open until the runtime checks pass.

### Restore a verified job

1. Select a currently supported Android SDK, NDK, and Rust compiler.
2. Pin the exact tool versions and container digest, if a container is necessary.
3. Review the container Dockerfile and source of the base image.
4. Check known advisories and the licence requirements.
5. Run a native Android build and an actual device test.
6. Record the build inputs and results.
7. Add the job behind `workflow_dispatch`.
8. Do not run an unverified container merely to make a test appear green.

## Linux X11 fullscreen regression

Use an X server with a 1280 by 1024 screen and an EWMH window manager.
Install `xdotool`, `xprop`, `xwininfo`, and `wmctrl` in the test environment.
Run:

```sh
cargo build --example fullscreen_probe
bash tests/native/x11-fullscreen.sh
```

The test starts a 640 by 480 window, enters fullscreen, and returns to
640 by 480. It checks `_NET_WM_STATE` and preserves `_NET_WM_STATE_ABOVE`
on exit. It closes only its own probe window.

The test passed on Ubuntu 24.04.5 Linux arm64 with Xvfb 21.1.12 and
Openbox 3.6.1. The same test with `linux_x11.rs` from
`7593d86b6e0699d6c905058c0008799c3cce39e5` failed: window geometry
returned to 640 by 480, but `_NET_WM_STATE_ABOVE` was lost.
Other window managers, Linux x64, GPU rendering, and native Wayland
are **not tested** by this regression.

The same source and runtime evidence rules apply to other native targets.
See [security issue #16](https://github.com/Tigon32/miniquad/issues/16) and [release issue #19](https://github.com/Tigon32/miniquad/issues/19).

**Writing review:** STE-aligned draft. Full dictionary review not done.
