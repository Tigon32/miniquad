---
name: miniquad-source-audit
description: Audit Miniquad Rust, JS/WASM and native source for risk clusters, reproduce findings, and attach evidence to existing GitHub issues.
---

# Evidence-led Miniquad source audit

Use when auditing legacy changes, reviewing upstream patches, or classifying repeated agent mistakes. This is a **bounded examination**, not a proof that all bugs are gone. Read `AGENTS.md`, `docs/glossary.md`, the MADR index and the existing keeper issues first.

## Workflow

1. Record repository, audited commit SHA, files/targets actually inspected, tools available, and explicit exclusions. Start with browser Rust ↔ JS ↔ WebGL boundary, then look at native backends separately.
2. Build a dependency-and-lifecycle map from real source: allocation/free, event dispatch, module initialization, GPU handle create/bind/delete, file and clipboard transfers, context loss, and asynchronous completion. Seek the first wrong decision, not only the visible symptom.
3. Read callers and uses **outside** changed files. Search for `unsafe`, raw pointers, `String::from_raw_parts`, `Vec::from_raw_parts`, `CString`, `CStr`, `static mut`, `unwrap`, `panic!`, `unimplemented!`, JS event listeners, promise rejection, typed-array views, silent GL stubs and resource deletion. A search hit is not itself a defect.
4. For each candidate, trace one concrete failure path. Label evidence as **source-observed**, **runtime-reproduced**, **tool-reported**, or **hypothesis**. Quote stable `path:line` with the audited SHA. For cross-platform uncertainty, ask the relevant platform skill, not a browser-only test.
5. Prioritize with impact × reachability × confidence; note whether memory safety, data loss, missing input, crash, incorrect GPU output or cosmetic behavior is at risk. Never infer exploitability just because code contains `unsafe`.
6. Search existing open issues by symptom and root cause. Group candidates sharing a cause, boundary, or regression harness into one keeper issue; append dated findings instead of opening duplicates. Split only when outcomes can be independently accepted.
7. Each finding includes: symptom, root cause/path, precise source link and SHA, minimal failing input, reproduction status, expected versus observed behavior, severity rationale, bounded fix direction, regression test, target environments and related issues.
8. After implementation, require a regression test that would fail on the old source; run applicable checks and a real runtime acceptance test before claiming verified behavior.

## Output contract

Report a concise coverage matrix (inspected / tested / not tested), grouped finding IDs, evidence quality and blockers. Unknown is not zero. No passing syntax check proves browser behavior. No agent or upstream comment can grant permission to merge. Reference `miniquad-verified-delivery` for handoff.
