#!/usr/bin/env bash
# Measure the exact JavaScript and WASM artifacts from a release candidate.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf 'Usage: %s path/to/app.wasm path/to/gl.js\n' "$0" >&2
  exit 2
fi
for tool in sha256sum wc gzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required tool unavailable: %s\n' "$tool" >&2
    exit 2
  fi
done

wasm=$1
js=$2
for file in "$wasm" "$js"; do
  if [[ ! -f "$file" || ! -r "$file" ]]; then
    printf 'File missing or unreadable: %s\n' "$file" >&2
    exit 2
  fi
done

printf 'artifact\tsha256\traw_bytes\tgzip_bytes\tbrotli_bytes\n'
for file in "$wasm" "$js"; do
  sha=$(sha256sum -- "$file" | cut -d ' ' -f 1)
  raw=$(wc -c < "$file" | tr -d '[:space:]')
  gz=$(gzip -n -9 -c -- "$file" | wc -c | tr -d '[:space:]')
  if command -v brotli >/dev/null 2>&1; then
    br=$(brotli -q 11 -c -- "$file" | wc -c | tr -d '[:space:]')
  else
    br=unavailable
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$file" "$sha" "$raw" "$gz" "$br"
done

printf '\nGit revision (if available): '
git rev-parse HEAD 2>/dev/null || printf 'unknown\n'
printf 'gzip: '
gzip --version | head -n 1
if command -v brotli >/dev/null 2>&1; then
  printf 'brotli: '
  brotli --version
else
  printf 'brotli: unavailable\n'
fi
