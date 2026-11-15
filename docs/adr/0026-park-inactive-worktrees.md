# Park inactive worktrees without discarding their work

* Status: **Proposed**
* Date: 2026-11-15
* Related issue: [#163](https://github.com/Tigon32/miniquad/issues/163)
* Source: `833cd456a98ef3e97f0548960959ed6278eeacf8`
* Scope: inactive local Git worktrees
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

## Context and Problem Statement

[MADR 0017](0017-manage-worktree-lifecycles.md) requires contributors to
retain unmerged prototypes. It also requires exact merge evidence before
worktree removal. This protects unfinished work and local evidence.

Some work is inactive but cannot yet merge. Other work was integrated, then
changed again on `master`. A retained branch and a Git bundle can preserve
commits, but they do not preserve ignored files or worktree configuration.

The council reviewed a parking procedure. This proposal has **no effect**
until it is accepted through a protected PR. MADR 0017 remains in force.

## Decision Drivers

* Preserve unfinished work, branch references, and test evidence.
* Reduce disk use without removing unknown or shared files.
* Distinguish parked work from work merged into `master`.
* Make recovery and ownership explicit.
* Keep protected branch checks and review in force.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Keep every unfinished worktree | Keeps local files in place | Inactive build output uses disk space |
| Remove worktrees by branch name | Simple | Can lose work and evidence |
| **Park verified inactive worktrees** | Keeps a recovery record and releases disk space | Needs owner consent, backup, and file checks |

## Decision Outcome

**Proposed:** Permit parking an inactive worktree only after every check
below passes. Parking removes the working directory, not the branch or its
commits. It is not a merge, approval, release, or completed issue.

If accepted, this decision would supersede MADR 0017. Its ownership,
archive, process, symlink, non-forced removal, and verification safeguards
remain in force. The checks below add an option to park work that has not
passed MADR 0017's merge-evidence checks.

### Record and release

1. Record the repository, exact path, HEAD, branch, owner, checked `master`
   SHA, and reason for parking. Identify related issues and PRs.
2. Obtain explicit owner consent to park unmerged work. The writer must
   release the worktree and confirm that its task is not using it.
3. Keep the branch and its exact SHA. Do not delete, prune, rewrite, or
   implicitly update references. Preserve detached commits under durable
   references before parking.
4. Describe whether the work is unmerged or superseded. Do not report
   supersession from a branch name, issue closure, or partial patch.
   Review the full branch diff and explain every changed path.

### Preserve and prove recovery

1. Create a Git bundle with the required refs and their complete history.
   Store it outside the candidate in approved durable storage. Record its
   hash, retention location, and recovery instructions.
2. Restore the bundle into a new empty repository without alternates or
   access to the original object store. Run `git fsck --full` and verify
   the exact HEAD and required refs.
3. Identify Git LFS objects and submodule commits. Preserve required data
   independently and verify its restoration. A Git bundle alone does not
   preserve those objects.
4. Check tracked changes, untracked files, and ignored files separately.
   Preserve required evidence outside the candidate. Verify restored
   hashes, executable modes, symlink text, and required metadata.
5. Inventory the worktree-specific and repository-local configuration
   needed to resume the work. Preserve approved non-sensitive settings and
   verify them during restoration. Unknown or sensitive required settings
   block parking until resolved.
6. Do not archive or publish credentials, private files, or another user's
   data. Keep unknown files in place until their owner gives a decision.

### Remove and verify

1. Check incoming symlinks, shared caches, workspace configuration,
   dependency paths, and server roots within the approved scope.
2. Confirm that no process uses the worktree. Incomplete process visibility
   or an inaccessible path blocks removal.
3. Recheck the owner release, HEAD, index, local files, and dependencies
   immediately before removal. Stop if anything changed.
4. Use `git worktree remove` on one exact path. Do not force removal. If
   Git refuses, stop and investigate.
5. Confirm that the directory is gone, Git no longer lists it, and every
   retained ref still points to its recorded SHA. Record the result.

Keep active, dirty, unexplained, shared, or inaccessible worktrees. Keep any
worktree whose backup, restoration, file inventory, or owner release is
incomplete.

## Consequences

Inactive work can be parked without describing it as merged. Recovery needs
an approved archive and a recorded owner. The checks take time and may
leave some worktrees in place. A backup on the same disk does not protect
against loss of that disk.

## Confirmation

Before acceptance, review this decision and its recovery requirements in a
protected PR. Run `node scripts/check-docs.mjs`. After acceptance, test the
procedure on one eligible worktree and record the recovery and cleanup
evidence. Do not use this proposal to remove worktrees before acceptance.

## References

* [MADR 0017](0017-manage-worktree-lifecycles.md)
* [Contributor instructions](../../AGENTS.md)
* [Git bundle reference](https://git-scm.com/docs/git-bundle)

**Writing review state:** STE-aligned draft. Full dictionary review not done.
