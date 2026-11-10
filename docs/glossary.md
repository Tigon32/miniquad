# Miniquad technical glossary

Use the preferred terms in this glossary.
Do not change the meaning of an existing concept ID.
The JSON files are the sources for these definitions.
Other projects can reuse `docs/terminology/core.json` without Miniquad-specific terms.

This glossary is a project technical noun and verb list.
It is not a copy of the ASD-STE100 dictionary.
The terms are **STE-aligned drafts** until a full dictionary review is complete.
See [MADR 0003](adr/0003-use-asd-ste100-for-communication.md).

## Reusable engineering terms

| Preferred term | Definition | Concept ID |
| --- | --- | --- |
| architecture decision record | A document that records one important technical decision and its reason. | `core:architecture-decision-record` |
| decision status | The recorded state of an architecture decision. | `core:decision-status` |
| contract | A set of rules that defines how components exchange data or use an interface. | `core:contract` |
| interface | A defined boundary that lets two components exchange information or perform operations. | `core:interface` |
| CI check | A build or test check that runs automatically when a defined event occurs. | `core:CI-check` |
| regression test | A test that detects the return of a fault that was found before. | `core:regression-test` |
| behavior-driven development | A method that describes required behavior with examples that can become executable tests. | `core:BDD` |
| pull request | A proposed source change that a reviewer can examine before merge. | `core:pull-request` |
| risk | A possible event or condition that can cause an unwanted result. | `core:risk` |
| test evidence | A record of a test method, source revision, observed result, and limits. | `core:evidence` |
| server-side execution | Execution of application work on a server instead of on a local client. | `core:server-side-execution` |
| client-side execution | Execution of application work on a user device. | `core:client-side-execution` |

## Miniquad-specific terms

| Preferred term | Definition | Concept ID |
| --- | --- | --- |
| Miniquad | A Rust library that provides window, input, and graphics functions for different platforms. | `miniquad:library` |
| game application | A program that uses Miniquad and contains application or game rules. | `miniquad:application` |
| platform backend | Code that connects Miniquad to a specific operating system or graphics API. | `miniquad:backend` |
| WebAssembly module | A compiled module that a WebAssembly runtime can execute. | `miniquad:WASM` |
| browser bridge | JavaScript code that connects browser services and events to Miniquad WASM. | `miniquad:browser-bridge` |
| WebGL | A browser graphics API that sends drawing commands to a GPU. | `miniquad:WebGL` |
| graphics context | The state and access that a graphics backend uses for GPU operations. | `miniquad:graphics-context` |
| GPU buffer | GPU memory that holds data for drawing operations. | `miniquad:GPU-buffer` |
| buffer update | An operation that changes the data in a GPU buffer. | `miniquad:buffer-update` |
| texture | An image resource that the GPU uses for drawing. | `miniquad:texture` |
| render target | A screen or offscreen resource that receives rendered output. | `miniquad:render-target` |
| render pass | A set of drawing operations that uses a defined render target and render state. | `miniquad:render-pass` |
| draw call | A command that tells the GPU to draw geometry. | `miniquad:draw-call` |
| rendering pipeline | The shaders and GPU state used for drawing. | `miniquad:pipeline` |
| frame | One complete visual update. | `miniquad:frame` |
| integration PR | A pull request that adds selected upstream changes to the Miniquad fork. | `miniquad:integration-PR` |
| voxel | One volume element in a three-dimensional grid. | `miniquad:voxel` |
| voxel chunk | A bounded group of voxels that a game can load, update, or draw as a unit. | `miniquad:voxel-chunk` |
| hybrid 2D/3D rendering | A rendering method that draws two-dimensional and three-dimensional objects in one frame. | `miniquad:hybrid-rendering` |
| authoritative server simulation | A server simulation that determines the game state used by clients. | `miniquad:server-simulation` |

## Term rules

1. Add or change a term in the JSON registry.
2. Give a new concept a stable ID and one definition.
3. Put general terms in `core.json`. Put library terms in `miniquad.json`.
4. Do not change the meaning of an existing ID. Add a new ID for a new meaning.
5. Use an alias only when the context cannot cause confusion.
6. Use the same term in issues, PRs, tests, and documents.
7. Run `node scripts/terminology.mjs --write` to update this file.
8. Run `node scripts/terminology.mjs --check` before you send a PR.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
