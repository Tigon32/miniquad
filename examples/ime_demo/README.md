# IME example

This example uses Miniquad for rendering and input.
It uses Skrifa to read font outlines and Zeno to rasterize glyphs.
It does not use `ttf-parser` or `fontdue`.

The example is a separate Cargo package.
Miniquad's runtime and Rust 1.70 compatibility target do not depend on its font packages.

## Build

```sh
cargo check --manifest-path examples/ime_demo/Cargo.toml
cargo run --manifest-path examples/ime_demo/Cargo.toml
```

The program needs a font on the host computer.
On Windows, it reads `C:\Windows\Fonts\msyh.ttc`.
On Linux, it reads `/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc`.
Install a compatible CJK font before you start the program.

The IME input and positioning code remains the same.
The text rasterization method changed.
The text renderer is a demo. It is not a full text shaping engine.

**Review:** STE-aligned draft. Full dictionary review not done.
