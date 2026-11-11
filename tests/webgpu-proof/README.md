# WebGPU proof harness

Writing review state: **STE-aligned draft**. Full dictionary review not done.

This harness tests both candidates of the
[WebGPU proof contract](../../docs/webgpu-proof-contract.md) with one oracle.
The queen or parent owns these files. Candidate workers do not edit them.

| File | Purpose |
| --- | --- |
| `contract.mjs` | Expected values and checks. It has no browser dependency |
| `instrumentation.mjs` | Init script that records contexts, adapters, devices, errors, and applies N1 to N4 |
| `run-proof.mjs` | Playwright runner for one candidate and one lane. It writes a receipt |
| `harness.test.mjs` | Unit tests for the oracle, instrumentation, runner arguments, and server |
| `../../scripts/webgpu-proof-serve.mjs` | Static server for `experiments/webgpu-<candidate>/dist/` |

## Commands

```sh
node --test tests/webgpu-proof/harness.test.mjs
node tests/webgpu-proof/run-proof.mjs --candidate manual --lane software
node tests/webgpu-proof/run-proof.mjs --candidate wgpu --lane software
node tests/webgpu-proof/run-proof.mjs --candidate manual --lane chromium-default
node tests/webgpu-proof/run-proof.mjs --candidate manual --lane firefox-default
node tests/webgpu-proof/run-proof.mjs --candidate manual --lane webkit-default
node tests/webgpu-proof/run-proof.mjs --candidate manual --lane chromium-default --headful
node tests/webgpu-proof/run-proof.mjs --candidate wgpu --lane chromium-default --headful
```

The runner needs the repository-pinned `@playwright/test` browsers and a built `dist/` folder.
The receipt records the pinned and installed Playwright versions and the browser version.
A receipt with `matchesPin: false` is not valid proof evidence.
It writes `target/webgpu-proof/<candidate>-<lane>-<browser>.json`.
It exits with code 1 if a case fails, if a case does not run, or if the lane has no result.
Set `WEBGPU_PROOF_STEP_TIMEOUT_MS` to change the deadline for each wait. The default is 20000.

## Rules

* Each wait polls the status on animation frames until a condition or a deadline.
  There is no fixed sleep. A deadline is a failure with the last status.
* An unexpected terminal phase stops the wait and fails the case.
* Every status read is checked for the contract shape and for progress rules.
* A rejection result is `rejection-pass`. It never counts as a rendering `pass`.
* The software lane fails if the adapter is not a fallback adapter.
* Observation lanes run the natural rejection only if the browser has no API or no adapter.
  If an adapter exists, they run T1 to T7 and N1 to N5 and record the adapter facts.
* T1 to T5 share one page. A failure marks the later cases in that page as failed, not as passed.
* A passing non-fallback-adapter run records **OBSERVED, NOT QUALIFIED**.
  A failing run records **OBSERVED, FAILED**. Other runs record **NOT TESTED**.
* Headful receipts use a `-headful` suffix. They do not replace headless receipts.

## Recorded hardware observations

Both candidates ran from clean source
`ec68f04c833163f7cd5bffb7dbad5c557a3cf198`.
Each run used a fresh release build and the same common oracle.
The order was manual, `wgpu`, `wgpu`, manual.

| Environment | Recorded value |
| --- | --- |
| OS | macOS arm64, Darwin `25.6.0` |
| Playwright | Pinned and installed `1.65.0` |
| Browser | Chromium `158.0.8127.18`, headful, no extra flags |
| Adapter | Vendor `apple`, architecture `metal-3`, `isFallbackAdapter: false` |
| Display scale | Emulated 1; not a physical Retina test |

Each run passed T1 to T6 and rejected T7 and N1 to N5 as specified.
The four runs gave 24 rendering/lifecycle passes and 24 rejection passes.
There were no failed or unrun cases.
The result is **OBSERVED, NOT QUALIFIED**.
It is not a production-backend decision, a performance comparison, or platform qualification.
The candidate code, shared shader, runner, and oracle remain identical to that source.

Receipts remain outside Git, as the contract requires:

```text
target/webgpu-proof/headful-abba/1-manual/manual-chromium-default-chromium-headful.json
target/webgpu-proof/headful-abba/2-wgpu/wgpu-chromium-default-chromium-headful.json
target/webgpu-proof/headful-abba/3-wgpu/wgpu-chromium-default-chromium-headful.json
target/webgpu-proof/headful-abba/4-manual/manual-chromium-default-chromium-headful.json
```

The repeated builds produced the same artifact hashes for each candidate:

| Artifact | SHA-256 |
| --- | --- |
| Manual `dist/app.wasm` | `89a690dd124101d72ac6d2af1ef3407fa282543e697505e7ea7890359446f7e4` |
| Manual `dist/host.js` | `27834f3e41f3fb4ec34dcec7a62ecdeb51e0fbbf5493db5031f48c54c7526313` |
| `wgpu` `dist/host.js` | `ccc9d4d90334e216848a012699aa33940acd462d9d32166ed5875b17260e08e9` |
| `wgpu` `dist/pkg/webgpu_wgpu_proof.js` | `bfde04b6146dd9a99fb3edfb06f1a27646bc61bca49774501f7318046322481e` |
| `wgpu` `dist/pkg/webgpu_wgpu_proof_bg.wasm` | `7accad490214d9159567dcee191197f16136eb45a30f63b55d693e4e06bc07db` |

## Limits

The unit tests check the oracle and the instrumentation with fake browser objects.
They do not prove WebGPU behavior. Only a browser run against a built candidate can do that.
A software-adapter result does not qualify hardware or another OS.
