# Keep browser adoption tools outside the core library

* Status: **Proposed**
* Date: 2026-11-11
* Scope: Browser embedding, consumer starter, optional drawing, and host preferences
* Related issues: [#121](https://github.com/Tigon32/miniquad/issues/121), [#122](https://github.com/Tigon32/miniquad/issues/122), [#123](https://github.com/Tigon32/miniquad/issues/123), [#124](https://github.com/Tigon32/miniquad/issues/124)

## Context and Problem Statement

Miniquad supplies GPU drawing commands. Applications own scene rules.
The browser bridge uses one canvas and one global application state.
Changing that bridge into a multi-instance framework can break the existing ABI.
Other projects need a tested setup and a clear way to release an embedded application.

## Considered Options

| Option | Benefit | Cost |
| --- | --- | --- |
| Rewrite the bridge as a module with instance state | Direct access to a host canvas | Large change to a tested global bridge |
| Isolate each application in a same-origin frame | Separate state and browser-owned cleanup | One frame per application; not a host-owned canvas |
| Require each consumer to copy examples | No new public contract | Repeated integration work and revision errors |

## Decision Outcome

**Proposed:** Add an optional browser module that owns a same-origin frame inside
a host container. Keep the existing standalone bridge and ABI v3 unchanged.
The frame owns its canvas. The host owns the container and semantic HTML controls.
Do not pass a host canvas into a runtime that cannot safely own it.

The module must expose startup, pause, resume, focus, and disposal.
Disposal must work during startup and after an error. It must release the frame,
its listeners, its frame loop, and its WebGL context. Pending startup must reject.
Pause must stop scene frames and input without reporting disposal.
Startup errors and context loss must have an explicit host-visible path.
Applications with lost contexts require a new mount, not automatic restoration.

Keep the starter, host preferences, and drawing package optional.
They must not add dependencies to the core Rust crate.
The starter must copy a matching bridge and browser module from one source revision.
It must build and run outside the repository.
Resolve release naming and distribution through issue #19 and MADR 0006.

Host-to-scene values must use a bounded, typed application contract.
Do not expose arbitrary WASM memory writes or treat application-specific fields
as additions to the core ABI. Reject unsupported commands.

## Resource Ownership

| Resource | Owner | Release action |
| --- | --- | --- |
| Host container and HTML controls | Host application | Host removes them |
| Runtime frame, canvas, and event handlers | Embedding module | Remove frame and module listeners |
| Frame scheduling and startup | Runtime frame | Cancel callbacks and reject pending startup |
| GPU handles and context | Runtime frame | Release context before frame removal |
| WASM memory and transfer state | Runtime frame | Remove the isolated realm and its references |
| Drawing batches and GPU buffers | Optional drawing package | Explicit package cleanup |
| Theme and motion listeners | Host preference adapter | Explicit adapter disposal |

Frame removal makes the realm eligible for browser cleanup.
It does not prove immediate operating-system memory reclamation.
Do not report a memory improvement without measurements.

## Verification

Use compiled WASM for startup, pixels, resize, pause, input, and disposal tests.
Test remount, simultaneous isolated applications, and cancellation during startup.
Retain existing standalone and ABI tests.
Test the starter in a separate temporary directory and through a deployment subpath.
Test pure drawing geometry separately from browser output.
Run preference and keyboard checks at the widths specified in issue #122.
Record browser versions and limits. Desktop WebKit does not qualify iOS Safari.

## Consequences

The optional layer can support ordinary HTML and different host frameworks.
Frame isolation avoids a large bridge rewrite and permits independent instances.
It adds a document boundary. Styling and accessibility need explicit host and frame
responsibilities. A host-owned canvas API remains outside this first contract.

This decision remains proposed until implementation evidence is reviewed.

**Writing review:** STE-aligned draft. Full dictionary review not done.
