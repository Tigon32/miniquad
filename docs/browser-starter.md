# Browser consumer starter

Status: **generator and external consumer implemented and
browser-tested at one reviewed revision; not release qualified**.
Addresses [issue #124](https://github.com/Tigon32/miniquad/issues/124)
(closed). Implemented by [#125](https://github.com/Tigon32/miniquad/pull/125);
browser-tested by [#127](https://github.com/Tigon32/miniquad/pull/127).
Depends on the optional browser adoption layer recorded in
[MADR 0009](adr/0009-optional-browser-adoption-layer.md) (status:
proposed; the layer's files already exist and are tested, the MADR's
own acceptance record is what is still open) and on
[#19](https://github.com/Tigon32/miniquad/issues/19) for release
identity and distribution.

Miniquad is a Rust library for windows, input, and graphics. It is not
a game engine, and it is not a replacement for Canvas 2D. Use Miniquad
when an application needs direct GPU drawing commands across
platforms. Use a higher-level graphics or game library when an
application needs scene graphs, asset pipelines, or UI widgets. Use
Canvas 2D when an application only needs simple 2D drawing in a
browser and does not need a shared native/WASM renderer.

## What the generator produces

`scripts/create-browser-project.mjs` writes a fresh, standalone,
external Rust and browser project. It does not live inside, or depend
on, the Miniquad repository at run time. The generated project has:

- `Cargo.toml` and `src/main.rs`: a small Rust application that draws
  one animated quad. It exports an optional, bounded "app parameters"
  surface (see below). This is a reusable quad structure, not a game
  engine.
- `web/index.html`: a semantic host page with a status region, an
  embedded host `<div>`, and pause/resume/focus controls, plus
  animation-speed and color controls. The controls call the host
  preference adapter (`createHostPreferences`, see below), not
  `setParameters` directly.
- `web/gl.js`, `web/miniquad.mjs`, `web/runtime.html`,
  `web/runtime.mjs`, `web/host-preferences.mjs`: exact copies of the
  browser bridge and optional embedding module, taken from one
  selected Miniquad source revision. `web/MANIFEST.json` records a
  SHA-256 hash and byte count for each copied file.
- `scripts/build.mjs`: builds the Rust application for
  `wasm32-unknown-unknown`, copies the result into `web/app.wasm`, and
  then adds `app.wasm` and `index.html` entries (hash and byte count)
  to `web/MANIFEST.json`, alongside the five entries the generator
  already wrote. This binds the shipped, built bytes to the same
  manifest that records where the source files came from.
- `scripts/serve.mjs`: a traversal-safe static HTTP server with
  correct MIME types (including `application/wasm`) and subpath
  support, for local development or for serving the built output
  directly.

Only `scripts/build.mjs` and `scripts/serve.mjs`, Cargo, and the Rust
toolchain (including the `wasm32-unknown-unknown` target) are
developer-only tools: a developer generating or building the project
needs Node.js and Rust installed. The deployed `web/` output needs
only a browser; it does not need Rust or Node.js at the user's device.

## Commands

```sh
# From a Miniquad checkout, generate an external project next to it:
node scripts/create-browser-project.mjs ../my-app \
  --source path --miniquad-path "$(pwd)" --name my-app --title "My App"

cd ../my-app
node scripts/build.mjs
node scripts/serve.mjs --port 8080
# Open http://localhost:8080/
```

Deploy by copying the generated project's `web/` directory to a static
host. Serve it from a subpath with
`node scripts/serve.mjs --port 8080 --base /my-app`.

## Dependency pinning

The generator never silently depends on the original upstream project
(`not-fl3/miniquad`). It requires one explicit source:

- `--source path --miniquad-path <absolute path>`: a Cargo `path`
  dependency on a local checkout. Use this for local development. The
  generator also reads the five browser files above from
  `<path>/js/`.
- `--source git --git-url <url> --rev <sha> --git-repo <absolute path
  to a local clone with that revision>`: a Cargo `git` dependency
  pinned to an immutable revision (`rev = "<sha>"`), for evaluation.
  `--git-repo` lets the generator read the exact browser file bytes
  for that revision with `git show <rev>:<path>`, without an
  additional network fetch during generation. `--rev` may be short or
  symbolic; the generator resolves it to a full 40-character commit
  SHA with `git rev-parse --verify` against `--git-repo` and fails if
  that does not succeed. The resolved SHA, not the input, is what is
  pinned in `Cargo.toml` and read from with `git show`. `--rev`
  defaults to the reviewed, immutable, publicly available revision
  `f837a98d415262320a8c66ef9f8024d8f2faeab1` (the first revision with
  all five required browser files; see "Evidence and tested scope"
  below); the default `--git-url` is the `Tigon32/miniquad` fork, not
  upstream. An explicit `--rev` to a different revision that has all
  five required files still works.

Issue #19 owns the long-term SemVer and release identity for this
dependency; the pinning options above are an interim, explicit,
evaluation path and are not a release process.

## Manifest provenance: no local paths or credentials ship

`web/MANIFEST.json`'s `source` field is sanitized provenance only:
`{ "mode": "path" | "git", "sha": <string|null>, "dirty": <boolean> }`.
It never contains the absolute `--miniquad-path` checkout location,
the `--git-url`, or any other local-machine or credentialed detail,
because this file ships with the deployed project. For `--source
path`, `sha` is the resolved commit (`null` if the checkout is not a
git repository or `git rev-parse` fails); `dirty` is `true` only when
that checkout has uncommitted local changes. For `--source git`, the
generator resolves `--rev` with `git rev-parse --verify` against
`--git-repo` and refuses to continue unless that resolves to a full
40-character commit SHA; this resolved SHA, not the possibly short or
symbolic `--rev` the caller passed, is what is pinned in the generated
`Cargo.toml` and recorded in the manifest, and it is also what `git
show <sha>:<path>` reads browser asset bytes from, so the pinned
dependency and the copied bytes cannot drift apart. `dirty` is always
`false` for a `git` source, since that read is always of exact,
immutable committed bytes. A human-readable label with the local path
is printed to the console during generation, but is not written to
any file.

## Evidence and tested scope

`node scripts/create-browser-project.mjs <dest> --source git --git-repo
<local clone>` (no `--rev`) resolves to, and copies exact asset bytes
from, `f837a98d415262320a8c66ef9f8024d8f2faeab1`: the first reviewed,
immutable, publicly available `Tigon32/miniquad` revision with all
five required browser files. An explicit `--rev <other sha>` that also
has all five files still works; the generator does not special-case
the default revision. `tests/starter-generator.test.mjs` asserts the
resolved default SHA, the pinned `Cargo.toml` dependency, and every
copied asset's bytes against `git show <sha>:<path>`, not only a
recorded hash constant, so it fails if the default ever points back at
a revision missing a required file.

What is tested at `f837a98d415262320a8c66ef9f8024d8f2faeab1`,
end to end, against a freshly generated external consumer
(`tests/browser/starter.spec.mjs`, run across pinned Chromium,
Firefox, and desktop WebKit as part of the repository's combined
141-test browser suite; 18 of those 141 cases are starter-specific,
6 per engine. The other 123 cases qualify unrelated Miniquad browser
behavior, not this starter):

- The generated project builds and serves under a deployment subpath,
  and real WASM parameter changes (speed, foreground/background color)
  reach the compiled module.
- A visible, non-silent error is shown when WASM startup fails.
- High-DPI (device pixel ratio 2) drawing, canvas resize, and canvas
  and keyboard control focus.
- Reduced-motion start-paused behavior, the host preference adapter's
  palette refresh, and `forced-colors` handling, at 320px, 1280px, and
  1440px widths.

What is also verified, but not through a browser:

- The generated `Cargo.toml` and `src/main.rs` compile to
  `wasm32-unknown-unknown` through a `path` dependency, and the
  resulting WASM module exports `mq_params_version`,
  `mq_param_set_f32`, and `mq_param_set_rgba8` (checked by inspecting
  the compiled module's export list). Core ABI v3 is unchanged by any
  of this.
- The static server serves correct MIME types, supports a subpath
  base, and keeps every request inside the web root, including with
  `..` segments and percent-encoded separators (checked with raw HTTP
  requests against a running server, not only an HTTP client that
  pre-normalizes the URL).
- Generator preflight and project-writing logic
  (`tests/starter-generator.test.mjs`), including the default-revision
  regression test above.

What this change does not qualify:

- A release-qualified, versioned dependency; issue #19 still owns
  SemVer and release identity, and the `git`-pinned dependency above is
  an interim, explicit, evaluation path, not a release process.
- Mobile browsers or native (non-browser) targets.
- Long-running memory reclamation; the browser suite above is a single
  bounded run, not a soak test.

## Optional app-parameters surface

The generated application exports a small, optional surface. It is
not part of the Miniquad core ABI:

| Export | Meaning |
| --- | --- |
| `mq_params_version() -> u32` | Returns `1`. A host checks this once after startup. |
| `mq_param_set_f32(id: u32, value: f32) -> i32` | `id` 1 sets animation speed, range `0..=2`. Returns `0` on success, `1` for a non-finite or out-of-range value, `2` for an unknown `id`. |
| `mq_param_set_rgba8(id: u32, color: u32) -> i32` | `id` 1 sets the foreground tint, `id` 2 sets the background clear color. `color` is `0xRRGGBBAA`, straight alpha, sRGB bytes. Returns `0` on success, `2` for an unknown `id`. |

A host page calls these through the `setParameters` function on the
`mount()` result, once `supportsParameters` is `true`. The embedding
module `miniquad.mjs` (not owned by this document; see MADR 0009)
performs the float-range validation and RGBA8 packing before calling
these exports.

## Host preference adapter wiring

`web/index.html` does not call `setParameters` directly. It calls
`createHostPreferences` (from `web/host-preferences.mjs`, not owned by
this document) once, right after `app.ready` resolves, and routes its
own controls through the returned adapter instead:

- Mounts with `paused: window.matchMedia("(prefers-reduced-motion:
  reduce)").matches`, so a reduced-motion host never auto-starts the
  animation.
- The Pause/Resume buttons call `adapter.setMotionOverride("paused")`
  / `adapter.setMotionOverride("running")`; they never call
  `app.pause()` / `app.resume()` directly.
- The speed slider calls `adapter.setSpeed(value)` on both `"input"`
  and `"change"`.
- The foreground/background color inputs set the
  `--miniquad-foreground` / `--miniquad-background` CSS custom
  properties on `<html>`, then call `adapter.refreshPalette()`, also
  on both `"input"` and `"change"`. Both events are bound because
  native color pickers and automation drivers are inconsistent: some
  only fire `"input"` while the picker is open, some only fire
  `"change"` on commit. The stylesheet also sets those two properties
  under `prefers-color-scheme: light`, `prefers-contrast: more`, and
  `forced-colors: active`; because the adapter only re-reads the
  palette on its own for `prefers-color-scheme`, this page adds its
  own `prefers-contrast` and `forced-colors` listeners that call
  `adapter.refreshPalette()` so those two also take visible effect.
- `app.frame`'s `"miniquaderror"` event (for example a lost WebGL
  context) and `adapter`'s `onError` callback both route to the same
  visible status-region error display; nothing fails silently.
- Only the `speed` key from `parseHostURLState(location.search)` is
  applied (via `adapter.setSpeed`). The adapter also recognizes
  `scene`, `look`, `view`, and `resolution` for richer hosts; this
  starter has no such scenes or views, so it does not read, validate,
  or expose those keys.
- `pagehide` disposes the adapter, then the application, in that
  order.
