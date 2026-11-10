# Review of font parsers and rasterizers

* Date: 2026-11-10
* Scope: Isolated IME example and its font rasterization
* Related issue: [#16](https://github.com/Tigon32/miniquad/issues/16)
* Writing review: **STE-aligned draft**. Full dictionary review not done.

## Requirement

The IME example reads a TTC font file.
It maps characters to glyphs, reads advances, draws outlines, and builds an 8-bit alpha mask.
The main Miniquad library does not need a font parser.
The library declares Rust 1.70 as its minimum supported version.

[RUSTSEC-2026-0192](https://rustsec.org/advisories/RUSTSEC-2026-0192) classifies `ttf-parser` as **unmaintained**.
The advisory has no patched release and recommends Skrifa.
It does **not** identify an actively exploited vulnerability.

## Options

| Candidate | Function | Review result |
| --- | --- | --- |
| [read-fonts](https://github.com/googlefonts/fontations) | Parse OpenType tables | Useful lower layer, but not a glyph rasterizer |
| [Skrifa](https://docs.rs/skrifa/latest/skrifa/) | Read font metadata, character mapping, advances, and outlines | **Selected parser and outline source** |
| [Allsorts](https://docs.rs/allsorts/latest/allsorts/) | Parse and shape complex scripts | Larger feature scope than the existing demo; needs a rasterizer |
| [Fontdue](https://docs.rs/fontdue/latest/fontdue/) | Parse and rasterize glyphs | Current releases still depend on unmaintained `ttf-parser` |
| [FreeType](https://freetype.org/) | Parse, hint, and rasterize fonts | Mature native library, but adds a C/FFI and deployment boundary |
| [Typr.js](https://github.com/photopea/Typr.js) | JavaScript font parsing and rendering | Does not fit a native Rust IME test |
| [Zeno](https://docs.rs/zeno/latest/zeno/) | Rasterize vector paths into alpha masks | **Selected rasterizer**. No font parser |

## Decision and verification

The example uses **Skrifa 0.48.0 with Zeno 0.3.3**.
Each version is locked in `examples/ime_demo/Cargo.lock`.
Skrifa uses maintained `read-fonts` code for parsing.
Zeno converts the glyph outlines into a grayscale bitmap.
The example stays separate in `examples/ime_demo/`.

The root Cargo package no longer declares `fontdue`.
The change does not alter the main crate's public API or Rust 1.70 support target.

The focused CI compiles the example and rasterizes one glyph from DejaVu Sans.
It also checks that `ttf-parser` is absent from the example dependency graph.
Required root Rust/WASM, JavaScript, and Chromium tests run separately.

## Limits

The new rasterizer uses unhinted outlines.
Glyph edges can differ from the old Fontdue output.
This example still positions characters without full Unicode shaping.
It does not prove correct appearance for every CJK font, script, or variation.
A real Windows or Linux IME input session still needs manual verification.
Do not call this a full text-rendering engine.

## Later work

If a product needs complex text shaping, test Allsorts or a higher-level maintained shaping stack.
If a target needs native hinting, assess FreeType behind an optional platform boundary.
Do not add those dependencies to the core Miniquad runtime without an accepted decision and measurements.
