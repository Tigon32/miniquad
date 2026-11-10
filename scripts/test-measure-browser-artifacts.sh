#!/usr/bin/env bash
# Regression tests for artifact measurements; uses synthetic fixtures only.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
measure="$script_dir/measure-browser-artifacts.sh"

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
printf 'wasm-test\0fixture\n' > "$tmp/test.wasm"
printf 'console.log("ok");\n' > "$tmp/gl.js"

bash -n "$measure"
if bash "$measure" >"$tmp/no-args.out" 2>"$tmp/no-args.err"; then
  echo 'FAIL: missing inputs accepted' >&2
  exit 1
fi
if bash "$measure" "$tmp/test.wasm" "$tmp/absent.js" >"$tmp/missing.out" 2>"$tmp/missing.err"; then
  echo 'FAIL: missing artifact accepted' >&2
  exit 1
fi
bash "$measure" "$tmp/test.wasm" "$tmp/gl.js" > "$tmp/first.tsv"
bash "$measure" "$tmp/test.wasm" "$tmp/gl.js" > "$tmp/second.tsv"
cmp -s "$tmp/first.tsv" "$tmp/second.tsv" || { echo 'FAIL: nondeterministic output' >&2; exit 1; }

for file in "$tmp/test.wasm" "$tmp/gl.js"; do
  expected_hash=$(sha256sum -- "$file" | cut -d ' ' -f 1)
  expected_raw=$(wc -c < "$file" | tr -d '[:space:]')
  expected_gzip=$(gzip -n -9 -c -- "$file" | wc -c | tr -d '[:space:]')
  awk -F '\t' -v file="$file" -v sha="$expected_hash" -v raw="$expected_raw" -v gz="$expected_gzip" '
    $1 == file { found=1; if ($2 != sha || $3 != raw || $4 != gz || $5 == "") exit 1 }
    END { if (!found) exit 1 }
  ' "$tmp/first.tsv" || { echo "FAIL: incorrect metrics for $file" >&2; exit 1; }
done

echo 'PASS: artifact measurement regression tests (synthetic fixtures only)'
