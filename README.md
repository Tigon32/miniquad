# Miniquad

> **Source and credit:** This project began as a fork of [Miniquad](https://github.com/not-fl3/miniquad), created by Fedor Logachev.
> See [upstream attribution](docs/upstream-attribution.md) and the original licence notices.
> The project is planning a new name. No package or public API has been renamed yet.

[![Github Actions](https://github.com/not-fl3/miniquad/workflows/Cross-compile/badge.svg)](https://github.com/not-fl3/miniquad/actions?query=workflow%3A)
[![Docs](https://docs.rs/miniquad/badge.svg?version=0.3.13)](https://docs.rs/miniquad/0.3.13/miniquad/index.html)
[![Crates.io version](https://img.shields.io/crates/v/miniquad.svg)](https://crates.io/crates/miniquad)
[![Discord chat](https://img.shields.io/discord/710177966440579103.svg?label=discord%20chat)](https://discord.gg/WfEp6ut)
[![Matrix](https://img.shields.io/matrix/quad-general:matrix.org?label=matrix%20chat)](https://matrix.to/#/#quad-general:matrix.org)

Miniquad is a small Rust library for graphics, input, and windows.
It supports several GPU and operating-system interfaces.
The project aims to keep its code and dependencies small.

This fork uses [MADR 0003](docs/adr/0003-use-asd-ste100-for-communication.md) as its writing target.
New project instructions and documents must use short, clear sentences and the technical terms in the [glossary](docs/glossary.md).
These documents are **STE-aligned drafts**. We have not done a complete ASD-STE100 dictionary check.

## Start a browser project

Use the tested starter instead of assembling the browser files by hand.
Install Node.js 24 and a Rust toolchain with `rustup` first.
From this checkout, run:

```sh
rustup target add wasm32-unknown-unknown
node scripts/create-browser-project.mjs ../my-graphics-app --source path --miniquad-path "$PWD" --name my-graphics-app
cd ../my-graphics-app
node scripts/build.mjs
node scripts/serve.mjs --port 8080
```

Open the address printed by the server.
The generated project has animation, HTML controls, visible errors, and a matching
JS/WASM pair. Deploy its `web/` directory to a static HTTP server.
End users do not need Rust or Node.js.
This local setup depends on this checkout. See the [starter guide](docs/browser-starter.md)
for an immutable Git revision and deployment under a subpath.

| Need | Use |
| --- | --- |
| Direct GPU drawing, buffers, shaders, and WASM | Miniquad |
| Basic paths in an existing JavaScript application | Consider Canvas 2D before a WASM rewrite |
| Reusable lines, curves, circles, and batches | Optional [drawing companion](docs/drawing-companion.md) |
| A bounded offline voxel example | Optional [voxel companion](docs/offline-voxel.md) |
| Embed a scene with mount, pause, and disposal | Optional [browser module](docs/browser-embedding.md) |
| HTML controls, colors, and motion preferences | [Host preference adapter](docs/host-preferences.md) |

Miniquad core does not supply a game engine or a voxel world.
The voxel companion is an offline prototype. Server mode and full qualification
remain in [#29](https://github.com/Tigon32/miniquad/issues/29).
Design-process tools can check a host page, but they do not supply a renderer.
No design-tool runtime or `Tokens.swift` file is required.
Fork release qualification remains separate under [#19](https://github.com/Tigon32/miniquad/issues/19).

The platform list below comes from the upstream project. It is **not** a record of platform tests on this fork.

## Platform targets

* Windows, OpenGL 3, OpenGL 2.2;
* Linux, OpenGL 2.2, OpenGL 3, GLES 2, GLES 3;
* macOS, OpenGL 3, Metal;
* iOS, GLES 2, GLES 3, Metal;
* WASM, WebGL 1 - tested on iOS Safari, Firefox, Chrome;
* Android, GLES 2, GLES 3.

## Examples

![Imgur](https://i.imgur.com/TRI50rk.gif)

[examples/quad.rs](https://github.com/not-fl3/miniquad/blob/master/examples/quad.rs): [web demo](https://not-fl3.github.io/miniquad-samples/quad.html)

[examples/offscreen.rs](https://github.com/not-fl3/miniquad/blob/master/examples/offscreen.rs): [web demo](https://not-fl3.github.io/miniquad-samples/offscreen.html)


[PonasKovas/miniquad-mandelbrot](https://github.com/PonasKovas/miniquad-mandelbrot): [web demo](https://ponaskovas.github.io/miniquad-mandelbrot-wasm-demo/)

# Building examples

## Linux

```bash
cargo run --example quad
```

On NixOS Linux you can use [`shell.nix`](shell.nix) to start a development
environment where Miniquad can be built and run.

## Windows

```bash
# both MSVC and GNU target is supported:
rustup target add x86_64-pc-windows-msvc
# or
rustup target add x86_64-pc-windows-gnu

cargo run --example quad
```

## WASM

```bash
rustup target add wasm32-unknown-unknown
cargo build --example quad --target wasm32-unknown-unknown
```

Use the HTML example below to load the compiled WASM file.
Use the JavaScript bridge from the same Miniquad revision as the WASM file.

<details><summary>index.html</summary>

```html
<html lang="en">

<head>
    <meta charset="utf-8">
    <title>TITLE</title>
    <style>
        html,
        body,
        canvas {
            margin: 0px;
            padding: 0px;
            width: 100%;
            height: 100%;
            overflow: hidden;
            position: absolute;
            background: black;
            z-index: 0;
        }
    </style>
</head>

<body>
    <canvas id="glcanvas" tabindex='1'></canvas>
    <!-- Copy js/gl.js from the same Miniquad revision as the Rust dependency. -->
    <script src="./gl.js"></script>
    <script>load("quad.wasm");</script> <!-- Your compiled wasm file -->
</body>

</html>
```
</details>

To serve the static HTML and WASM files, you can use a local HTTP server.
The command below installs one example server.

```no-run
cargo install basic-http-server
basic-http-server .
```

## Android

You can use Docker to build the Android example.
The upstream build uses a modified version of `cargo-apk`.

```no-run
docker run --rm -v $(pwd)":/root/src" -w /root/src notfl3/cargo-apk cargo quad-apk build --example quad
```

The APK file is in `target/android-artifacts/(debug|release)/apk`.
If you enable `log-impl`, the build sends log messages to the ADB console.
This fork has not completed a new Android runtime test.

## iOS

To run the example on the iOS simulator, use the commands below.

```no-run
mkdir MyGame.app
cargo build --target x86_64-apple-ios --release
cp target/release/mygame MyGame.app
# only if the game have any assets
cp -r assets MyGame.app
cat > MyGame.app/Info.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>CFBundleExecutable</key>
<string>mygame</string>
<key>CFBundleIdentifier</key>
<string>com.mygame</string>
<key>CFBundleName</key>
<string>mygame</string>
<key>CFBundleVersion</key>
<string>1</string>
<key>CFBundleShortVersionString</key>
<string>1.0</string>
</dict>
</plist>
EOF

xcrun simctl install booted MyGame.app/
xcrun simctl launch booted com.mygame
```

For instructions to run the program on a physical iPhone, see [https://macroquad.rs/articles/ios/](https://macroquad.rs/articles/ios/)

## Cross Compilation

```bash

# windows target from linux host:
# this is how windows builds are tested from linux machine:
rustup target add x86_64-pc-windows-gnu
cargo run --example quad --target x86_64-pc-windows-gnu
```

# Goals

* Keep compilation time short. Measure build time before you report a result.
* Support more than one platform. Keep platform-specific application code small.
* Support devices that have limited resources.
* Make hardware and driver problems easy to find and correct.
* Keep platform code easy to inspect and reuse.

# Non-goals

* A Rust type system that can prove all GPU state is correct. The code must still meet Rust memory safety requirements.
* A high-level interface for Vulkan or DirectX 12. For these interfaces, see [gfx-rs](https://github.com/gfx-rs/gfx) or [vulkano](https://github.com/vulkano-rs/vulkano).

# Platinum sponsors

Miniquad is supported by:

[SourceGear](https://www.sourcegear.com/)
