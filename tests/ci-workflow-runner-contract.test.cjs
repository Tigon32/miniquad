"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

// Regression test for the explicit-runner-image and reviewed cargo-audit
// pin fixed in issue #155 / MADR 0007 rule 9. These checks catch a drift
// back to a moving "-latest" runner label, the deprecated Cargo config
// path, or a scanner pin that was not reviewed and recorded.

const rustYmlPath=path.resolve(__dirname,"../.github/workflows/rust.yml");
const rustYml=fs.readFileSync(rustYmlPath,"utf8");

const securityYmlPath=path.resolve(__dirname,"../.github/workflows/security-advisory-review.yml");
const securityYml=fs.readFileSync(securityYmlPath,"utf8");

test("rust.yml does not use a moving runner label",()=>{
    assert.doesNotMatch(rustYml,/\bos:\s*(ubuntu|macos|windows)-latest\b/u);
});

test("rust.yml pins explicit, supported runner images",()=>{
    assert.match(rustYml,/os:\s*ubuntu-24\.04\b/u);
    assert.match(rustYml,/os:\s*macos-26\b/u);
    assert.match(rustYml,/os:\s*windows-2022\b/u);
});

test("rust.yml writes the preferred config.toml path, not the legacy config file",()=>{
    assert.doesNotMatch(rustYml,/~\/\.cargo\/config(?!\.toml)/u);
    assert.match(rustYml,/~\/\.cargo\/config\.toml/u);
});

test("security-advisory-review.yml pins the reviewed cargo-audit version",()=>{
    assert.match(securityYml,/cargo install cargo-audit --version 0\.23\.0 --locked/u);
    assert.doesNotMatch(securityYml,/cargo-audit --version 0\.22\.2\b/u);
});
