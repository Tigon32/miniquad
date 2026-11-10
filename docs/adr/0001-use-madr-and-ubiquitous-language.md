# Use MADR and one technical glossary

* Status: **Proposed**
* Date: 2026-11-10
* Scope: Miniquad development

## Context and Problem Statement

Miniquad has Rust, JavaScript, WebAssembly, and native code.
Different terms for the same part can cause errors.
A person or an agent can also use one word for two different parts.

We need a record of important technical decisions.
We also need one source for the meanings of technical terms.

## Decision Drivers

* Keep project instructions in the repository.
* Use the same words in issues, pull requests, and code reviews.
* Record why a technical decision was made.
* Let reviewers find and change an old decision.
* Do not add runtime dependencies for documentation.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| No formal records | No extra documentation | A reason for a decision can become lost |
| A glossary only | One set of terms | No record of decisions |
| **MADR records and one glossary** | One record of decisions and terms | Writers must keep both current |

## Decision Outcome

**Proposed:** Use Markdown architecture decision records (MADR).
Keep them in `docs/adr/`.
Use [the project glossary](../glossary.md) for technical terms.

1. Give each new decision a number.
2. Record the problem, options, decision, and effects.
3. Use the status **Proposed**, **Accepted**, **Deprecated**, or **Superseded**.
4. When a decision changes, add a new MADR. Do not remove the old reason.
5. Use the glossary terms in project instructions and reviews.
6. If a change adds a technical term, define it in the glossary.
7. Do not change existing public API names for an editorial reason only.
8. Keep this glossary about Miniquad. A game can have a separate glossary.
9. Use [MADR 0003](0003-use-asd-ste100-for-communication.md) for controlled English.
10. Use a protected pull request and the required tests for changes to `master`.

## Consequences

### Positive

* Reviewers can find a decision and its reason.
* Agents can use one set of technical terms.
* Documentation does not change the runtime binary.

### Negative

* Writers must keep the records current.
* Out-of-date terms can cause errors.

## Confirmation

1. Check new technical terms against the glossary.
2. Link relevant decisions from a PR.
3. Review this method after several PRs.

## References

* [MADR](https://adr.github.io/madr/)
* [Technical glossary](../glossary.md)
