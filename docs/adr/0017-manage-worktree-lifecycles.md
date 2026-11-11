# Manage worktree ownership and post-merge cleanup

* Status: **Accepted**
* Date: 2026-11-11
* Scope: Local Git worktrees used by contributors and agents
* Related issue: [#163](https://github.com/Tigon32/miniquad/issues/163)

## Context and Problem Statement

Parallel work needs separate working directories.
A completed worktree can keep large build caches after its PR merges.
Old worktrees can also hold unfinished code or unique test evidence.

An audit found 42 registered worktrees.
Twelve matched the exact source SHA of a merged PR.
Eleven of those had no tracked or untracked changes.
The checked `master` was `5ad80ee9cd21b1572e353faa184d0bc4a5972551`.

The repository uses squash merges.
The source commit of a merged PR might not be an ancestor of `master`.
Thus, `git branch --merged` alone cannot prove that a worktree is safe to remove.

## Decision Drivers

* Keep parallel workers independent.
* Give each worktree one writer.
* Remove completed working directories and rebuildable caches.
* Preserve unfinished work, source references, and test evidence.
* Avoid changes to other users' files, processes, and shared caches.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Keep every worktree | No cleanup decision | Old checkouts and caches accumulate |
| Delete worktrees by age or branch name | Simple rule | The rule can discard unfinished work |
| **Use ownership records and verified cleanup** | Safe, traceable cleanup | The owner must check source and local files |

## Decision Outcome

**Accepted:** Give each task worktree one owner and a recorded lifecycle.
Remove it after its work merges and the cleanup checks pass.
Use these rules for contributors and agents.

### Create and assign

1. Inventory existing worktrees before a new parallel batch.
2. Use one task branch and one writer for each worktree.
3. Record the repository, exact path, branch, owner, issue, base SHA, and intended result.
4. Record the paths that the writer can change.
5. Fetch `origin/master` before a new task. Use its recorded SHA, not a stale local `master`.
6. Create only the worktrees needed for assigned tasks. Reuse a task's worktree for its tests.

Keep the ownership record in the coordinator's task log or session artifacts.
Do not commit machine-specific paths or private files to the repository.

### Hand off and retain

The writer must report the final source SHA, local changes, tests, and artifact paths.
The coordinator must confirm that the writer has stopped before ownership changes.
An idle agent can still own unfinished work. Idle status alone does not release ownership.

Retain active work, failed or blocked work, and unmerged prototypes.
Record the owner, reason, and next review checkpoint for each retained worktree.
Do not use age as permission to delete it.

### Verify merge evidence

Fetch `origin/master` and check the actual merge commit.
Record the PR number, merged source SHA, merge SHA, and checked `master` SHA.

Use one of these checks:

* The worktree HEAD equals the merged PR's source SHA, and its merge commit is in `master`.
* The worktree HEAD is an ancestor of the checked `master`.
* For integrated or cherry-picked work, compare its full branch diff from the common base.
  Every changed path must have the same content and mode on the checked `master`.
  Record the compared paths and both source SHAs.

A matching branch name, closed issue, or partial patch is not sufficient.
If the worktree has later commits or any difference that these checks do not explain, keep it.
Keep detached worktrees unless their commits have durable references and merge evidence.

### Preserve local files

Check tracked changes, untracked files, and ignored files separately.
A clean `git status` does not mean that ignored test evidence is absent.

Keep worktrees with source changes or unknown files.
The owner can move identified test evidence to approved artifact storage.
Record its source SHA and destination. Verify file hashes after the move or archive.
Then run the cleanup checks again.

Do not archive or publish credentials, personal files, or a worker's private home directory.
Keep unknown private data in place and request an owner decision.
Rebuildable dependency directories, compiler output, and pinned Action caches need no archive.
Do not delete a shared cache or follow a symlink into another directory.
Check whether a retained worktree depends on a candidate's symlink target.

### Remove and verify

1. Confirm that no writer, server, test, or other process uses the worktree.
2. Recheck HEAD, local changes, ignored artifacts, merge evidence, and ownership.
3. Use `git worktree remove` with one exact, verified path.
4. Do not use forced removal, broad recursive deletion, or `git clean` for this procedure.
5. Verify that the path is gone and `git worktree list` no longer registers it.
6. Keep local branch references by default. Branch deletion is a separate decision.
7. Record the removed paths, source SHAs, merge evidence, archive hashes, and retained work.

Run this review after a verified merge and before the next worker batch.
Do not use `git worktree prune` as a substitute for these checks.
An inaccessible path can be an unmounted worktree, not an abandoned one.

## Consequences

### Positive

* Parallel work keeps one writer for each task.
* Completed worktrees stop retaining build caches.
* Source branches and verified evidence remain available for recovery.

### Negative

* Squash merges need explicit source records.
* Ambiguous or unfinished worktrees remain until their owner resolves them.
* The coordinator must complete a cleanup record after delivery.

## Confirmation

1. Record a before-and-after worktree inventory for #163.
2. Remove only candidates that pass the ownership, source, file, and process checks.
3. Verify archived evidence and retained branch references.
4. Confirm that active and dirty worktrees remain unchanged.
5. Run `node scripts/check-docs.mjs`.
6. Review retained worktrees at the next task checkpoint.

## References

* [Contributor instructions](../../AGENTS.md)
* [MADR 0002](0002-risk-based-verification-and-selective-tdd.md)
* [Local CI](../local-ci.md)
* [Git worktree reference](https://git-scm.com/docs/git-worktree)

**Writing review state:** STE-aligned draft. Full dictionary review not done.
