# Run CI locally before a push

**STE-aligned draft.** Full dictionary review not done.

Use the local test loop before you push a reviewed checkpoint.
This follows [MADR 0005](adr/0005-low-cost-ci-and-risk-based-test-lanes.md).
The wrapper runs the existing workflows. It does not create GitHub workflow runs.

## Requirements

Use Node.js 24 or later, Git, a running local Linux Docker daemon, and either
[`act`](https://github.com/nektos/act) or
[`gh act`](https://github.com/nektos/gh-act).
For the extension, install `nektos/gh-act` with `gh extension install nektos/gh-act`.
Do not pass a GitHub token. The selected workflows need only public sources.

The Ubuntu 24.04 runner image is fixed by digest in
[`scripts/local-ci.mjs`](../scripts/local-ci.mjs).
The first run downloads that image, actions, toolchains, and browser files.
Later runs reuse the local image, action cache, and versioned Docker volumes.
The browser volume key includes the architecture and npm lockfile hash.
The local container installs missing Rustup from the official Rust installer.
No npm or Cargo production dependency is added.

## Commands

```sh
# Inspect the selected job. This does not run tests.
npm run ci:local -- --list

# Run the required Rust, WASM, Node, lint, and Chromium lane.
npm run ci:local

# Run the same lane through the installed GitHub CLI extension.
npm run ci:local:gh

# Run the existing Chromium, Firefox, and WebKit lane.
npm run ci:local -- --lane browser
```

During editing, run the focused commands in [AGENTS.md](../AGENTS.md).
Run the applicable local CI lane before a push.
Push only a coherent checkpoint. Then use a PR for the final hosted checks.
Do not push successive edits merely to discover a failure that runs locally.

The wrapper tests working-tree changes, not only committed files.
It selects one job and one workflow explicitly.
It never selects owner automation, publication, or release workflows.
An error, missing tool, or failed test produces a nonzero exit.
`--list` and `--dryrun` produce **not tested**, not a passing test result.

## Safety and output

Run only trusted source. `act` executes workflow code; it is not a security sandbox.
The wrapper uses an isolated HOME and configuration directory.
It does not load personal `.actrc`, environment, secret, or variable files.
It does not inherit authentication variables or an SSH agent.
The GitHub CLI can find the installed extension without loading its personal
authentication configuration.
The repository must not contain `.actrc`; the wrapper supplies its flags explicitly.

The job has no mounted Docker socket and uses a separate bridge network.
It does not bind-mount the source checkout or your home directory.
It uses the active local Docker socket, including an OrbStack socket.
Remote Docker endpoints are not accepted.

Run metadata and the result are in ignored `.local-ci/runs/`.
The terminal shows test output. Hosted cache and artifact upload steps are skipped
under `act`; test steps are not skipped.
Local failure traces are inside the temporary runner, not uploaded to GitHub.
The wrapper limits each invocation to 45 minutes because `act` does not enforce
all GitHub job time limits.
Do not remove shared Docker resources or use `docker system prune`.

## Limits

Local success does not replace the required `rust-wasm` check on the exact PR head.
Keep protected `master` rules in force. Do not bypass them.
Final CI still runs once the PR source is ready.

The wrapper uses the Docker server's native architecture.
On an ARM Mac, the result is Linux arm64, not Linux x64 or native macOS.
It does not qualify Windows, Android, iOS, hardware GPU performance, or a release.
The container image is not the complete GitHub-hosted runner image.
`act` does not fully implement GitHub permissions, concurrency, or event behavior.
Keep native OS tests and release qualification separate.
