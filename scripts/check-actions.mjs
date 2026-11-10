#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = ".github/workflows";
const errors = [];
for (const filename of readdirSync(dir).filter(x => /\.ya?ml$/u.test(x))) {
  const content = readFileSync(join(dir, filename), "utf8");
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const m = line.match(/^\s*-\s*uses:\s*(\S+)/u);
    if (!m) continue;
    const ref = m[1];
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?@[a-f0-9]{40}$/u.test(ref)) {
      errors.push(filename + ":" + (index + 1) + ": unpinned action " + ref);
    }
  }
}
if (errors.length) {
  errors.forEach(x => console.error(x));
  process.exitCode = 1;
} else {
  console.log("All GitHub Action uses statements are pinned to full commit SHAs.");
}
