# Add drawing to a generated browser starter

Date: 2026-11-11. Related issue: [#123](https://github.com/Tigon32/miniquad/issues/123).
**STE-aligned draft.** Full dictionary review not done.

The [starter generator](browser-starter.md) selects only Miniquad by default.
You can add the optional [drawing companion](drawing-companion.md) without
copying its geometry, shader, or GPU implementation.

## Use one source revision

Pin `miniquad` and `miniquad-draw` to the same Git URL and full source SHA.
The default starter revision, `f837a98d415262320a8c66ef9f8024d8f2faeab1`,
does not contain the drawing companion.
Do not combine that revision with a newer drawing dependency.
Cargo treats the two Miniquad source instances as different crates.
Their `miniquad::RenderingBackend` traits are not interchangeable.

The commands below use public source
`de6bff785d1ec71bad1b47ef032d19405c6fd7e2`.
This is an evaluation pin, not a release-qualified version.

## Recipe

From a Miniquad checkout, generate a new external project:

```sh
git fetch --no-tags https://github.com/Tigon32/miniquad.git \
  de6bff785d1ec71bad1b47ef032d19405c6fd7e2
node scripts/create-browser-project.mjs ../my-drawing-app \
  --source git \
  --git-url https://github.com/Tigon32/miniquad.git \
  --rev de6bff785d1ec71bad1b47ef032d19405c6fd7e2 \
  --git-repo "$(pwd)"
```

In the generated `Cargo.toml`, keep both dependencies in `[dependencies]`:

```toml
[dependencies]
miniquad = { git = "https://github.com/Tigon32/miniquad.git", rev = "de6bff785d1ec71bad1b47ef032d19405c6fd7e2" }
miniquad-draw = { git = "https://github.com/Tigon32/miniquad.git", rev = "de6bff785d1ec71bad1b47ef032d19405c6fd7e2" }
```

Replace the generated application's `src/main.rs` with the complete
[consumer example](../experiments/drawing-comparison/external-consumer/examples/consume.rs):

```sh
cp experiments/drawing-comparison/external-consumer/examples/consume.rs \
  ../my-drawing-app/src/main.rs
node ../my-drawing-app/scripts/build.mjs
node ../my-drawing-app/scripts/serve.mjs --port 8080
```

Open `http://localhost:8080/`.
The example calls the package's public API to draw a rectangle and a circle.
Only application code is copied. The package implementation stays a dependency.
The default generator and its templates do not change.

## Host controls

This example does not export the optional `mq_params_*` functions.
The generated host therefore disables Animation speed, Foreground color,
and Background color. Its `speed` query parameter cannot change this example.
An application can implement the optional parameter contract if it needs these
controls.

Pause, Resume, Focus, and reduced-motion start-paused behavior use the runtime
frame's lifecycle controls. They do not need the optional parameter exports.
DOM text and controls remain the browser default.

## Repeatable proof

```sh
node experiments/draw-starter-consumption/generate-fixture.mjs
npx playwright test --config experiments/draw-starter-consumption/playwright.config.mjs
```

The script fetches the fixed public SHA above. It uses that SHA for the
generated browser assets, both Git dependencies, and the sample application.
It does not use a local unpublished HEAD or a temporary CI merge revision.
It builds with the generated project's own `scripts/build.mjs`.

The output is `.generator-test-scratch/draw-starter-consumption-proof/`.
The script refuses to overwrite an existing destination.
Move a previous proof directory out of that path before you generate another.
The private Playwright configuration starts the generated server on port 4282.
It stops that server after the tests.

Chromium, Firefox, and desktop WebKit test three interior pixel colors with
a tolerance of two channel values. They also test disabled parameter controls,
Pause, Resume, Focus, and browser error output.
The private test stays outside the root browser fixture.
CI runs it as a separate check step.

This proof does not qualify a release, mobile browsers, native rendering,
performance, or long-running memory use.
