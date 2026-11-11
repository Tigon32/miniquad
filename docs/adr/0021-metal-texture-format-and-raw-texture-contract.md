# Supply or gate missing Metal texture formats, raw textures, resize, and read-back

* Status: **Accepted**
* Date: 2026-11-18
* Scope: `src/graphics/metal.rs`, `src/native/apple/frameworks.rs` texture creation, format
  mapping, raw-texture resolution, `texture_resize`, `texture_read_pixels`
* Related issue: [#142](https://github.com/Tigon32/miniquad/issues/142)

## Context and Problem Statement

The Metal backend left four parts of the public texture contract unimplemented:

1. `From<TextureFormat> for MTLPixelFormat` panicked (`todo!()`) for
   `TextureFormat::RGB8` and `TextureFormat::Depth32`; `TextureFormat::Alpha` mapped to
   `MTLPixelFormatInvalid`, which Metal itself would reject at texture creation.
2. `TextureId::from_raw_id(RawId::Metal(..))` panicked (`unimplemented!()`) the moment the
   wrapped texture was bound, read, or deleted — "wrap a caller's texture without copying it"
   did not work at all on Metal.
3. `texture_resize` panicked (`unimplemented!()`) unconditionally.
4. `texture_read_pixels` panicked (`unimplemented!()`) unconditionally.

Per [MADR 0002](0002-risk-based-verification-and-selective-tdd.md) and the issue's acceptance
conditions, each of these must end in one of two states, never a silent/success-shaped
fallback: it works correctly, or it exposes a documented, testable unsupported state.

## Decision Drivers

* Keep `TextureFormat::size(width, height)` — the public bytes-per-pixel contract every caller
  already relies on for upload/read-back buffer sizing — exactly as documented, even where
  Metal's own storage differs.
* Metal has no native 24-bit RGB texture format, so `TextureFormat::RGB8` cannot map directly
  to a Metal pixel format.
* Metal's only combined depth format usable as a render target is a depth/stencil pair
  (`Depth32Float_Stencil8`); its CPU-visible layout does not match
  `TextureFormat::Depth`'s documented 2 bytes/pixel.
* A raw-texture wrap must decide, explicitly, which side owns the texture object and where its
  sampler/parameters come from — the issue flags this as the open design question.

## Considered Options (texture formats)

| Option | Benefit | Problem |
| --- | --- | --- |
| Reject `RGB8`/`Alpha` with a permanent `Features`-queryable "unsupported" flag | Simple, no conversion code | `RGB8`/`Alpha` already work on GL; Metal callers would silently lose a capability other backends have, for formats Metal's hardware can represent |
| Change `TextureFormat::size`'s contract to match Metal's internal storage | No conversion code | Breaks the existing, already-public, backend-independent byte contract; GL and WebGL callers would also have to change |
| **Store `RGB8` as `RGBA8Unorm`, converting at the CPU upload/read-back boundary; map `Alpha`→`A8Unorm` and `Depth32`→`Depth32Float` natively (no conversion needed)** | Keeps the public byte contract exact for every format; `Alpha`/`Depth32` need no conversion at all, since Metal already has an exact-size native format for each | `RGB8` pays a 4/3 byte expansion cost in Metal's VRAM and an extra CPU pass on every upload/read-back |

## Considered Options (raw Metal textures)

| Option | Benefit | Problem |
| --- | --- | --- |
| Keep `unimplemented!()`, document raw textures as GL-only on this backend | No new code | Issue explicitly asks for either a working implementation or a documented+testable gate; a permanent panic without a `Features` flag is exactly the silent-trap shape the issue rejects |
| Add a large new public API: a `TextureParams`-carrying `from_raw_id` variant | Caller controls every parameter explicitly | Issue's own wording warns against inventing a material API change when a smaller fix suffices; also diverges from GL's existing (parameter-light) raw-texture precedent |
| **Synthesize a `Texture` entry from the real `MTLTexture`'s own metadata (width/height/pixel format/mipmap count) on first use, with a fresh miniquad-owned sampler; never retain/release the caller's texture pointer** | No new public API surface; uses data Metal already carries on the object; mirrors (and improves on) GL's existing raw-texture precedent (`TextureParams::default()` with real `raw` id) | `texture_resize` cannot be supported for a texture miniquad does not own — must be a documented panic, not silently ignored |

## Decision Outcome

**Accepted.**

### Texture formats

* `RGB8` is stored as Metal's `RGBA8Unorm`. `new_texture`/`texture_update_part` convert
  3-byte RGB input to 4-byte RGBA on upload (`rgb8_to_rgba8`); `texture_read_pixels` converts
  back on read (`rgba8_to_rgb8`), dropping the synthesized alpha byte. The public
  `format.size(width, height)` value callers pass for `RGB8` stays 3 bytes/pixel throughout.
* `Alpha` maps to `MTLPixelFormatA8Unorm` (added to `MTLPixelFormat` in
  `src/native/apple/frameworks.rs`) — an exact 1-byte/pixel native match, no conversion.
* `Depth32` maps to `MTLPixelFormatDepth32Float` — an exact 4-byte/pixel native match, no
  conversion.
* `Depth` (unchanged) still maps to `Depth32Float_Stencil8`. Its CPU-visible storage does not
  match `TextureFormat::size`'s documented 2 bytes/pixel for *any* layout a caller could supply
  or read correctly, so CPU upload (`new_texture`/`texture_update_part`), `texture_resize`, and
  `texture_read_pixels` each `assert_ne!`/panic with a message naming `Depth32` as the
  supported alternative, instead of silently reading/writing the wrong byte count. This is the
  documented, testable unsupported state the issue asks for.
* `mtl_storage_bytes_per_pixel(format)` documents Metal's real per-pixel storage size,
  distinct from the public `TextureFormat::size`, and is the single place the upload/read-back
  paths compute `bytesPerRow`/buffer sizes from — this also fixed a latent, pre-existing bug
  where `bytesPerRow` was hardcoded to `width * 4` (silently wrong for `RGBA16F`'s 8
  bytes/pixel before this change, and would have been newly unsafe for `RGB8`/`Alpha`).
* A `RenderTarget` texture's pixel-format override (matching the view's `colorPixelFormat` for
  color attachments) was already gated on `TextureFormat::Depth`; unblocking `Depth32` exposed
  the same gate incorrectly overriding a `Depth32` attachment's format, so it was extended to
  exempt both depth formats. This was fixed as tightly coupled to unblocking `Depth32`, per
  the code-change rules in `AGENTS.md`.

