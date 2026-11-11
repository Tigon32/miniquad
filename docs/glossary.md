# Miniquad technical glossary

Use these terms in code reviews, issues, PRs, and documents.
Each term has one meaning in this project.
This glossary does not change the public API.
A term can be a **project technical name** without being an ASD-STE100 approved word.
See [MADR 0003](adr/0003-use-asd-ste100-for-communication.md).

| Term | Meaning | Different term |
| --- | --- | --- |
| **Miniquad** | A Rust library for windows, input, and graphics on different platforms. | Game engine |
| **Game / application** | A program that uses Miniquad and contains game or application rules. | Miniquad library |
| **Platform backend** | Code that connects Miniquad to a specific operating system or graphics API. | Game logic |
| **Game engine** | A software system that supplies game rules and runtime functions. Miniquad does not supply the full system. | Miniquad library |
| **Rendering API** | Functions that let an application submit drawing commands to a graphics system. | Game simulation |
| **Interface contract** | Rules that define the data, types, ownership, version, and behavior at a boundary. | Implementation detail |
| **WebAssembly module (WASM)** | Rust code that is compiled into a module for a WASM runtime. | JavaScript bridge |
| **Browser bridge** | The JavaScript file `js/gl.js`. It connects browser functions and events to WASM. | Game engine |
| **Embedding host** | The web page that owns controls and a container for an optional Miniquad runtime frame. | Browser bridge |
| **Runtime frame** | A same-origin iframe that owns one Miniquad application, its canvas, and its browser state. | Security boundary |
| **WebGL** | The browser graphics API that sends drawing commands to the GPU. | WebAssembly |
| **WebGPU** | The explicit browser GPU API used by the proposed graphics migration. It is not a WebGL compatibility backend. | WebGL, WebAssembly |
| **WGSL** | The shader language used by WebGPU. | GLSL, MSL |
| **GPU adapter** | A WebGPU interface that exposes an available graphics implementation, its features, and its limits. | GPU device |
| **GPU device** | The WebGPU interface that owns resources and submits work through its queue. | HTML canvas element |
| **Device loss** | A terminal loss of a WebGPU device. The application must report the loss and stop using the device. | Automatic recovery |
| **Software adapter** | A graphics implementation that performs GPU API work in software. A passing test does not qualify hardware behavior. | Hardware GPU |
| **Compatibility backend** | A legacy graphics path that an application selects explicitly during migration. | Silent fallback |
| **Graphics context** | The state and access that a graphics backend uses for GPU operations. | HTML canvas element |
| **GPU buffer** | Memory on the GPU that holds data for drawing. | JavaScript ArrayBuffer |
| **Buffer update** | An operation that changes data in a GPU buffer. The API contract defines the exact action. | A CPU memory write |
| **Texture** | An image resource that the GPU uses for drawing. | Source image file |
| **Render target** | The screen or an offscreen resource that receives a rendered image. | Input-only texture |
| **Render pass** | A set of drawing operations that use one target and one defined state. | One draw call |
| **Draw call** | A command that tells the GPU to draw geometry. | Game update |
| **Rendering pipeline** | The shaders and render state that the GPU uses for drawing. | CI pipeline |
| **Frame** | One completed visual update. | Physics simulation step |
| **CI check** | A test or build check that runs automatically. | Proof of browser behavior |
| **Integration PR** | A pull request that adds selected upstream changes to this fork. | Original upstream PR |
| **SSE (server-side execution)** | Game simulation or other work that runs on a server. | Intel SSE instructions or HTTP Server-Sent Events |
| **BDD** | Behavior-driven development. It records user behavior in test scenarios. | A guarantee that all tests pass |
| **STE-aligned draft** | Text written with the project controlled-English rules. | Verified ASD-STE100 compliance |
| **Hexagonal-prism voxel** | An optional voxel shape: a flat-top hexagon cell, extruded by one integer layer height. It is separate from the default cubic voxel. | Cubic voxel |
| **Support tier** | The policy value for a platform: QUALIFIED, TARGETED, LEGACY, or UNSUPPORTED. See the [platform support policy](platform-support-policy.md). | Test status (Pass, Fail, Not tested, Blocked) |
| **Axial coordinate** | A cell position `(q, r)` on a flat-top or pointy-top hexagon grid. No layer is required: a 2D hex layout uses the position alone, and a hexagonal-prism voxel adds an integer layer. | Cube coordinate, offset coordinate |
| **2D hex layout** | An optional, pixel-only 2D module that maps an axial coordinate to a cell center, corners, and neighbors for one chosen orientation (flat-top or pointy-top), with no layer and no voxel. | Hexagonal-prism voxel |

## Add a term

1. Check if the glossary has a term with the same meaning.
2. If the term is new, give it one definition.
3. Use the same term in all changed documents.
4. Do not use **backend**, **renderer**, **engine**, and **bridge** as synonyms.
5. If two definitions conflict, propose a change in an issue or a PR.
6. Do not change an API name to make an editorial change.

See [MADR 0001](adr/0001-use-madr-and-ubiquitous-language.md).

Miniquad-specific concept IDs are in [the domain extension](terminology/miniquad.json).
A separate terminology registry will own the shared terms and validation tools.
This project does not contain the shared framework.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
