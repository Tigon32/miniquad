# Platform support policy

* Status: **Proposed** by [MADR 0016](adr/0016-modern-platform-support-policy.md). Not a release approval.
* Tracking: [#156](https://github.com/Tigon32/miniquad/issues/156)
* Source: `1364b6db83c5409cd1190856fbd5b1c8d1c5e0f3`
* Sources checked: 2026-11-11
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

This guide gives the proposed platform matrix, the support window, and the legacy removal plan.
No platform is **QUALIFIED** at this source revision.
This guide does not remove code or change a default.

## Tiers and test status

| Tier | Meaning |
| --- | --- |
| **QUALIFIED** | In the policy. A recorded test on that platform passed for the release candidate. |
| **TARGETED** | In the policy. Bugs are accepted. Tests are planned. No qualified result yet. |
| **LEGACY** | Code exists only during a planned replacement. No new features. Has a removal gate. |
| **UNSUPPORTED** | Not in the policy. No support claim. Code for it is a removal candidate. |

Test status is separate: **Pass**, **Fail**, **Not tested**, or **Blocked**.
The tier tells what the project intends. The status tells what a test observed.

## Three separate roles

| Role | Meaning | Policy |
| --- | --- | --- |
| **Consumer OS** | The OS where an application that uses Miniquad runs | The matrix below |
| **Developer host** | The computer that builds and tests | A Consumer OS row at TARGETED or higher, with the current stable Rust toolchain |
| **CI runner** | A hosted or local runner image | An explicit image label with a published support date ([MADR 0007](adr/0007-use-supported-and-secure-toolchains.md)) |

The Rust MSRV stays `1.70` (`Cargo.toml` `rust-version`).
An OS or browser change does not change the MSRV.

## Native consumer matrix (proposed initial)

| Platform | CPU | Tier | Graphics | Test status at `1364b6d` |
| --- | --- | --- | --- | --- |
| macOS current major (27) | Apple silicon | TARGETED | Metal after [#142](https://github.com/Tigon32/miniquad/issues/142)–[#144](https://github.com/Tigon32/miniquad/issues/144) | Not tested |
| macOS previous major (26) | Apple silicon | TARGETED (minimum major) | Same | Not tested |
| macOS 26 | Intel | UNSUPPORTED | — | Not tested |
| macOS 15 and earlier | Any | UNSUPPORTED | — | Not tested |
| Windows 11, versions in Home/Pro servicing | x64 | TARGETED | OpenGL (WGL) now. Modern API is a later decision. | Not tested |
| Windows 11, versions in Home/Pro servicing | ARM64 | TARGETED | Same | Not tested. No CI target. |
| Windows 11 LTSC, Windows 10, earlier | Any | UNSUPPORTED | — | — |
| Ubuntu 24.04 LTS, Ubuntu 26.04 LTS, Debian 13 | x86_64, aarch64 | TARGETED | OpenGL/EGL with X11. Wayland after [#152](https://github.com/Tigon32/miniquad/issues/152). | Compile only (`rust.yml`, manual) |
| Other glibc 2.39+ distributions | x86_64, aarch64 | UNSUPPORTED (can work, no claim) | — | — |
| Debian 12 and older glibc | Any | UNSUPPORTED | — | — |
| 32-bit Linux (`armv7`, `i686`), musl, BSD | — | UNSUPPORTED | — | `armv7` compile only |
| iOS native | arm64 | UNSUPPORTED until a device owner exists | GLES (deprecated) or Metal | Compile only |
| Android native | arm64 | UNSUPPORTED until a device owner exists | GLES | Not tested ([native qualification](native-platform-qualification.md)) |
| tvOS | — | UNSUPPORTED | — | Not tested |

**Linux ABI decision:** native Linux builds target glibc 2.39 or later.
This is the glibc in Ubuntu 24.04 (`2.39`). Ubuntu 26.04 has `2.43`. Debian 13 has `2.41`.
A supported distribution does not guarantee a supported GPU driver.
Each test record must give the GPU, driver, and display server.

## Browser client matrix (proposed initial)

| Browser | OS | Tier | WebGPU state (vendor) | Test status |
| --- | --- | --- | --- | --- |
| Chrome and Edge | Windows 11 x64, macOS 26+ | TARGETED | Shipped since Chrome 113 | Not tested on hardware |
| Chrome | Linux | TARGETED, adapter-dependent | Intel Gen12+ (144), NVIDIA Wayland (147). Other GPUs behind a flag. | Not tested |
| Chrome | Windows 11 ARM64 | UNSUPPORTED for WebGPU | Behind a flag | — |
| Firefox | Windows 11 | TARGETED | Shipped since 141 | Not tested |
| Firefox | macOS 26+ Apple silicon | TARGETED | Shipped since 145 | Not tested |
| Firefox | Linux, Android | UNSUPPORTED for WebGPU | Nightly or flag only | — |
| Firefox ESR | Any | UNSUPPORTED (initial) | — | — |
| Safari 26+ | macOS 26+, real Mac | TARGETED (manual) | Shipped in Safari 26 | Not tested |
| Safari 26+ | iOS/iPadOS 26+, physical device | TARGETED (manual) | Shipped in Safari 26 | Not tested |
| Chrome | Android 12+, physical device | TARGETED (manual) | ARM, Qualcomm, Intel GPUs since 121 | Not tested |

**Consumer version window:** a browser row covers the **current, security-patched stable** release.
A previous stable major can be in scope only as a **transition exception** while the vendor still supplies security updates for it.
The project does not support a browser build that no longer gets vendor security updates.
Each transition exception needs the fields in [Exceptions](#exceptions), including an applicability review of open browser advisories.
Extended or ESR channels exist. They are out of the initial scope and need a separate policy decision.
For Safari, the window is the Safari version on each included OS major, at its latest patch.

**CI browser proof is separate:** a CI job can use an exact, locked browser build (for example a Playwright revision) to make tests repeatable.
That locked build is test evidence for its exact version only. It does not extend the consumer window.
Each test record gives the exact browser version, the OS version, and the adapter information.

**Test tools are not platforms:**

* Playwright WebKit is a desktop engine test. It does not qualify Safari or iOS ([mobile qualification](mobile-browser-qualification.md)).
* SwiftShader and other fallback adapters are test tools only. They are not a production fallback and give no hardware performance result.
* A WebGPU API that exists is not proof of an adapter. Record `requestAdapter()` results.

## Graphics backends and legacy state

| Backend or path | Source anchor at `1364b6d` | Tier | Removal gate |
| --- | --- | --- | --- |
| Apple OpenGL (`AppleGfxApi::OpenGl`, default) | `src/conf.rs` lines 76–89 | LEGACY | Metal passes #142–#144 on real Apple silicon, then one deprecation release |
| Apple Metal (`AppleGfxApi::Metal`) | `src/graphics/metal.rs` | TARGETED | Must pass #142–#144 before it can be the default |
| iOS OpenGL ES | `src/native/ios.rs` | LEGACY | Classify step for iOS native (Flow A or B) |
| WebGL1 (`WebGLVersion::WebGL1`, default) | `src/conf.rs` lines 91–103, `js/gl.js` lines 36–38 | LEGACY | WebGL2 has equal tested behavior |
| WebGL2 (`WebGLVersion::WebGL2`) | `src/conf.rs`, `js/gl.js` line 102 | LEGACY (explicit selector during transition) | WebGPU gate below |
| WebGPU | MADR 0015 proof ([#154](https://github.com/Tigon32/miniquad/issues/154)) | TARGETED | — |
| Linux GLX fallback (`LinuxX11Gl`) | `src/conf.rs` lines 44–57 | Classify step | EGL passes on each TARGETED distribution |
| Linux X11 default (`LinuxBackend::X11Only`) | `src/conf.rs` lines 59–74 | Classify step | Wayland passes [#152](https://github.com/Tigon32/miniquad/issues/152) and a qualified run |
| Windows WGL OpenGL | `src/native/windows.rs` | TARGETED | Later modern-API decision |

### WebGL removal gate

MADR 0015 keeps the current default during its proof and forbids an automatic WebGL fallback.
Remove the WebGL selector and the WebGL code in `js/gl.js` only when **all** conditions are true:

1. A PR freezes the **post-removal browser matrix**: each browser, OS, and CPU row that stays TARGETED or QUALIFIED after the removal.
2. WebGPU passes the parity tests for the public rendering API.
3. WebGPU is QUALIFIED on real hardware on **every** row in that frozen matrix.
4. Each row that the removal drops from TARGETED or QUALIFIED has its own versioned policy decision. A row that is not tested is not dropped by default.
5. One versioned release has WebGPU as default and WebGL as a deprecated explicit selector, with migration notes.
6. No open P1 WebGPU regression exists.

The trigger is these criteria, not a date.
After removal, a browser without a WebGPU adapter gets an explicit unsupported error.
Do not keep a permanent legacy default or selector.

## Legacy removal checklist

Each item group gets its own bounded PR and its own flow. Groups do not wait for each other.
This plan applies to platform claims and legacy code.
It does not block pure geometry, protocol, editorial, or safety fixes.
Do not close a safety issue because its platform can be removed later. Close it only when the fix passes or the code is removed.

### Common steps for each item

- [ ] **Policy:** the owner has accepted MADR 0016, or a later policy decision covers the item.
- [ ] **Inventory:** record the source anchors, `cfg` branches, dependencies, CI jobs, tests, and documents.
- [ ] **Classify:** mark the item **Keep** (supported compatibility) or **Remove** (dead legacy). Give the reason.
- [ ] **Select the flow:** Flow A or Flow B below.
- [ ] Link the item to its open issue and to [#156](https://github.com/Tigon32/miniquad/issues/156).

| Group | Items to classify | Flow |
| --- | --- | --- |
| OS and CPU branches | tvOS `cfg` branches (`Cargo.toml`, `src/native.rs`, `src/lib.rs`, `src/graphics/metal.rs`, `src/native/apple/frameworks.rs`); iOS native; Android native and `ndk-sys = "0.2"`; 32-bit Arm | A |
| Graphics paths | Apple OpenGL; iOS GLES; WebGL1; WebGL1 depth-texture extension path (`js/gl.js` lines 99 and 777); WebGL2; GLX fallback; GLSL `#version 100` guidance (`src/graphics.rs` line 1104) | B |
| CI targets | `rust.yml`: `armv7-unknown-linux-gnueabihf`, `x86_64-apple-darwin`, `x86_64-apple-ios`; moving labels `ubuntu-latest`, `macos-latest`, `windows-latest`; `windows-file-drop-ci.yml`: `windows-2022` | A (labels: direct change) |
| Dependencies | `winapi = "0.3"` (evaluate a maintained Windows binding); `objc-rs 0.2`; `ndk-sys 0.2` | B for a binding change; A when its platform goes |
| Documents | README "Platform targets" upstream list; claims of "WebGL 1 - tested on iOS Safari" | Direct editorial change |

### Flow A — Remove a platform with no replacement

Use this flow when the project intentionally stops supporting an OS, CPU, or target.

- [ ] Record a versioned policy decision for the dropped row. Dropping a public OS or CPU is a compatibility change, also when no API item changes.
- [ ] Give migration notes: the last version that contained the code and the supported alternatives.
- [ ] Delete the code, `cfg` branches, dependencies, CI jobs, tests, and documents in one PR.
- [ ] Bump the version as a compatibility change under the [#19](https://github.com/Tigon32/miniquad/issues/19) SemVer decision.

Acceptance: required CI and the gates for the remaining matrix pass; no orphan dependency, `cfg`, test, or document remains.

### Flow B — Replace a backend or path

Use this flow when a modern path replaces a legacy path on platforms that stay supported.

1. **Replacement proof:** the replacement passes on every retained row that used the legacy path.
   - [ ] Metal: #142, #143, #144 closed with real Apple silicon evidence.
   - [ ] WebGL2 has tested parity with WebGL1 for the public API.
   - [ ] WebGPU: MADR 0015 proof and parity tests ([#154](https://github.com/Tigon32/miniquad/issues/154)), then the [WebGL removal gate](#webgl-removal-gate).
   - [ ] Linux: EGL and Wayland runs on each TARGETED distribution.
   No software-adapter result counts as hardware evidence.
2. **Deprecation release:**
   - [ ] One versioned release changes the default to the proved replacement.
   - [ ] The old selector remains only as an explicit, deprecated value with a clear deprecation message.
   - [ ] Migration notes give the old item, the new item, and the code change.
   - [ ] An unsupported configuration gets an explicit error, not a silent backend change.
3. **Removal:**
   - [ ] Delete the selector, enum variants, code paths, dependencies, tests, and documents.
   - [ ] Bump the version as a breaking change under the #19 SemVer decision.
   - [ ] Record the removal in the change log with the MADR and issue link.

Acceptance: required CI and the qualification gates for the remaining matrix pass; no permanent legacy default or selector remains.

### Direct changes (no flow)

- [ ] Replace moving runner labels with explicit images.
- [ ] Add compile CI for TARGETED targets that have no job: `aarch64-apple-darwin`, `aarch64-pc-windows-msvc`, `aarch64-unknown-linux-gnu`.
- [ ] Replace the README upstream platform list with a link to this guide.

Acceptance: `node scripts/check-docs.mjs` passes; the changed CI jobs run; no public API change.

## Exceptions

An exception keeps an item outside the policy for a limited time. Follow [MADR 0007](adr/0007-use-supported-and-secure-toolchains.md).
Record each exception in [#156](https://github.com/Tigon32/miniquad/issues/156) or its linked issue with these fields:

| Field | Content |
| --- | --- |
| Item | The platform, browser version, backend, or dependency |
| Reason | Why the policy cannot apply now |
| Owner | A named person |
| Risk | Applicable advisories and their review result |
| Review date | The next check |
| Expiry | The version or date when the exception ends |

An exception without an owner or expiry is not valid.

## Support window and update cadence

* **macOS:** the two newest majors in the Apple security release list. Apple publishes no end date. Review at each new major (usually September).
* **Windows 11:** versions that Microsoft lists in Home and Pro servicing. Review at each annual version and at each end date.
* **Linux:** Ubuntu LTS releases in standard support and the current Debian stable. Review at each new LTS or Debian stable.
* **Browsers:** current security-patched stable. Prior major only as a bounded exception. Review the WebGPU state at each policy review.
* **Policy review:** before each release, at a new OS major, and at least each quarter.
  A review can change the matrix only through a PR that updates this guide.
  Removing a TARGETED or QUALIFIED row needs a versioned policy decision (Flow A).

## Security response

Use the [MADR 0007](adr/0007-use-supported-and-secure-toolchains.md) triage rules.

* When a vendor stops security updates for an included OS major, move it to UNSUPPORTED at the next review.
* An actively exploited fault in an included platform component: start triage within 24 hours. Record whether Miniquad is affected.
* Do not claim that an old version has an applicable CVE without evidence.
* Do not claim that a new version is faster or more reliable without a measured test.

## Test gates for QUALIFIED

A row becomes QUALIFIED for a release candidate only with all of these:

1. The exact candidate commit passes required CI.
2. A run on the row's OS at the latest vendor patch, with recorded OS build, CPU, GPU, and driver.
3. For browsers: the exact browser version and the `requestAdapter()` result. No software adapter.
4. The applicable scenarios from [release qualification](release.md) and [mobile qualification](mobile-browser-qualification.md).
5. A named reviewer.

## Sources (checked 2026-11-11)

* [Apple security releases](https://support.apple.com/en-us/100100): macOS 27.2.1, 26.7.3, 15.8.3 on 2026-11-09; last Sonoma 14.8.9 on 2026-08-06; Safari 27.2 for macOS 15 and 26.
* [macOS Golden Gate 27 security content](https://support.apple.com/en-us/149035) and [macOS Tahoe 26 security content](https://support.apple.com/en-us/125110): device lists. macOS 27 lists Apple silicon Macs and MacBook Neo only.
* Apple developer documentation: `NSOpenGLView` deprecated in macOS 10.14; OpenGL ES deprecated in iOS 12.
* [Windows 11 release information](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information): 26H2, 26H1, 25H2 in Home/Pro servicing; 24H2 Home/Pro at end of updates.
* [Windows 10 Home and Pro lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro): support ended 2025-10-14.
* [Debian releases](https://www.debian.org/releases/): Debian 13 is stable; five-year life cycle.
* [Ubuntu release cycle](https://ubuntu.com/about/release-cycle): the official page did not load in two separate checks. Dates came from [endoflife.date](https://endoflife.date/ubuntu) (secondary): 24.04 standard support to 2029-05-31, 26.04 to 2031-05-29. These dates are not verified from the official source.
* Glibc: [Ubuntu noble libc6](https://packages.ubuntu.com/noble/libc6) `2.39`, [Ubuntu resolute libc6](https://packages.ubuntu.com/resolute/libc6) `2.43`, [Debian trixie libc6](https://packages.debian.org/trixie/libc6) `2.41`, [Debian bookworm libc6](https://packages.debian.org/bookworm/libc6) `2.36`.
* [gpuweb implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) (edited 2026-10-02).
* [Chromium Dash](https://chromiumdash.appspot.com/releases): Chrome stable 157 on Mac. [Firefox versions](https://product-details.mozilla.org/1.0/firefox_versions.json): 160.0, ESR 153.7.0.
* [Rust platform support](https://doc.rust-lang.org/nightly/rustc/platform-support.html): `aarch64-apple-darwin`, `aarch64-pc-windows-msvc`, `aarch64-unknown-linux-gnu` Tier 1; `x86_64-apple-darwin`, `armv7-unknown-linux-gnueabihf` Tier 2.
* [Android security bulletins](https://source.android.com/docs/security/bulletin): device vendors publish patch levels. Record the patch level for each device test.

Exact patch numbers in this list become old quickly. A review must check the sources again.
