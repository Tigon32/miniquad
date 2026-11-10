---
name: miniquad-verified-delivery
description: Prepare small Miniquad changes, run required tests, and use safe pull-request rules.
---

# Verify and deliver a change

Use this skill before you send a code, test, or documentation PR.
Read [AGENTS.md](../../../AGENTS.md), the related issue, and the relevant MADRs.

## Procedure

1. Record the repository, `master` base, work branch, and source SHA.
2. State what the change must do. State what it must not change.
3. Read the code that uses the changed function.
4. Check what can break in another module or platform.
5. For a bug, show the old fault. Add a regression test.
6. For a performance change, measure the old and new program.
7. For a document change, check links, terms, and technical meaning.
8. Run the required checks. Record all test results and skipped tests.
9. Open a PR that links the issue and gives a short change summary.
10. Give the source SHA, test commands, tested targets, and remaining risks.
11. Do not merge a PR with a failed required check.
12. Do not approve your own PR by using another account or agent.
13. Do not enable automatic merge for an external author.
14. Confirm the actual merge commit on `master`.
15. Close the issue only when all of its acceptance conditions pass.

## Result terms

Use **verified** when required tests ran and passed.
Use **partial** when only some tests passed.
Use **blocked** when a required test could not run.
Use **not tested** when you did not run the test.

A merged PR is not proof that a browser release is ready.
Use [MADR 0003](../../../docs/adr/0003-use-asd-ste100-for-communication.md) for the PR text.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
