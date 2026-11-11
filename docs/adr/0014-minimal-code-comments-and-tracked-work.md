# Keep code comments minimal and track future work in issues

* Status: **Accepted**
* Date: 2026-11-11
* Scope: Project source, tests, and contributor instructions
* Related issue: [#141](https://github.com/Tigon32/miniquad/issues/141)

## Context and Problem Statement

The repository has old TODO comments and unfinished code paths.
A comment can describe a current limit, an obsolete request, or an unverified idea.
It does not prove that the code has a fault.

The repository owner requested minimal code comments and an evaluation of these work items.
Valid work needs an issue with evidence and acceptance conditions.
An inline comment must not become a second backlog.

## Decision Drivers

* Keep code clear without repeated explanations.
* Preserve safety, ownership, interface, and attribution requirements.
* Distinguish current behavior from proposed work.
* Give valid work one tracked issue for each related group of faults.
* Keep comment cleanup separate from behavior changes.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Explain most code with comments | Readers get more text | Text can repeat the code and become incorrect |
| Keep future work only in TODO comments | No issue work is needed | Comments have no acceptance conditions or verification record |
| **Use necessary comments and issue-backed work** | Important constraints remain visible | Each work item needs an evidence review |

## Decision Outcome

**Accepted:** Add a code comment only when it gives necessary information that clear code does not express.
Keep each comment short.
Explain a non-obvious reason or constraint, not an obvious operation.

Keep required licence and attribution notices.
Keep useful public API documentation, units, safety contracts, pointer ownership rules, and platform limits.
This decision does not require the removal of comments that supply this information.

For an existing work item:

1. Read the related code, callers, contract, tests, and issues.
2. Classify the item as obsolete, complete, duplicate, intentional limit, valid missing work, or not yet verified.
3. Remove an obsolete comment only when the evidence supports that result.
4. Put valid work in an existing issue for the same root cause, or create a distinct issue.
5. Record the source revision, expected result, observed result, acceptance conditions, and test limits.
6. If an inline note is still necessary, state the current constraint and link its issue.

Do not delete an unresolved obligation merely to reduce the TODO count.
Do not replace an unfinished function with a silent success result.
Do not add an abstraction, a dependency, or a delivery-file split merely because a comment proposes it.

Apply this rule to new and changed code.
Do not make an unrelated repository-wide comment rewrite.
Use [MADR 0002](0002-risk-based-verification-and-selective-tdd.md) for behavior tests.
Use [MADR 0003](0003-use-asd-ste100-for-communication.md) for project prose.

## Consequences

### Positive

* Important explanations remain close to the code.
* Issues hold acceptance conditions and verification evidence.
* Readers can distinguish a supported limit from a planned feature.

### Negative

* Some old comments need source and platform research.
* An unsupported test environment can leave an item unverified.

## Confirmation

Check new comments during review.
Confirm that each retained explanation supplies information the code does not make clear.
Check that comment cleanup preserves behavior and necessary notices.
Close an implementation issue only after its acceptance conditions pass.

## References

* [Agent instructions](../../AGENTS.md)
* [Source audit skill](../../.github/skills/miniquad-source-audit/SKILL.md)
* [MADR index](README.md)

**Writing review state:** STE-aligned draft. Full dictionary review not done.
