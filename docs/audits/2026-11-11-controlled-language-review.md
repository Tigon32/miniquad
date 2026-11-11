# Controlled-language reference and review scope

**Result:** Partial. The current reference is identified. The dictionary and rule review is **not checked**.

## Source record

* Repository: `Tigon32/miniquad`.
* Source revision: `f837a98d415262320a8c66ef9f8024d8f2faeab1`.
* Work branch: `feat/controlled-language-review`.
* Record date: 2026-11-11.
* Related issue: [#34](https://github.com/Tigon32/miniquad/issues/34).
* Decision: [MADR 0003](../adr/0003-use-asd-ste100-for-communication.md).

This record identifies the reference and the review scope.
It does not certify the text or replace a dictionary and rule review.
No source code, technical decision, test result, or example changed.

## Applicable reference

The [official STEMG home page](https://www.asd-ste100.org/) identifies **Issue 9, January 15, 2025**.
The [current downloads page](https://www.asd-ste100.org/STE_downloads.html) identifies the same issue.
Both pages were read on 2026-11-11.
The old `request.html` page identifies Issue 8 from 2021.
Do not use that old page to identify the current issue.

A copy of the publisher's public PDF was obtained for private reference.
Its cover identifies Issue 9, January 2025.
The file has 434 pages.
Its SHA-256 is:

```text
d1f4ea9e7cd6e46b47aa9057209f99e78c0e9cfc4e27a5b07895b05c1a166431
```

The publisher retains the copyright.
The PDF reports that copying and changes are not permitted.
No dictionary, rule collection, PDF, or extracted word list is committed here.
No extraction-based checker was built.
No request form was submitted. No personal data was sent.

The official reference is available for inspection.
This does not grant permission to redistribute its content or build a dictionary product.
The publisher's downloads page states that third-party tools are not certified or endorsed.
This project makes no such claim.

## Selected manual review method

Use the official reference under its applicable terms.
Do not bypass its copy restrictions.
A review needs both the dictionary and the writing rules.
A link check, spelling check, or plain-language rewrite is not sufficient.

1. Record the source revision, file path, file hash, reference issue, review date, and reviewer.
2. Read the rendered prose. Identify quoted records and exact technical text before making changes.
3. Check each prose word, its meaning, its part of speech, and its permitted form against the dictionary.
4. Check each sentence and instruction against the applicable writing rules.
5. Record each finding. Record the location, reason, correction, and recheck result.
6. For a necessary technical term, check the glossary. Record its definition and the reason for the exception.
7. Check the revised technical meaning against the source, callers, examples, units, and recorded evidence.
8. Recheck the changed text. Leave an unresolved file marked **Not checked**.
9. Use **Reviewed against ASD-STE100** only when the complete file has dictionary and rule review evidence.

Do not identify a reviewer as an ASD-approved reviewer without evidence.
Do not describe this method as an ASD-approved checker.
This method has been documented; the complete review has **not** run.

### Exact-text exceptions

Preserve identifiers, commands, paths, URLs, protocol fields, hashes, units, test output, and code blocks.
Preserve third-party quotations and historical test records.
Identify their source. Do not silently rewrite them.
These are scope rules, not a list of approved prose words.
Every additional technical exception needs its own justification.
No additional word or rule exception was approved in this record.

## File inventory

The following command returned 66 paths at the source revision above:

```sh
git ls-files '*.md' '*.md.template'
```

Every listed file has the result **Not checked** against the Issue 9 dictionary and rules.
This includes files that already declare **STE-aligned draft**.
The template is included because it produces project-authored Markdown.
The inventory does not imply that every line is project-authored.
Identify third-party and historical passages during review.

| File | Dictionary and rule review |
| --- | --- |
| `.cursor/skills/miniquad-browser-repro/SKILL.md` | Not checked |
| `.cursor/skills/miniquad-native-safety/SKILL.md` | Not checked |
| `.cursor/skills/miniquad-performance-proof/SKILL.md` | Not checked |
| `.cursor/skills/miniquad-security-gates/SKILL.md` | Not checked |
| `.cursor/skills/miniquad-source-audit/SKILL.md` | Not checked |
| `.cursor/skills/miniquad-verified-delivery/SKILL.md` | Not checked |
| `.cursor/skills/miniquad-wasm-abi/SKILL.md` | Not checked |
| `.github/ISSUE_TEMPLATE/engineering-issue.md` | Not checked |
| `.github/PULL_REQUEST_TEMPLATE.md` | Not checked |
| `.github/skills/miniquad-browser-repro/SKILL.md` | Not checked |
| `.github/skills/miniquad-native-safety/SKILL.md` | Not checked |
| `.github/skills/miniquad-performance-proof/SKILL.md` | Not checked |
| `.github/skills/miniquad-security-gates/SKILL.md` | Not checked |
| `.github/skills/miniquad-source-audit/SKILL.md` | Not checked |
| `.github/skills/miniquad-verified-delivery/SKILL.md` | Not checked |
| `.github/skills/miniquad-wasm-abi/SKILL.md` | Not checked |
| `AGENTS.md` | Not checked |
| `README.md` | Not checked |
| `SECURITY.md` | Not checked |
| `docs/abi-v3-contract.md` | Not checked |
| `docs/abi-v3-function-inventory.md` | Not checked |
| `docs/adr/0001-use-madr-and-ubiquitous-language.md` | Not checked |
| `docs/adr/0002-risk-based-verification-and-selective-tdd.md` | Not checked |
| `docs/adr/0003-use-asd-ste100-for-communication.md` | Not checked |
| `docs/adr/0004-reusable-concept-registry.md` | Not checked |
| `docs/adr/0005-low-cost-ci-and-risk-based-test-lanes.md` | Not checked |
| `docs/adr/0006-distinct-project-identity-and-upstream-attribution.md` | Not checked |
| `docs/adr/0007-use-supported-and-secure-toolchains.md` | Not checked |
| `docs/adr/0008-optional-voxel-topologies.md` | Not checked |
| `docs/adr/0009-optional-browser-adoption-layer.md` | Not checked |
| `docs/adr/README.md` | Not checked |
| `docs/architecture/README.md` | Not checked |
| `docs/audits/2026-11-10-initial-source-audit.md` | Not checked |
| `docs/audits/2026-11-10-rustfmt-baseline.md` | Not checked |
| `docs/audits/2026-11-10-security-closure-evidence.md` | Not checked |
| `docs/binaryen-wasm-opt-experiment.md` | Not checked |
| `docs/boundary-property-corpus.md` | Not checked |
| `docs/browser-embedding.md` | Not checked |
| `docs/browser-mobile-qualification.md` | Not checked |
| `docs/browser-performance-sli-policy.md` | Not checked |
| `docs/browser-profiling.md` | Not checked |
| `docs/browser-starter.md` | Not checked |
| `docs/drawing-companion.md` | Not checked |
| `docs/font-renderer-evaluation-2026-11.md` | Not checked |
| `docs/gap-analysis-2026-11.md` | Not checked |
| `docs/glossary.md` | Not checked |
| `docs/host-preferences.md` | Not checked |
| `docs/js-bridge-optimization-review.md` | Not checked |
| `docs/mobile-browser-qualification.md` | Not checked |
| `docs/native-platform-qualification.md` | Not checked |
| `docs/offline-voxel.md` | Not checked |
| `docs/owner-auto-merge.md` | Not checked |
| `docs/performance-evidence/2026-11-10-pr116-browser-baseline.md` | Not checked |
| `docs/performance-evidence/2026-11-11-browser-profile.md` | Not checked |
| `docs/release-evidence/TEMPLATE.md` | Not checked |
| `docs/release.md` | Not checked |
| `docs/rust-wasm-optimization-experiment.md` | Not checked |
| `docs/security-toolchain-inventory-2026-11.md` | Not checked |
| `docs/skills-provenance.md` | Not checked |
| `docs/terminology/README.md` | Not checked |
| `docs/upstream-attribution.md` | Not checked |
| `docs/upstream-browser-triage-2026-11.md` | Not checked |
| `docs/wasm-transfer-abi-v3.md` | Not checked |
| `examples/ime_demo/README.md` | Not checked |
| `features/README.md` | Not checked |
| `templates/browser/project-scripts/README.md.template` | Not checked |

This new record also has the result **Not checked** against the dictionary and rules.
Later additions and changes need a new source-linked review record.
Do not treat this snapshot as a current review of later revisions.

## GitHub communication

New issue and PR text after MADR 0003 is also in scope.
This inventory does not review live GitHub text.
For each review, record the URL, last edit time, body hash, reference issue, findings, and result.
Historical discussion remains a record.
New communication remains an **STE-aligned draft** unless complete review evidence exists.

## Completion conditions

Issue #34 remains open.
The reference and manual method are recorded.
The complete word and rule review, corrections, justified technical exceptions, and recheck are still required.
No compliance result can be inferred from this PR or from a passing documentation link check.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
