# Support a bounded set of modern, security-maintained platforms

* Status: **Proposed**
* Date: 2026-11-11
* Tracking: [#156](https://github.com/Tigon32/miniquad/issues/156); related [#19](https://github.com/Tigon32/miniquad/issues/19), [#154](https://github.com/Tigon32/miniquad/issues/154), [#142](https://github.com/Tigon32/miniquad/issues/142), [#143](https://github.com/Tigon32/miniquad/issues/143), [#144](https://github.com/Tigon32/miniquad/issues/144)
* Source: `1364b6db83c5409cd1190856fbd5b1c8d1c5e0f3`
* Scope: operating systems, CPU types, browsers, graphics backends, CI runners, and legacy code removal
* Guide: [Platform support policy](../platform-support-policy.md)
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

## Context and Problem Statement

The fork has no platform support policy.
The README lists the upstream platform targets. That list is not a test record.
The source contains code paths for old graphics APIs and old platforms.
Examples: the Apple OpenGL default, the WebGL1 default, GLX fallback, tvOS `cfg` branches, and 32-bit Arm CI.

The owner wants modern, reliable platforms with good performance.
The owner does not want to keep old platforms only for compatibility.
Old platforms often stop receiving vendor security updates.

An old version is not proof of an applicable CVE.
A new version is not proof of better speed or reliability.
Only tests on the applicable platform give that proof.

Which platforms do we support, and how do we remove the code for the other platforms safely?

## Decision Drivers

* Support only OS versions that receive vendor security updates.
* Prefer modern graphics APIs: Metal, Direct3D 12 or Vulkan through WebGPU, and WebGPU in browsers.
* Keep a small CI cost ([MADR 0005](0005-low-cost-ci-and-risk-based-test-lanes.md)).
* Use supported tools ([MADR 0007](0007-use-supported-and-secure-toolchains.md)).
* Make a support claim only with test evidence on the applicable OS, CPU, browser, and GPU.
* Remove dead legacy code. Do not keep a hidden fallback or a permanent legacy default.
* Do not delete production code before a replacement is proved.
* Keep the Rust MSRV `1.70` until a separate decision changes it.
* Keep strict WebGPU startup with no automatic WebGL fallback (MADR 0015, Proposed, [#154](https://github.com/Tigon32/miniquad/issues/154)).

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Keep all historical platforms | No consumer loses a platform | Untested claims. Old APIs and unsupported OS versions stay. High test cost. |
| Support only the newest OS release | Smallest matrix | Vendors also patch the previous major. Users update at different times. A new release can have new faults. |
| **Rolling window of vendor-maintained OS versions with modern GPU APIs and bounded CI** | Security-maintained platforms, modern graphics, controlled test cost | Needs regular review and real hardware tests. Some users lose old platforms. |

## Decision Outcome

**Proposed:** use the rolling window.
The [platform support policy](../platform-support-policy.md) gives the initial matrix, tiers, and gates.

### Support tiers

| Tier | Meaning |
| --- | --- |
| **QUALIFIED** | In the policy, and a recorded test on that platform passed for the release candidate. |
| **TARGETED** | In the policy. The project accepts bugs and plans tests. No qualified result yet. |
| **LEGACY** | Code still exists only during a planned replacement. No new features. Each item has a removal gate. |
| **UNSUPPORTED** | Not in the policy. No support claim. Code for it is a removal candidate. |

The tier is a **policy** value.
The test status is a **separate observed** value: Pass, Fail, Not tested, or Blocked.
A TARGETED platform with no test has status **Not tested**.
Do not report a TARGETED platform as QUALIFIED.

### Separate the four version types

1. **OS major baseline.** The oldest OS major that the policy includes. It changes only at a policy review.
2. **OS security patch level.** Tests use the latest vendor patch for each included major. The policy does not store an exact patch minimum, because it becomes old quickly.
3. **Rust MSRV and development tools.** These follow MADR 0007. An OS change does not change the MSRV.
4. **Browser version.** This follows the browser window in the guide. It is not tied to the OS baseline, except for Safari.

### Initial baseline (proposal)

* **macOS:** the two newest macOS majors that receive Apple security updates, on Apple silicon (`aarch64-apple-darwin`). On 2026-11-11 this is macOS 27 and macOS 26. Intel Macs are UNSUPPORTED.
* **Windows:** Windows 11 versions in Microsoft servicing for Home and Pro editions, x64. ARM64 is TARGETED. Windows 10 is UNSUPPORTED.
* **Linux native:** glibc distributions in standard security support, x86_64 and aarch64: Ubuntu 24.04 LTS, Ubuntu 26.04 LTS, and Debian 13. Glibc floor: 2.39. A supported OS does not guarantee a supported GPU driver or backend.
* **Browsers:** the current, security-patched stable release of Chrome, Edge, and Firefox. A previous major is allowed only as a bounded transition exception while the vendor still patches it. Safari 26 or later on a supported macOS or iOS release. ESR and extended channels are out of the initial scope. A locked CI browser build is test evidence for its exact version only. WebGPU support depends on the browser, OS, and adapter.
* **iOS and Android native:** UNSUPPORTED until an owner supplies device tests. The code stays only until its Keep or Remove classification.

### Apple graphics

Apple deprecated OpenGL in macOS 10.14 and OpenGL ES in iOS 12.
The Apple default `AppleGfxApi::OpenGl` is LEGACY.
Do **not** make Metal the default before [#142](https://github.com/Tigon32/miniquad/issues/142),
[#143](https://github.com/Tigon32/miniquad/issues/143), and [#144](https://github.com/Tigon32/miniquad/issues/144) pass on real hardware.
After those gates and a versioned release, remove the Apple OpenGL path and the selector.

### Browser graphics during the WebGPU transition

MADR 0015 keeps the current default during its proof and forbids an automatic WebGL fallback.
This decision adds a removal plan for WebGL:

1. **WebGL1** is LEGACY now. Remove it first, after WebGL2 has the same tested behavior.
2. **WebGL2** stays as an explicit, labeled selector only during the WebGPU transition.
3. Remove the WebGL selector and `js/gl.js` WebGL code when **all** conditions are true:
   * WebGPU passes the parity tests for the public rendering API.
   * A PR freezes the post-removal browser matrix: each browser, OS, and CPU row that stays TARGETED or QUALIFIED.
   * WebGPU is QUALIFIED on real hardware on **every** row in that frozen matrix.
   * Each row that the removal drops has its own versioned policy decision. A row that is not tested is not dropped by default.
   * One versioned release contains WebGPU as the default and WebGL as a deprecated explicit selector, with migration notes.
   * No open P1 WebGPU regression exists.
4. Do not use a calendar date alone as the removal trigger.
5. After removal, a browser without a WebGPU adapter gets an explicit unsupported error. Linux browsers without vendor WebGPU support become UNSUPPORTED for this reason.

### Legacy removal rule

The guide lists the items. Each item has its own bounded PR and does not wait for other items.
First, record the inventory and classify the item as **Keep** (intentional supported compatibility) or **Remove** (dead legacy).
Then use one of two flows:

* **Flow A — remove a platform with no replacement.** A versioned policy decision drops the OS, CPU, or target.
  Dropping a public OS or CPU is a compatibility change, also when no API item changes.
  Give migration notes. Then delete the code, configuration, dependencies, tests, and documents.
* **Flow B — replace a backend or path.** Prove the replacement on every retained row that used the old path.
  Release one version with the new default and the old selector as an explicit deprecated value, with migration notes.
  Then delete the selector and the old path. No silent change of backend.

Both flows end with the gates for the remaining matrix and a change log entry.

### Exceptions

An exception keeps an item outside this policy for a limited time, as in MADR 0007.
Each exception records the item, reason, owner, applicable advisory review, review date, and expiry.
An exception without an owner or expiry is not valid.

Do not keep an item only because an old consumer could use it.
Do not keep a hidden fallback or a permanent legacy default.
A removal of a public API item is a breaking change. It follows the SemVer decision in [#19](https://github.com/Tigon32/miniquad/issues/19).

## Consequences

### Positive

* Support claims match test evidence.
* Less old code, fewer dependencies, and a smaller attack surface.
* Modern GPU APIs become the main path.

### Negative

* Users on Intel Macs, Windows 10, older Linux distributions, and browsers without WebGPU lose support.
* Real hardware tests on macOS, Windows, and physical mobile devices need owners and time.
* Breaking releases need migration work by consumers.

## Confirmation

1. The owner reviews and accepts or changes this proposal.
2. An inventory PR records Keep or Remove and Flow A or B for each item in the guide.
3. Each removal PR links this MADR, #156, and its replacement evidence.
4. A policy review runs at each new OS major or browser WebGPU change, and before each release.

This proposal does not remove code, change a default, change CI, or change the MSRV.

## Observed Evidence

Sources were checked on 2026-11-11. The guide lists the exact sources.

* Apple security releases list macOS Golden Gate 27.2.1, macOS Tahoe 26.7.3, and macOS Sequoia 15.8.3 on 2026-11-09. The last listed macOS Sonoma update is 14.8.9 on 2026-08-06.
* Apple lists macOS 27 for Apple silicon Macs and MacBook Neo only. macOS 26 also includes some Intel Macs.
* Microsoft lists Windows 11 25H2, 26H1, and 26H2 in Home and Pro servicing. Windows 10 Home and Pro support ended on 2025-10-14.
* The gpuweb implementation status page lists WebGPU in Chrome 113 on macOS and Windows, Firefox 141 on Windows, Firefox 145 on macOS 26 Apple silicon, and Safari 26. Linux support is partial.
* The Rust platform support page lists `aarch64-apple-darwin` at Tier 1 and `x86_64-apple-darwin` at Tier 2.

Apple does not publish an end-of-support date for macOS.
The macOS window uses the observed security release list.

## References

* [Platform support policy](../platform-support-policy.md)
* [Native platform qualification](../native-platform-qualification.md)
* [Browser release qualification](../release.md)
* [MADR 0005 — Low-cost CI](0005-low-cost-ci-and-risk-based-test-lanes.md)
* [MADR 0007 — Supported tools](0007-use-supported-and-secure-toolchains.md)
* MADR 0015 — Proof-gated WebGPU migration (Proposed, tracked in [#154](https://github.com/Tigon32/miniquad/issues/154))
