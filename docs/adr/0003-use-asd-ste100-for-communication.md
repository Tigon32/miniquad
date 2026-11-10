# Use ASD-STE100 for project communication

* Status: **Proposed**
* Date: 2026-11-10
* Scope: Miniquad project documentation and project communication

## Context and Problem Statement

Different writers use different words for the same part or action.
Long sentences can hide a condition, a limit, or a required step.
Miniquad has Rust, JavaScript, WebAssembly, graphics code, and native interfaces.
A short and consistent language can help people and coding agents use the documentation.

ASD-STE100 is a controlled English specification.
The specification has writing rules and an approved dictionary.
This project does not have a verified copy of the approved dictionary or an approved compliance checker.

How can we use ASD-STE100 without an incorrect claim of full compliance?

## Decision Drivers

* Give one clear meaning to each technical term.
* Make instructions short and direct.
* Keep warnings, limits, and conditions clear.
* Keep source links, commands, API names, and test evidence correct.
* Do not change historical test results or technical decisions during an editorial update.
* Do not copy a restricted dictionary into the repository.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Keep free-form English | No work to change the text | Writers can use different terms |
| Claim full ASD-STE100 compliance now | One strict target | We cannot verify the approved words or all rules |
| **Use ASD-STE100 as the required writing target and record the verification state** | Clear rules and an honest review process | Full compliance needs a dictionary and a review tool |

## Decision Outcome

**Proposed:** Use ASD-STE100 for new and changed project communication and documentation.

Apply this rule to the README, guides, glossary, MADRs, agent skills, issue descriptions, pull request descriptions, review comments, test plans, release notes, and user instructions written for this project.

### Writing rules

1. Use one approved meaning for each word. Use the [project glossary](../glossary.md) for technical names.
2. Use short sentences. Put one main instruction or fact in each sentence.
3. Use the active voice when you can. Tell the reader who must do the action.
4. Use the imperative for an instruction. Example: "Run the test." Do not hide an instruction in a long description.
5. Put a condition before the action. Example: "If the test fails, do not merge the PR."
6. Use positive instructions when possible. State prohibitions clearly when they are necessary for safety.
7. Give a number with its unit. Identify whether a value is a measurement, a limit, or an example.
8. Use the same term for the same concept. Do not use "engine", "backend", and "bridge" as synonyms.
9. Define a necessary technical term when it is not in the approved dictionary. Record it in the glossary. A local term is not automatically an ASD-STE100 approved word.
10. Review each changed document for sentence structure, word choice, ambiguity, and technical accuracy.

### Exact technical text

Do **not** change the spelling of identifiers, file paths, commands, GitHub links, protocol fields, code blocks, commit hashes, licences, or verbatim diagnostic messages only to make them look like controlled English.

The same rule applies to API signatures, test fixtures, required machine-readable formats, and quotations.
Do not change source-code behaviour as part of this editorial decision.
When text is a third-party quote or a historical record, identify its source.
Do not silently change a previously recorded result.

### Review and compliance status

Use these status terms:

* **STE-aligned draft:** The writer used the project rules. A complete ASD-STE100 check has not occurred.
* **Reviewed against ASD-STE100:** A reviewer used the applicable edition, its approved dictionary, and the writing rules. Record the edition and the method.
* **Not checked:** No controlled-language review occurred.

Do not write "ASD-STE100 compliant" unless a reviewer can show the applicable edition, a complete dictionary check, a rule check, and a review record.
A plain-language rewrite by a coding agent is an **STE-aligned draft**, not proof of compliance.

### Existing documentation

Revise current project-authored prose in a separate editorial PR.
Keep technical meaning, references, issue IDs, decision status, and test results.
Update the documentation index and the agent writing instructions.
Use a follow-up review with an authorised ASD-STE100 dictionary and checker before making a full compliance claim.

## Consequences

### Positive

* Readers get shorter instructions and more consistent terms.
* Reviews can find unclear conditions and hidden requirements.
* Agents have a clear rule for new prose.

### Negative

* Writers must review word choice and sentence structure.
* Some technical terms need local definitions.
* A full compliance review needs approved reference material and review effort.

## Confirmation

1. Check the new and changed Markdown files for short sentences and clear instructions.
2. Confirm that file paths, links, code blocks, tests, and technical claims still have the correct meaning.
3. Record the current review state as **STE-aligned draft**.
4. When the approved dictionary and a suitable checker are available, run a complete review. Record the edition and the result.
5. Review the rule after several PRs. Change this decision with a new MADR if the results show a problem.

## References

* [ASD-STE100 overview](https://www.asd-ste100.org/)
* [MADR 0001](0001-use-madr-and-ubiquitous-language.md)
* [MADR 0002](0002-risk-based-verification-and-selective-tdd.md)
