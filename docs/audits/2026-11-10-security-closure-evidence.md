# Security issue 16: closure evidence and boundary limits

* Review date: 2026-11-10
* Baseline: `ec4ffdd3b9402ec8e92429bb46a8d9168cbf3a87`
* Scope: public Rust library dependencies, CI tokens, browser JavaScript bridge and trusted WASM module
* Source issue: [#16](https://github.com/Tigon32/miniquad/issues/16)
* Review status: **Acceptance evidence assembled; scoped residual risks documented**
* Writing status: STE-aligned draft, not an ASD-STE100 certification

## Acceptance evidence

| Issue #16 requirement | Evidence | Scope limit |
| --- | --- | --- |
| Inventory Rust crates, npm dependencies, GitHub Actions and browser assets | [Toolchain inventory](../security-toolchain-inventory-2026-11.md), root `Cargo.toml`, independent `examples/ime_demo/Cargo.toml` and lockfile, npm lockfile, pinned workflow `uses:` references | Rust package ranges can resolve to newer versions at the next audit; installed runner toolchain is not immutable |
| Reproducible npm and justified Cargo lock policy | Required `npm ci --ignore-scripts`; temporary root library Cargo.lock for RustSec; independent locked IME example | A library's unconstrained downstream dependency graph cannot be frozen by this fork |
| Advisory/licence checks and immutable CI Actions | [Security run 42855970374](https://github.com/Tigon32/miniquad/actions/runs/42855970374) (RustSec, npm, both Cargo-deny licence graphs passed); [post-merge run 42856445237](https://github.com/Tigon32/miniquad/actions/runs/42856445237); `scripts/check-actions.mjs` | Checks cover the resolved graphs and published advisories, not unknown faults or external source/assets not in graphs |
| Least-privilege GitHub CI | Routine CI workflows declare `contents: read`; [owner auto-merge](../../.github/workflows/owner-auto-merge.yml) checks trusted `master` and validates owner metadata without executing PR code | GitHub repository settings and administrator permissions must be independently audited by an owner |
| Adversarial browser file, clipboard, pointer-length and loader paths | [PR #68](https://github.com/Tigon32/miniquad/pull/68), [PR #69](https://github.com/Tigon32/miniquad/pull/69), [PR #72](https://github.com/Tigon32/miniquad/pull/72), [PR #75](https://github.com/Tigon32/miniquad/pull/75), [PR #77](https://github.com/Tigon32/miniquad/pull/77), [PR #78](https://github.com/Tigon32/miniquad/pull/78), [PR #81](https://github.com/Tigon32/miniquad/pull/81), [PR #84](https://github.com/Tigon32/miniquad/pull/84), loader regression suite and required Chromium browser tests | Direct arbitrary calls to Rust/WASM raw-pointer exports from attacker-controlled same-origin JavaScript are **not** a qualified interface |
| Security policy and private reporting | [SECURITY.md](../../SECURITY.md) and responsible reporting route | No general supported production release series has been declared |

## Explicit ABI trust boundary

The checked-in `js/gl.js` loader must be paired with its matching compiled
Rust WASM module and loaded from a trusted origin. This is the supported
browser transfer path.

The JavaScript handlers encode file names and clipboard text as UTF-8, enforce
length and count limits, request WASM allocations, reacquire memory views after
potential memory growth, and transfer allocations to the Rust callbacks.
The Rust callbacks take ownership using `Vec::from_raw_parts`, which is
**unsafe unless the pointer, length and ownership originate from the paired
allocator and are transferred exactly once**.

A raw export called by arbitrary hostile same-origin JavaScript is not a
supported input interface: the caller may provide forged pointers, incorrect
capacities or reuse ownership. The application must not expose those exports
as a public user-input API. Browser untrusted data must flow through the
validated bridge. This is a **trust assumption**, not a proof of memory safety
against a compromised page or malicious plugin. Stronger provenance
verification in Rust would require a reviewed ownership registry and an ABI
migration; track that design in [issue #8](https://github.com/Tigon32/miniquad/issues/8).

## Residual security and qualification limits

* Successful scans do not imply zero vulnerabilities. A new security advisory
  requires applicability review and a fresh execution of the security workflow.
* Browser acceptance covers Chromium in ordinary PR CI; Firefox/WebKit and
  physical mobile-browser tests are tracked in
  [#11](https://github.com/Tigon32/miniquad/issues/11).
* GPU context restoration and WebGL render-target qualification remain in
  [#13](https://github.com/Tigon32/miniquad/issues/13).
* Windows user-interface file-drop integration and Android support have
  separate native-target qualification requirements. See
  [native platform qualification](../native-platform-qualification.md).
* No penetration test, supported release declaration or legal certification
  is asserted by this assessment.

## Closure rule

Issue #16 can be considered satisfied for its **defined browser-first hardening
controls** only after the evidence document itself has passed required CI and
the repository owner accepts the explicit same-origin JS/WASM trust boundary.
If arbitrary direct export calls are made an untrusted public API, this
assessment is insufficient and #16 must remain open until Rust-side pointer
provenance is enforced.
