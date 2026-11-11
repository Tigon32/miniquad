"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

// Guards the explicit-runner-image policy (MADR 0007 rule 9): no workflow
// may use a moving "-latest" OS label, and the Cargo config path must be
// the file Cargo actually reads for appended [target.*] sections.

const workflowsDir=path.resolve(__dirname,"../.github/workflows");
const workflowFiles=fs.readdirSync(workflowsDir).filter(f=>/\.ya?ml$/u.test(f));

for (const file of workflowFiles) {
    const content=fs.readFileSync(path.join(workflowsDir,file),"utf8");

    test(`${file} does not use a moving runner label`,()=>{
        assert.doesNotMatch(content,/\b(?:os|runs-on):\s*["']?(?:ubuntu|macos|windows)-latest\b/u);
    });

    const cargoConfigRefs=content.match(/~\/\.cargo\/config(?:\.toml)?\b/gu)??[];
    if (cargoConfigRefs.length>0) {
        test(`${file} writes the Cargo config file Cargo reads (config.toml)`,()=>{
            for (const ref of cargoConfigRefs) {
                assert.equal(ref,"~/.cargo/config.toml");
            }
        });
    }
}
