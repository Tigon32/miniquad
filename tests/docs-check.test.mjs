import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { audit, checkLink, markdownLinks } from "../scripts/check-docs.mjs";

test("Markdown link scanner ignores links in fenced code blocks", () => {
  const text = "[Guide](docs/glossary.md)\n~~~md\n[Bad](missing.md)\n~~~";
  assert.deepEqual(markdownLinks(text),[{line:1,target:"docs/glossary.md"}]);
});

test("relative project links resolve from their document", () => {
  const path = resolve("docs/glossary.md");
  assert.equal(checkLink(path,"adr/README.md"),null);
  assert.match(checkLink(path,"../missing-file.md"),/Missing link target/);
});

test("invalid link escape is reported", () => {
  const path = resolve("docs/glossary.md");
  assert.match(checkLink(path,"%ZZ.md"),/Invalid link encoding/);
});

test("project documentation has valid links and decision statuses", () => {
  assert.deepEqual(audit(),[]);
});

test("documentation audit excludes local runner caches but still checks project documents", (t) => {
  const cacheRoot = resolve(".local-ci");
  mkdirSync(cacheRoot, { recursive: true });
  const fixture = mkdtempSync(resolve(cacheRoot, "docs-audit-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  for (const directory of ["docs/adr", ".github/skills", ".local-ci/cache"]) {
    mkdirSync(resolve(fixture, directory), { recursive: true });
  }
  writeFileSync(resolve(fixture, "docs/adr/README.md"), "# Decisions\n");
  writeFileSync(resolve(fixture, "AGENTS.md"), [
    "docs/adr/README.md", "docs/glossary.md",
    "docs/adr/0003-use-asd-ste100-for-communication.md",
    ".github/skills/miniquad-verified-delivery/SKILL.md",
  ].join("\n"));
  writeFileSync(resolve(fixture, ".local-ci/cache/README.md"), "[Not project documentation](missing-cache-file.md)");
  assert.deepEqual(audit(fixture), []);
  writeFileSync(resolve(fixture, "docs/broken.md"), "[Broken project link](missing-project-file.md)");
  assert.ok(audit(fixture).some(error => error.includes("missing-project-file.md")));
});
