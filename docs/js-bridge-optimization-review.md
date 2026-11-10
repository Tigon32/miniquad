# Browser JavaScript bridge delivery and timing review

* Review date: 2026-11-10
* Tracking: [#15](https://github.com/Tigon32/miniquad/issues/15)
* Baseline: [PR #106](https://github.com/Tigon32/miniquad/pull/106), exact tested head `4f6aadaad008688128da957abbda6521ab15c8ed`
* Status: **Source and baseline review; no measured size or startup improvement is claimed**

## Actual baseline receipts

The trusted integration run [42895931094](https://github.com/Tigon32/miniquad/actions/runs/42895931094)
recorded the checked-in `js/gl.js`: 76,356 raw bytes, 16,684 gzip-9
bytes and 13,983 Brotli-11 bytes. The matching quad WASM was 114,018
raw, 44,906 gzip and 37,427 Brotli bytes. This is a source-hashed build
receipt, **not** the HTTP network payload captured from a CDN.

The same run observed a first WASM frame callback of approximately 47.6 ms
on a Playwright Chromium Linux CI runner. This callback is not the first
visibly painted pixel. [Three-engine acceptance run
42895931151](https://github.com/Tigon32/miniquad/actions/runs/42895931151)
measured approximately 33.9 ms in Chromium, 97 ms in Firefox and
120 ms in desktop WebKit under different scheduled CI samples.
Those **single-run** samples cannot justify a performance improvement claim
or a production startup SLO.

## Options reviewed

| Option | Expected benefit | Compatibility and measurement concern | Decision |
| --- | --- | --- | --- |
| Keep local unbundled `js/gl.js` | Readable source, direct stack traces, no runtime packaging dependency | At about 76 KiB raw, further transfer savings are possible | **Retain as required reference bridge** |
| Split loader and GL imports | Could avoid downloading optional implementation fragments | The loader still requires all imports for a compiled WASM module; extra HTTP request/caching and initialization order need measurement | **Do not split speculatively** |
| Minification | May save JS transfer bytes | Require pinned vetted minifier, source maps, ABI import-name preservation and a before/after browser matrix | **Candidate only; no unmeasured promotion** |
| Dead-code removal or generated import pruning | Could reduce bytes when the actual compiled import list is known | May remove functions used by another Rust example or optional plugin; compiled-module import verification must remain strict | **Keep generic bridge until measured fixture-matrix parity** |
| More informative loader errors | Reduces startup diagnosis cost | Must not convert a missing mandatory import into a dummy callback | **Already implemented and tested** |
| Monotonic epoch clock | Prevents backward time jumps when wall-clock changes | New precision behavior must preserve epoch-second units and Firefox reduced precision | **Scoped improvement under test** |

The supported browser loader uses ABI v3 and requires matched JS/WASM
artifacts. Browser fixture tests cover absent canvas, missing or mismatched
module/import, HTTP failure, concurrent startup, retry and input/clipboard
isolation in actual Chromium, Firefox and WebKit.

## Time contract

Miniquad's Rust `date::now()` imports `now` in **Unix epoch seconds**.
A raw `Date.now()` reading can move backward after a system-clock change.
For environments supporting `performance.timeOrigin` and
`performance.now()`, the JS bridge can form epoch-aligned monotonic
seconds while preserving the return unit. A non-finite or unavailable
performance source falls back to `Date.now()` when valid; the returned
value is clamped to the last recorded reading so it does not decrease.

Browser privacy modes can quantize `performance.now()` and
`Date.now()`; repeated readings may be identical. The contract guarantees
**nondecreasing results**, not submillisecond resolution or a bound on
timer jitter. `tests/js-clock.test.cjs` explicitly simulates quantization,
backward readings, fallback and invalid source values.

The separate `firefox-privacy-clock.yml` job runs actual Playwright Firefox
with `privacy.resistFingerprinting` and `privacy.reduceTimerPrecision`
preferences enabled. It loads a standalone browser bridge without creating
a GPU context, collects 300 epoch readings before and after a delay, and
requires finite, nondecreasing, advancing values with epoch alignment.
A passing test establishes only the selected Firefox engine/build and
privacy preference setting in Linux CI. It is not real-device permission,
timing-resolution or mobile Safari qualification.

## Promotion and remaining work

No production JavaScript source map, minified artifact, or production
transfer-time A/B receipt is produced by this review. A later experiment
must use the same source head, pinned toolchain, generated source map,
source-linked output hashes, measured Brotli+gzip changes, cold-start
variability and all three browser runtime tests before replacing
`js/gl.js`. Do not describe the **clock correctness fix** as a throughput
or download-size speedup.

The full SLI/SLO terminology and release-gate rules are in
[browser-performance-sli-policy.md](browser-performance-sli-policy.md).
Physical iOS Safari, Android Chrome, Firefox privacy-mode configurations
on consumer devices and real CDN delivery remain unqualified here.