### Raw Metal textures

* `Textures` keeps a `RefCell<HashMap<usize, Texture>>` keyed by the caller's texture pointer
  identity, populated lazily (`ensure_raw`) the first time a raw `TextureId` is resolved by any
  `RenderingBackend` method. `synthesize_raw_entry` reads the caller's `MTLTexture`'s real
  `width`/`height`/`pixelFormat`/`mipmapLevelCount` via Objective-C message sends and builds a
  fresh default-filter sampler that miniquad creates and owns.
* **Ownership contract:** miniquad never retains or releases the caller's `MTLTexture`.
  `delete_texture` on a raw id releases only the synthesized sampler and sampler descriptor,
  and stops tracking the entry; the caller remains solely responsible for the texture object's
  lifetime.
* `TryFrom<MTLPixelFormat> for TextureFormat` is a best-effort reverse mapping for this
  introspection only. A caller's texture may use a pixel format miniquad never produces (for
  example `BGRA8Unorm`, a common externally-created-texture/view format); such formats fall
  back to `TextureFormat::RGBA8` so the stored byte-size assumption (4 bytes/pixel) stays safe,
  even though the channel order miniquad then assumes may not match the real layout. This is a
  known, documented limitation, not a silent correctness guarantee.
* `texture_resize` on a raw `TextureId` panics unconditionally with a message explaining that
  miniquad does not own the caller's texture and cannot reallocate it.

### `texture_resize` (managed textures)

Rebuilds the texture's backing `MTLTexture` via a new `new_mtl_texture` helper shared with
`new_texture` (so both paths stay in lock-step on pixel format, storage mode, and usage
flags), releases the old one, updates `params`, and optionally re-uploads `bytes` through the
existing `texture_update_part` path (so it inherits the same format-aware `bytesPerRow`/
conversion logic). Rejects `TextureFormat::Depth` for the reason above.

### `texture_read_pixels`

Generalizes the project's existing test-only `read_rgba8_texture` helper (blit to a
`StorageModeShared` buffer, `commit`+`waitUntilCompleted`, copy out) into production code,
sized from `mtl_storage_bytes_per_pixel`, converting `RGB8`'s 4-byte Metal storage back to its
public 3-byte/pixel contract. Rejects `TextureFormat::Depth` for the reason above. Works
uniformly for managed and raw textures, since both resolve through the same `Textures::get`.

## Effects

* `RGB8`, `Alpha`, and `Depth32` textures now work end-to-end on Metal: creation, CPU upload
  (`RGB8`/`Alpha`), and read-back, at the exact public byte contract.
* `TextureId::from_raw_id(RawId::Metal(..))` now works: binding, `texture_params`,
  `texture_raw_id`, and `delete_texture` all function, with an explicit, tested ownership
  contract (see `TextureId::from_raw_id`'s doc comment).
* `texture_resize` and `texture_read_pixels` are implemented for managed textures of every
  format except `Depth`, and for raw textures' `texture_read_pixels` (not `texture_resize`,
  which is unsupported by design for a texture miniquad does not own).
* `TextureFormat::Depth`'s CPU-upload, read-back, and resize paths are now explicit, tested
  panics instead of `unimplemented!()`/silently-wrong byte math — the documented, testable
  unsupported state the issue requires. `TextureFormat::Depth32` remains the supported
  alternative for any caller that needs a readable/resizable depth texture.
* iOS/tvOS were not tested as part of this change (no such device/simulator was available on
  this host); the Metal-specific storage-mode branches for those targets were left unchanged
  from the pre-existing code and are **not tested** here.
