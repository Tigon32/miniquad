# Clean up the worktree and branch when a task completes

* Status: **Proposed**
* Date: 2026-11-25
* Related issue: [#163](https://github.com/Tigon32/miniquad/issues/163)
* Related decisions: [MADR 0017](0017-manage-worktree-lifecycles.md), [PR #178](https://github.com/Tigon32/miniquad/pull/178)
* Scope: Local Git worktrees and local branches for finished tasks
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

## Context and Problem Statement

[MADR 0017](0017-manage-worktree-lifecycles.md) says how to remove a worktree after its work merges.
It does not say who starts the cleanup or when.
Cleanup stayed optional, so it did not happen.

An audit on 2026-11-25 found 27 linked worktrees and 33 local branches.
No worktree HEAD matched the source SHA of a merged PR.
One worktree was an ancestor of `master`, but it had uncommitted changes.
Twenty-eight local branches matched the source SHA of a merged PR and had no worktree.
They stayed only because nobody deleted them.

Squash merges hide merge state from `git branch --merged`.
The owner must record the evidence while the PR is fresh.

## Decision Drivers

* Make cleanup part of delivery, not a later task.
* Keep the evidence rules in MADR 0017.
* Never remove unfinished work, ignored evidence, or unknown files.
* Keep the rule easy to check in a PR.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Keep MADR 0017 only | No new rule | Cleanup stays optional |
| Run a scheduled cleanup of all old worktrees | No owner action | Age is not evidence. Work can be lost |
| **Make cleanup a delivery step for the owner** | Cleanup happens while the evidence is fresh | The owner must do one more step |

## Decision Outcome

**Proposed:** The worktree owner cleans up the task worktree and local branch as the last delivery step.
This MADR adds a trigger and a checklist.
It does not change the evidence rules in MADR 0017.
MADR 0026 stays separate. It covers inactive work that cannot merge.

### Trigger

Cleanup starts when one of these events occurs:

* The PR merges into `master`.
* The owner closes the PR and the work has no further use.
* The owner abandons the task. In this case, follow MADR 0017 retention rules or MADR 0026.

### PR record

Add a **Worktree cleanup** line to the PR record in [AGENTS.md](../../AGENTS.md).
It names the worktree path, branch, owner, and the planned cleanup.
A task with no linked worktree writes **none**.

### Owner checklist after the merge

1. Fetch `origin/master`. Verify the merge commit is in it.
2. Record the PR number, the merged source SHA, the merge SHA, and the `master` SHA.
3. Confirm that the worktree HEAD equals the merged source SHA, or apply the other MADR 0017 checks.
4. Check tracked, untracked, and ignored files. Keep the worktree if any source change or unknown file remains.
5. Confirm that no process uses the worktree.
6. Run `git worktree remove` on the exact path. Do not use force, `git clean`, or `git worktree prune`.
7. Delete the local branch only if its tip equals the merged source SHA.
   Use `git branch -D`, because a squash merge hides the merge from `git branch -d`.
   Record the branch name and SHA so the owner can recreate it.
8. Do not delete a remote branch unless repository rules or the PR author allow it.
9. Verify that `git worktree list` no longer shows the path.

### Coordinator check

Before each new parallel batch, the coordinator lists worktrees and local branches.
The coordinator asks the owner of each merged item to complete the checklist.
The coordinator does not remove a worktree that another person owns.

### Retained work

Keep a worktree when any check fails.
Record the owner, the reason, and the next review date.
A retained item that stays inactive follows MADR 0026 after that MADR is accepted.

## Consequences

### Positive

* Cleanup happens when the evidence is fresh.
* Merged branches do not accumulate.
* Unfinished work stays safe.

### Negative

* Each PR needs one more record line and one more step.
* The owner must stay available until the cleanup ends.

## Confirmation

1. The PR template or PR record includes the **Worktree cleanup** line.
2. A sample merged PR shows a completed checklist.
3. `git worktree list` and `git branch` show no item for merged tasks after the next batch review.
4. Run `node scripts/check-docs.mjs`.

## References

* [MADR 0017](0017-manage-worktree-lifecycles.md)
* [MADR 0026 proposal (PR #178)](https://github.com/Tigon32/miniquad/pull/178)
* [Contributor instructions](../../AGENTS.md)
* [Git worktree reference](https://git-scm.com/docs/git-worktree)

**Writing review state:** STE-aligned draft. Full dictionary review not done.
