---
name: miniquad-source-audit
description: Review Miniquad source code, find related faults, and record clear evidence in the correct GitHub issue.
---

# Audit the Miniquad source

Use this skill to review old code or an upstream change.
Read [AGENTS.md](../../../AGENTS.md), the [glossary](../../../docs/glossary.md), and the open issues first.
Use [MADR 0003](../../../docs/adr/0003-use-asd-ste100-for-communication.md) for written results.

## Procedure

1. Record the repository and the exact commit SHA.
2. List the files and target platforms that you will review.
3. Show which tests you can run and which tests you cannot run.
4. Make a map of code that owns resources. Include allocation, input, callbacks, GPU handles, and shutdown.
5. Read the code that calls each changed function. Check what a change can break outside the edited file.
6. Search for raw pointers, `unsafe`, `static mut`, `unwrap`, `panic!`, callbacks, event listeners, and missing error checks.
7. Do not treat a search result as proof of a bug. Find a possible path from the input to the fault.
8. Try a small repeatable test. Use a real browser or OS for a claim about its runtime behavior.
9. Give each finding one evidence status: **source-observed**, **reproduced**, **hypothesis**, or **not tested**.
10. Find an existing issue for the same root cause. Add the finding there. Do not open a second issue for the same fault.
11. Give a new issue only when the fault has a different cause or acceptance test.
12. State the expected result, observed result, exact source link, test command, and test limit.
13. After a fix, run a regression test that detects the old fault.

## Report

Give the source SHA and test environment.
List the code and platforms that you reviewed.
Group the faults by root cause and risk.
Do not report a test that did not run as passed.
Do not say that an audit proves there are no bugs.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
