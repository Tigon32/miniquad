# Source and admission review for Miniquad agent skills

* Reviewed: 2026-11-10
* External reference: [Cursor pstack](https://github.com/cursor/plugins/tree/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack), repository tree SHA `de8ee15dd1194627d21eb5fcd41cb1873208dabb`
* Upstream license: [MIT, Copyright (c) 2026 Lauren Tan](https://github.com/cursor/plugins/blob/de8ee15dd1194627d21eb5fcd41cb1873208dabb/pstack/LICENSE)
* Status: **Adapted ideas, original Miniquad project-local guidance**. No upstream plugin, scripts, prompts or agents were installed/executed or copied wholesale.

## Selection and localization

| Relevant pstack reference | Miniquad adaptation | Why |
| --- | --- | --- |
| `correct`, `blast-radius`, `principle-fix-root-causes` | `miniquad-source-audit` | Evidence-bound root causes, cross-file effects and grouped regression classes |
| `principle-boundary-discipline`, `principle-type-system-discipline` | `miniquad-wasm-abi` | Real `UTF-8`, raw pointer, memory ownership and Rust–JavaScript ABI |
| `create-verification-skill`, `principle-prove-it-works` | `miniquad-browser-repro` | Observe the real WebGL/WASM demo instead of treating compilation as functional proof |
| `blast-radius`, `principle-make-operations-idempotent` | `miniquad-native-safety` | Native FFI callback/lifetime and event/retry failure modes |
| `benchmark-checklist`, `principle-explain-the-number` | `miniquad-performance-proof` | Equivalent work, explicit limiter, paired baseline and honest variance |
| `principle-sequence-verifiable-units`, `principle-prove-it-works` | `miniquad-verified-delivery` | Small source-bound PRs and actually verified delivery |

The linked pstack content was used as **untrusted reference material** to extract general engineering techniques. Miniquad's actual source and repository policy determine the instructions. Any future update must review the exact external commit, license, commands, linked dependencies and authority implications; no runtime fetch or automatic self-update is allowed.

## Not adopted

* Benny automation, Slack routing and posting, external credentials, autonomous overnight agents, bot UI and third-party provider orchestration.
* Bundled TypeScript/Bun scripts, remote model defaults, self-modifying skills, global Git hooks, automatic cleanup, unbounded subagent fan-out, extra dependencies or broad platform rebuilds.
* Pretending an existing harness or verified platform behavior exists where there is only a proposed test/issue.

All six skills are Markdown-only, with no executable helpers or remote imports. They grant no additional GitHub permissions. The runtime binary and shipped JavaScript remain unchanged. See [AGENTS.md](../AGENTS.md) for routing and [the MADR index](adr/README.md) for decisions. 
