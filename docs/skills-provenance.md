# Source record for the agent skills

* Review date: 2026-11-10
* Reference: [Cursor pstack](https://github.com/cursor/plugins/tree/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack)
* Source tree SHA: `de8ee15dd1194627d21eb5fcd41cb1873208dabb`
* Source licence: [MIT; Copyright (c) 2026 Lauren Tan](https://github.com/cursor/plugins/blob/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack/LICENSE)
* Writing rule: [MADR 0003](adr/0003-use-asd-ste100-for-communication.md)

The seven Miniquad skills use ideas from pstack.
We wrote project-specific instructions.
We did not copy the whole plugin.
We did not install or run its scripts.

## Skills and their source ideas

| Pstack source | Miniquad skill | Purpose |
| --- | --- | --- |
| `correct`, `blast-radius`, `principle-fix-root-causes` | `miniquad-source-audit` | Find root causes and group related issues |
| `principle-boundary-discipline`, `principle-type-system-discipline` | `miniquad-wasm-abi` | Check JS/WASM data and memory ownership |
| `create-verification-skill`, `principle-prove-it-works` | `miniquad-browser-repro` | Check the real application in a browser |
| `blast-radius`, `principle-make-operations-idempotent` | `miniquad-native-safety` | Check native interfaces and resource lifetime |
| `principle-boundary-discipline`, `principle-prove-it-works` | `miniquad-security-gates` | Check input, dependencies, and access rights |
| `benchmark-checklist`, `principle-explain-the-number` | `miniquad-performance-proof` | Make comparable performance measurements |
| `principle-sequence-verifiable-units`, `principle-prove-it-works` | `miniquad-verified-delivery` | Keep changes small and verify PR results |

## Content that we did not use

We did not add the Benny or Slack automations.
We did not add an external agent service.
We did not import TypeScript or Bun scripts.
We did not install global Git hooks.
We did not add an automatic skill update process.
We did not use external model defaults or automatic PR approval.

The full skills are in `.github/skills/`.
Seven small files in `.cursor/skills/` point to them.
These files do not give agents more permissions.
They do not change the game runtime or its JavaScript download.

If a contributor updates a skill:

1. Review the exact upstream revision and licence.
2. Review all new commands and dependencies.
3. Check the trust and access boundaries.
4. Use the controlled-language rules in MADR 0003.
5. Submit a PR with source and test records.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
