#!/usr/bin/env bash
set -euo pipefail

if [[ "${ACT:-}" != "true" ]]; then
  echo "This bootstrap is only for the local act container." >&2
  exit 1
fi
: "${GITHUB_PATH:?Missing GITHUB_PATH}" "${RUNNER_TEMP:?Missing RUNNER_TEMP}"

if [[ ! -x "$HOME/.cargo/bin/rustup" ]]; then
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
    https://sh.rustup.rs --output "$RUNNER_TEMP/miniquad-rustup-init.sh"
  sh "$RUNNER_TEMP/miniquad-rustup-init.sh" \
    -y --profile minimal --default-toolchain none --no-modify-path
fi
printf '%s\n' "$HOME/.cargo/bin" >> "$GITHUB_PATH"
