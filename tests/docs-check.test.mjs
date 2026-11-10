import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
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
