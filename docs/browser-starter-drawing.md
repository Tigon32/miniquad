# Consuming the optional drawing companion from a generated browser starter

* Date: 2026-11-18
* Scope: a recipe for `scripts/create-browser-project.mjs` output, and the
  proof fixture at `experiments/draw-starter-consumption/`.
* Related issue: [#123](https://github.com/Tigon32/miniquad/issues/123)
* Related guides: [Browser starter generator](browser-starter.md),
  [Drawing companion](drawing-companion.md)
* Writing review: **STE-aligned draft**. Full dictionary review not done.

## Problem

`scripts/create-browser-project.mjs` (issue #124) generates a standalone
Rust and browser project. Its default output depends only on `miniquad`
itself. It never depends on the optional `miniquad-draw` companion
(issue #123). This keeps the default starter free of a dependency most
new projects do not need.

A downstream reader still needs an explicit, tested recipe to add
`miniquad-draw` to a *generated* starter: a fresh external project, not a
copy of either crate's source. This guide supplies that recipe and
names the one trap that breaks the build if skipped.

## The trap: two different `miniquad` crate identities

The generator's `--source git` mode defaults `--rev` to
`f837a98d415262320a8c66ef9f8024d8f2faeab1`. That revision predates the
`miniquad-draw` companion. If a generated project pins `miniquad` at
that old revision, then adds a *separate* `miniquad-draw` dependency
pinned at a newer revision (for example `de6bff785d1ec71bad1b47ef032d19405c6fd7e2`),
Cargo resolves **two different source commits of the same repository**.
`miniquad-draw`'s functions take `&mut miniquad::Context` (and similar
types) from its own pinned `miniquad`. The starter's own `miniquad`
types come from the older pinned commit. Rust treats same-named types
from two different crate source instances as distinct types, so the
generated application fails to compile wherever it passes its own
`miniquad` values into `miniquad-draw`'s API. This is a type-identity
error, not an inefficiency: a `cargo build` run with mismatched
revisions does not "merge" the two copies.

**Rule:** pin `miniquad` and `miniquad-draw` to the exact same `git`
URL and the exact same `rev` in the generated `Cargo.toml`. Never mix a
`miniquad-draw` revision with an older default `miniquad` revision.

## Recipe

1. Generate the starter as usual, but override `--rev` to a revision at
   or after `miniquad-draw`'s existence (the companion landed by
   `e998693`, so revision `de6bff785d1ec71bad1b47ef032d19405c6fd7e2` or
   later public `master` both qualify):

   ```sh
   node scripts/create-browser-project.mjs /path/to/destination \
     --source git \
     --git-url https://github.com/Tigon32/miniquad.git \
     --rev de6bff785d1ec71bad1b47ef032d19405c6fd7e2 \
     --git-repo /path/to/a/local/miniquad/clone
   ```

2. Add `miniquad-draw` to the generated `Cargo.toml`'s `[dependencies]`
   table, with the **same** `git` URL and the **same** resolved `rev`
   the generator printed for `miniquad`:

   ```toml
   [dependencies]
   miniquad = { git = "https://github.com/Tigon32/miniquad.git", rev = "de6bff785d1ec71bad1b47ef032d19405c6fd7e2" }
   miniquad-draw = { git = "https://github.com/Tigon32/miniquad.git", rev = "de6bff785d1ec71bad1b47ef032d19405c6fd7e2" }
   ```

3. Replace the body of `src/main.rs`'s `draw()` (and the one-off vertex
   and buffer setup in `Stage::new()`) with calls to `miniquad-draw`'s
   public API only (`Batch`, `Color`, `Rect`, `Renderer`, `Transform2D`),
   following the same shape as the existing path-dependency reference
   fixture at `experiments/drawing-comparison/external-consumer/examples/consume.rs`.
   Do not copy any file from `companions/draw/`; only call its exported
   functions and types.

4. Rebuild with the generated project's own `node scripts/build.mjs`
   (unchanged — it only invokes `cargo build --release --target
   wasm32-unknown-unknown` and copies the resulting `.wasm`).

## Which optional host controls remain available

The generated `web/index.html` already guards its "Parameters" controls
behind `app.supportsParameters`, which the embedding module
(`js/miniquad.mjs`) computes by checking for the three `mq_params_*`
WASM exports (see `docs/browser-starter.md`). A drawing-companion
application written against step 3 above has no reason to keep those
exports, because batch-drawn scenes do not use the starter's single
tint/clear-color parameters the same way.

* **Unavailable:** the "Animation speed", "Foreground color", and
  "Background color" controls. With the `mq_params_*` exports absent,
  `app.supportsParameters` is `false`, so the generated page disables
  the "Parameters" `<fieldset>` automatically. No host-page edit is
  needed for this: the existing template already handles the
  `supportsParameters === false` case.
* **Still available, unchanged:** "Pause", "Resume", and "Focus".
  `js/miniquad.mjs`'s `pause()`, `resume()`, and `focus()` call the
  WASM instance directly (`instance.pause()` / `instance.resume()` /
  `instance.focus()` plus `frame.focus()`); they do not depend on the
  `mq_params_*` exports or on any drawing-specific code. The host-URL
  `speed` query parameter and reduced-motion start-paused behavior keep
  working for the same reason.

## Proof fixture

`experiments/draw-starter-consumption/generate-fixture.mjs` performs the
recipe above against this repository's own HEAD commit (resolved with
`git rev-parse HEAD`, not a hard-coded SHA), so the proof always targets
a revision this checkout can actually verify. It writes the generated
project into the existing, already-ignored
`.generator-test-scratch/` directory (see `.gitignore` and
`tests/starter-generator.test.mjs`) and builds it for
`wasm32-unknown-unknown`.

`experiments/draw-starter-consumption/serve-starter-drawing.mjs` serves
that generated project's `web/` directory, standalone, on port 4282 (a
private port distinct from the root fixture's 4173 and the drawing
companion's own 4280/4281).

`tests/browser/draw-starter-consumption.spec.mjs` loads the generated
page through that private server and Playwright config
(`experiments/draw-starter-consumption/playwright.config.mjs`), and
asserts three explicit, non-blank pixel colors sampled from the
rendered canvas (background, rectangle, circle) in Chromium, Firefox,
and WebKit — not a single blank-frame hash check. It also asserts that
`app.supportsParameters` is `false` and that `pause()` / `resume()` /
`focus()` still succeed, matching the "which controls remain available"
section above.

Run it with:

```sh
node experiments/draw-starter-consumption/generate-fixture.mjs
npx playwright test --config experiments/draw-starter-consumption/playwright.config.mjs
```

## Out of scope

This guide does not add a new `--source`/`--rev`-adjacent flag to
`scripts/create-browser-project.mjs` for adding `miniquad-draw`
automatically. The two-dependency recipe above is a small, manual,
fully-explained edit; a generator flag is not needed to prove the
consumption path works. It also makes no native-rendering claim (the
proof fixture only exercises the browser/WASM target), reruns no
performance comparison, and changes no root workflow, route, package
manifest, or glossary entry; root CI integration (adding this fixture's
commands to an existing or new workflow) is tracked separately.
