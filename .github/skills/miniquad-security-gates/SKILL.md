---
name: miniquad-security-gates
description: Review Miniquad input, memory, dependencies, CI access, and failure handling.
---

# Check security and resilience

Use this skill for untrusted input, unsafe memory transfer, the WASM loader, and CI changes.
Read [issue #16](https://github.com/Tigon32/miniquad/issues/16) and [AGENTS.md](../../../AGENTS.md).
Do not call a fault a security exploit without evidence.

## Procedure

1. Identify the data or system that needs protection.
2. Identify who can supply input and what the input can change.
3. Trace each input across JavaScript, WASM, Rust, and the OS.
4. Check data length, text encoding, pointer lifetime, and memory limits.
5. Check resource limits for file input, GPU objects, and asynchronous work.
6. Check error paths. An error must not look like a successful result.
7. Review the npm lockfile, Cargo dependency policy, licences, and GitHub Actions revisions.
8. Use the minimum CI token permissions. Do not give secrets or write access to untrusted PR code.
9. Do not trust a branch name as proof of its author.
10. Test small invalid inputs and failures in an isolated environment.
11. Record source links and the actual test results.
12. Keep one issue for one root-cause group. Use [#24](https://github.com/Tigon32/miniquad/issues/24) for Windows file drops.

## Report

Separate an actual security fault from a possible availability or correctness fault.
Give the input path, cause, possible result, control, and missing evidence.
Do not report an advisory check as passed if it did not run.
Do not change CI privileges to make a failing check pass.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
