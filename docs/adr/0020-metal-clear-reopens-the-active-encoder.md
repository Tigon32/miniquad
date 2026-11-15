# Clear the active Metal render target in place, not the default framebuffer

* Status: **Accepted**
* Date: 2026-11-11
* Scope: `src/graphics/metal.rs` `RenderingBackend::clear`
* Related issue: [#143](https://github.com/Tigon32/miniquad/issues/143)

## Context and Problem Statement

`RenderingBackend::clear` has no attached render pass argument.
Its only defined target, from the GL backend, is "whatever is currently bound":
GL's `clear` issues `glClear` against the framebuffer the last `begin_pass` bound,
and does not change that binding.

The Metal backend's `clear` called `begin_default_pass` unconditionally.
Inside an active offscreen pass, this silently redirected the clear to the
default (on-screen) framebuffer instead of the pass still being recorded,
and it also forced a pass switch the caller never asked for.

Metal has no mid-encoder clear command.
A `MTLRenderPassDescriptor`'s load action can only take effect when a new
`MTLRenderCommandEncoder` is created from it.
Ending the open encoder and opening a new one on the same target is the
only way to apply a requested clear in place.
Metal resets all encoder-local state (bound pipeline, vertex/index
buffers, uniforms, viewport, scissor rect) when a new encoder is created;
this is a platform constraint, not a choice made by this backend.

## Decision Drivers

* Match the already-public, GL-defined contract: `clear` affects the
  current target, not the default framebuffer.
* Keep the fix inside Metal's real constraints instead of hiding them.
* Avoid a silent, undocumented state loss for callers that draw again
  after a mid-pass `clear`.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Keep redirecting to the default pass | No encoder churn | Clears the wrong target; diverges from GL |
| Clear via a full-screen draw call (no new encoder) | No state loss | New render path, new shaders/pipeline per clear; out of #143's scope |
| **End and reopen the current target's encoder; require the caller to reapply state afterward** | Clears the real target; stays inside Metal's existing encoder model | Caller must reapply pipeline/bindings/uniforms/viewport before its next draw |

## Decision Outcome

**Accepted:** `clear` applies to the render pass already active
(`current_pass_target`) when one exists, reusing its attachments; it
only falls back to the default pass when no pass is active yet.
Ending and reopening the encoder to honor the requested clear resets
Metal's encoder-local state. A caller that issues `clear` in the middle
of recording a pass, and then intends to draw again in that same pass,
must call `apply_pipeline`/`apply_bindings`/`apply_uniforms` (and
`apply_viewport`/`apply_scissor_rect` if used) again before its next
`draw`. This matches the already-required pattern of calling
`apply_pipeline` once per encoder.

### Effects

* `clear` no longer redirects an active offscreen pass to the screen.
* `PassAction::Clear`'s `None` fields (`color`, `depth`, `stencil`)
  preserve that attachment's existing contents (`Load`), matching GL;
  only `Some` fields clear.
* Documented limit: `clear` mid-pass does not preserve encoder-local
  draw state. This is a Metal API constraint, not a resolved gap.
