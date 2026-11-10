# Owner-only pull request auto-merge

The protected `master` branch requires a pull request.
The active branch ruleset also requires the `rust-wasm` status check.
The ruleset has no bypass actors.

The repository allows auto-merge.
This policy enables auto-merge only for one authorized owner PR.

## Required conditions

1. The PR author must be `Tigon32`.
2. The event sender must be `Tigon32`.
3. The PR head repository must be `Tigon32/miniquad`.
4. The PR base repository must be `Tigon32/miniquad`.
5. The target branch must be `master`.
6. The PR must be open and not a draft.
7. The commit SHA and PR number must be valid.

The workflow uses `pull_request_target`.
It checks out **only trusted `master` source**.
It never checks out or executes code from the PR head.
It has `contents: read` and `pull-requests: write` permissions.
It does not use a personal access token or any additional secret.

## Merge gate

The workflow asks GitHub to enable `--auto --squash`.
GitHub applies the branch rules before it merges.
A missing or failed required check must prevent the merge.
The workflow does not bypass or change branch protection.
The workflow does not mark a draft PR ready for review.

A separate required test lane checks Rust, WASM, JavaScript, and Chromium.
Other browser and native tests have separate qualification rules.
Auto-merge is not a release approval.

## Evidence and test scope

Run `node --test tests/owner-automerge.test.mjs`.
The tests reject external authors, forks, drafts, other branches, bot actions, and malformed event data.
These are **authorization logic tests**.
They cannot prove GitHub token permissions or server-side branch enforcement.

Record the actual first owner PR that auto-merges.
Record a failed-required-check test before you close delivery issue #17.
Do not claim that an untested external PR was rejected by GitHub.

## Disable or reverse

Disable the workflow in GitHub Actions or remove `.github/workflows/owner-auto-merge.yml` in a protected PR.
You can also disable `Allow auto-merge` in the repository settings.
Do not remove the protected-branch rules to correct an automation failure.

## Reference

* [MADR 0005 — Low-cost CI](adr/0005-low-cost-ci-and-risk-based-test-lanes.md)
* [Delivery issue #17](https://github.com/Tigon32/miniquad/issues/17)
* [GitHub auto-merge documentation](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request)
* [GitHub pull_request_target security](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)

**Writing review state:** STE-aligned draft. Full dictionary review not done.
