# Ubiquitous language — Miniquad

This is the canonical vocabulary for this Miniquad fork. Prefer these terms in issues, pull requests, ADRs, agent instructions, and documentation. It documents existing concepts; it does **not** imply that all features below exist in every target or that public APIs should be renamed.

| Preferred term | Meaning | Do not confuse with |
| --- | --- | --- |
| **Miniquad** | Lightweight cross-platform windowing, input, and graphics abstraction implemented primarily in Rust. | A complete game engine. |
| **Game/application** | Consumer of Miniquad that owns gameplay or application logic. | The Miniquad rendering library. |
| **Platform backend** | Target-specific implementation providing graphics, windowing, and/or input facilities (e.g. WebGL, Metal, native OpenGL). | A gameplay subsystem. |
| **WebAssembly module (WASM)** | Compiled Rust module executed by a browser's WASM runtime. | The JavaScript browser bridge. |
| **Browser bridge** | `js/gl.js`: JavaScript glue that exposes browser/WebGL services and delivers events to WASM. | Game logic or an independent game engine. |
| **WebGL** | Browser API for GPU-accelerated drawing, accessed through the browser bridge. | SVG, HTML Canvas 2D, or WebAssembly. |
| **Graphics context** | Backend-owned access to GPU resources and rendering operations. | A WebGL canvas DOM element. |
| **GPU buffer** | GPU-side storage for vertex, index, or other rendering data. | A CPU data structure or JavaScript ArrayBuffer. |
| **Buffer update** | Operation that replaces or updates data associated with a GPU buffer; exact semantics belong to the rendering API contract. | CPU-side memory mutation. |
| **Texture** | GPU image resource that may be sampled or used for rendering. | Source artwork such as an SVG. |
| **Render target** | Destination of rendered output, such as the screen or an offscreen texture/framebuffer. | A texture used only as input. |
| **Render pass** | Group of rendering operations targeting an output with associated setup/state. | One individual GPU draw call. |
| **Draw call** | Submission to draw geometry using a pipeline and bound resources. | An application update tick. |
| **Rendering pipeline** | Shader and render state configuration used for drawing. | The full build/deployment pipeline. |
| **Frame** | One visual update of rendered output. | A physics simulation step (which may run at another frequency). |
| **CI check** | Automated validation (e.g. Rust tests, WASM build, JavaScript lint). | Browser runtime correctness or a benchmark unless explicitly covered. |
| **Integration PR** | Pull request combining selected upstream changes for testing/review in this fork. | The original upstream pull request and discussion. |

## Rules for adding terms

1. Define a term where it first becomes necessary, using one unambiguous preferred name.
2. Record aliases only when unavoidable; don't mix **backend**, **renderer**, **engine**, and **bridge** as if they were synonyms.
3. Explain boundary concepts explicitly when crossing Rust/WASM/JavaScript.
4. Keep implementation details in code and ADRs; keep this glossary focused on meanings.
5. When a definition is disputed, propose a glossary change and link the corresponding ADR or issue.

See [ADR 0001](adr/0001-use-madr-and-ubiquitous-language.md).
