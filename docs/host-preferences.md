# Host preferences adapter

Status: **STE-aligned draft**. This document describes an optional,
dependency-free browser adapter. It answers issue
[#122](https://github.com/Tigon32/miniquad/issues/122). It uses the
boundary proposed in MADR 0009, "Keep browser adoption tools outside the
core library" (proposed at commit
[`87e8e50`](https://github.com/Tigon32/miniquad/commit/87e8e50), not yet
merged on this branch).

The module is `js/host-preferences.mjs`. It does not import `js/gl.js`,
`js/miniquad.mjs`, or any Miniquad runtime file. It holds no reference to a
canvas. A host application supplies one object, the **application handle**,
and this module reads browser preference signals and forwards a small,
bounded, typed parameter set to that handle.

Miniquad renders drawing commands. It does not supply a widget framework.
Buttons, labels, sliders, status text, and scene descriptions stay in
ordinary semantic HTML, owned by the host page. This module does not create
any DOM element.

## The application handle contract

This adapter calls only these members on the supplied `application` object:

| Member | Type | Called when |
| --- | --- | --- |
| `pause()` | function | Reduced motion is active, or the host sets a "paused" motion override |
| `resume()` | function | Reduced motion is not active, or the host sets a "running" motion override |
| `setParameters(partial)` | function | A validated speed or palette value is ready to apply |
| `supportsParameters` | boolean | Read once before each `setParameters()` call |

This matches the mount handle contract the embedding module exposes:
`{ ready, state, pause(), resume(), focus(), dispose(), setParameters(partial), supportsParameters }`.
This adapter never calls `ready`, `state`, `focus()`, or `dispose()` on the
application; the host owns that part of the lifecycle. Start the handle
already paused when reduced motion is preferred (`mount({..., paused: true})`),
so no frame draws before this adapter or the host has decided a motion
state. Read `window.matchMedia("(prefers-reduced-motion: reduce)").matches`
before calling `mount()` to choose that option.

## `setParameters()` schema

The renderer schema in this version accepts only these keys. No other key is
forwarded, guessed, or faked:

| Key | Type | Bound |
| --- | --- | --- |
| `speed` | finite number | `0` to `2` inclusive |
| `foreground` | `[r, g, b, a]` | each component a finite number, `0` to `1` inclusive |
| `background` | `[r, g, b, a]` | each component a finite number, `0` to `1` inclusive |

Color space: straight (non-premultiplied) linear `[0, 1]` RGBA floats, the
same numeric range a WASM scalar export can read directly. Precedence: a
later call replaces only the keys it contains; omitted keys keep their
previous value in the application.

`validateParameters(partial)` performs this check without any DOM access.
It returns `{ value, errors }`. `value` holds only the keys that passed
validation. `errors` lists every rejected key with a message. An invalid key
is **never** replaced with a default and reported as success: the caller
must treat a reported error as the authoritative result for that key.

```js
import { validateParameters } from "./host-preferences.mjs";

const { value, errors } = validateParameters({ speed: 3 });
// value === {}
// errors === [{ key: "speed", message: "speed must be a finite number in [0, 2], got 3" }]
```

If `application.supportsParameters` is not `true`, or `setParameters` is
missing, this adapter reports an explicit error through `onError` instead of
silently dropping the value. It never invents a fallback command.

## `createHostPreferences()`

```js
import { createHostPreferences } from "./host-preferences.mjs";

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const application = await mount({ container, wasmURL, paused: prefersReducedMotion });

const controls = createHostPreferences({
    element: document.getElementById("scene"),
    application,
    onError(error) {
        document.getElementById("status").textContent = "error: " + error.message;
    }
});

// Later, in response to an ordinary HTML button:
pauseButton.addEventListener("click", () => controls.setMotionOverride("paused"));
resumeButton.addEventListener("click", () => controls.setMotionOverride("running"));

// Before leaving the page or unmounting the scene:
controls.dispose();
```

`createHostPreferences({ element, application, onError, view })`:

* `element` (required): the element whose computed CSS custom properties
  supply the palette (see below).
* `application` (required): the handle described above.
* `onError` (optional): called with an `Error` for every invalid value,
  unsupported command, or invalid override. When omitted, an invalid value
  still surfaces: it is re-thrown on a later microtask instead of being
  swallowed.
* `view` (optional, defaults to `window`): lets a test supply a fake
  `matchMedia`/`getComputedStyle` implementation. A non-browser `view`
  (for example `undefined`) skips all media wiring; the adapter still works,
  with every preference at its default.

Returned handle:

| Member | Behavior |
| --- | --- |
| `getState()` | Returns a snapshot: `colorScheme`, `contrast`, `forcedColors`, `reducedMotion`, `motionOverride`, `lastErrors` |
| `subscribe(listener)` | Calls `listener(state)` on every preference change; returns an unsubscribe function |
| `refreshPalette()` | Re-reads the CSS custom properties now (see "Palette updates" below) |
| `setSpeed(value)` | Validates one speed value and forwards it, or reports the error |
| `setMotionOverride(mode)` | `"auto"` (follow the media query), `"paused"`, or `"running"` |
| `dispose()` | Removes every media-query listener this adapter added |

### Palette: CSS custom properties

The host palette comes from two CSS custom properties, read from the
computed style of `element`:

* `--miniquad-foreground`
* `--miniquad-background`

Each value must be a CSS color this module can parse without executing CSS:
a 3/4/6/8-digit hex color, `rgb()`/`rgba()` with integer or percentage
components, or the `transparent` keyword. Any other syntax, including named
colors other than `transparent` and `currentcolor`, is an explicit error
(`parseCssColor()` throws a `TypeError`; the adapter reports it through
`onError` and does not apply that key).

```css
#scene {
  --miniquad-foreground: #e0e0e0;
  --miniquad-background: #101418;
}
@media (prefers-color-scheme: dark) {
  #scene { --miniquad-background: #000000; }
}
```

### Palette updates

The CSS Custom Properties specification has no "custom property changed"
browser event. This adapter re-reads the palette:

* once, when `createHostPreferences()` is called;
* on every `(prefers-color-scheme: dark)` change (most hosts vary the
  custom property by a `prefers-color-scheme` media query, as in the
  example above);
* whenever the host calls `refreshPalette()` explicitly, for example from a
  manual theme-toggle control.

A host whose palette changes by some other condition (a class toggle not
tied to `prefers-color-scheme`, for example) must call `refreshPalette()`
itself after changing the custom property.

### Motion handling

* On creation, and on every `(prefers-reduced-motion: reduce)` change, the
  adapter calls `application.pause()` when the query matches, and
  `application.resume()` otherwise — unless a motion override is active.
* `setMotionOverride("paused")` / `setMotionOverride("running")` lets the
  host force a state regardless of the media query, for an explicit
  play/pause control. `setMotionOverride("auto")` (the default) restores
  media-query-driven behavior.
* The adapter never calls `pause()`/`resume()` twice in a row for the same
  target state, so a host control and the media query can share the same
  application handle without redundant calls.
* An unknown override value is rejected through `onError`; it does not fall
  back to `"auto"` silently.

### Contrast and forced colors

`state.contrast` reports `"no-preference"`, `"more"`, `"less"`, or
`"custom"` from the `prefers-contrast` media feature. `state.forcedColors`
reports the `(forced-colors: active)` media feature. Neither value is
forwarded to `setParameters()`: **a forced-colors or prefers-contrast match
does not automatically recolor WebGL output.** A host that wants a specific
rendered look in these modes must set `--miniquad-foreground` /
`--miniquad-background` for that mode (for example inside a
`@media (forced-colors: active)` rule) so the existing palette path applies
it.

### Disposal

`dispose()` removes every `matchMedia` listener this adapter added. It is
idempotent. It does not call `application.dispose()`, `pause()`, or
`resume()`: the embedding module release sequence
(see MADR 0009's resource-ownership table) is the host's responsibility, not
this adapter's. Call `dispose()` before discarding `element` or
`application`, and before a page unload that does not already perform teardown.

## URL state (host-only, optional)

`parseHostURLState(search)` validates an optional, narrow, typed set of URL
query values for a host page. This export has no DOM dependency and is not
wired into `createHostPreferences()`; a host decides when and how to read
`location.search` and whether to apply a parsed value.

Recognized keys only:

| Key | Type | Bound |
| --- | --- | --- |
| `scene` | string | pattern `^[a-z][a-z0-9-]{0,31}$` |
| `look` | enum | `"light"`, `"dark"`, `"high-contrast"` |
| `view` | enum | `"default"`, `"debug"` |
| `resolution` | integer | `8` to `56` inclusive, step `4` |
| `speed` | finite number | `0` to `2` inclusive |

Any other key, or any value outside its range, is reported in `errors` and
**never** silently coerced or substituted with a default:

```js
import { parseHostURLState } from "./host-preferences.mjs";

const { values, errors } = parseHostURLState(location.search);
// An unknown key ("camera=orbit") or an out-of-range value
// ("resolution=10", not a multiple of 4) appears in `errors`,
// not in `values`.
if (values.speed !== undefined) {
    controls.setSpeed(values.speed);
}
```

`resolution` is validated for host display only (for example, to show the
requested value next to a visible error when it is invalid). This version
of the shared renderer schema accepts only `speed`, `foreground`, and
`background` through `setParameters()`; `resolution` is not forwarded to the
application. A future resolution parameter needs its own MADR and schema
version, following issue [#19](https://github.com/Tigon32/miniquad/issues/19).

## Tests

* `tests/host-preferences.test.mjs` — unit tests for `validateParameters()`,
  `parseCssColor()`, `parseHostURLState()`, `readPalette()`, and
  `createHostPreferences()` against fake `matchMedia`/`getComputedStyle`
  objects and a recording fake application handle. Run with
  `node --test tests/host-preferences.test.mjs`.
* `tests/browser/host-preferences.spec.mjs` — Playwright tests against a
  self-contained `page.setContent()` fixture. It intercepts one virtual
  module URL and serves the real `js/host-preferences.mjs` source from
  disk, so it needs no shared server route. It covers: pausing before any
  frame when reduced motion is already preferred, a live
  `prefers-reduced-motion` change, palette application from CSS custom
  properties, a visible error for an invalid custom property, the
  `forced-colors` state without a recoloring claim, listener removal after
  `dispose()`, and keyboard-only pause/resume at 320, 1280, and 1440 CSS
  pixel widths. Run with
  `npx playwright test tests/browser/host-preferences.spec.mjs`.

## Limits

* This adapter and its tests do not prove full accessibility or assistive
  technology support. Automated keyboard and DOM assertions are not a
  screen-reader test.
* The browser test project list in `playwright.config.mjs` targets desktop
  Chromium, Firefox, and WebKit. Desktop WebKit does not qualify iOS Safari;
  this document makes no iOS Safari claim.
* `readPalette()` depends on `getComputedStyle`. It cannot observe a custom
  property change by itself; see "Palette updates" above for the exact
  re-read conditions.
* `parseCssColor()` supports a small, explicit grammar. It does not support
  `hsl()`, `lab()`, `color()`, named colors other than `transparent`, or
  `currentcolor`. An unsupported syntax is a reported error, not a guess.
* This adapter does not implement `resolution`, layer, or camera parameters.
  The shared `setParameters()` schema in this version is `speed`,
  `foreground`, and `background` only.
