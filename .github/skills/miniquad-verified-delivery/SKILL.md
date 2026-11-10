---
name: miniquad-verified-delivery
description: Safely deliver Miniquad bug fixes, audit follow-ups and optimizations through owner-controlled PRs with source-bound tests and issue receipts.
---

# Verified, bounded delivery

Use for code or guidance PRs. Read `AGENTS.md`, the affected ADRs and the keeper issue. Inspired by pstack's prove-it-works and blast-radius methods; execution stays within explicitly available GitHub permissions.

1. Record the exact owner/repo, issue, `master` base, branch/head SHA, expected behavior, files owned and non-goals. Reconcile another agent's overlapping work; only one writer per worktree.
2. Inspect nearby callers, downstream consumers and native/JS boundary effects. Identify one or two critical facts the change's safety depends on, then verify them with a test of real code. A convincing PR description is **not** proof.
3. For fixes: reproduce old failure, identify root cause, write a failing regression, implement minimal change and show it passing. For optimization: compare correct outputs and paired measurements. For docs: verify paths, source claims and decision statuses.
4. Run applicable available local commands (see `AGENTS.md`) and record exact exit outcomes. A missing tool, skipped target, empty test suite, interrupted run or failing step is not “green.” Do not disable checks, install global hooks or grant workflow token privileges to bypass a failure.
5. Open a PR against `master` with issue link, changed boundaries, exact head and base, commands/results, browser/native environments actually exercised, tests not run, and rollback plan. Keep reviewable scope. No unrelated generated files, secrets or captures.
6. Only transition from draft when acceptance evidence is ready. Owner-approved auto-merge may be requested **only** for an authorized same-repository Tigon32 PR when all applicable rules/checks pass. External PRs, unknown authors and administrator bypass are excluded. Never approve your own PR by proxy.
7. Verify actual merge state and commit on `master`, then update the keeper issue with source SHA, tests and residual risks. A merged prototype is not a release and an enabled auto-merge request is not a verified merge.

Use statuses: **verified**, **partial**, **blocked**, **not tested**. Provide the exact next action rather than claiming future unattended monitoring or silent retries.
