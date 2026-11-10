# Keep shared terminology in a separate repository

* Status: **Proposed**
* Date: 2026-11-10
* Scope: Reusable engineering terms and Miniquad domain terms
* Writing review state: **STE-aligned draft**

## Context and Problem Statement

The project needs one meaning for each technical term.
Other projects need some of the same terms.
A glossary in the Miniquad repository is not an independent source for other projects.

ASD-STE100 Issue 9 permits subject-specific technical nouns and verbs.
A local technical term is not automatically a word approved in the ASD-STE100 dictionary.

How can projects share terms without making another project depend on Miniquad?

## Decision Drivers

* Keep the shared terms independent of Miniquad.
* Give each concept one stable ID and preferred term.
* Keep project-specific terms in each project.
* Validate duplicate IDs and references.
* Do not add runtime dependencies.
* Do not copy the ASD-STE100 dictionary into the public repository.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| One Markdown glossary in Miniquad | Simple | Other projects depend on Miniquad |
| One full ontology in Miniquad | Rich concept links | It has the same ownership problem |
| **An independent shared registry and local domain extensions** | Reusable ownership and small project files | A separate repository and version policy are necessary |

## Decision Outcome

**Proposed:** Keep the reusable framework in a separate repository.

The independent repository will own the shared concepts, schema, validator, release tags, and documentation.
Do not store this framework under Miniquad.
The independent repository is [Tigon32/technical-terminology](https://github.com/Tigon32/technical-terminology).

Miniquad can keep `docs/terminology/miniquad.json`.
It contains **only Miniquad domain concepts**.
It can refer to stable IDs from the separate shared registry.
Use the pinned shared commit `0e755947aed328d5287e19e2f4adf0e46ae0549b` until a versioned release is available.
Do not download the latest shared terms during a required PR check.

Keep `docs/glossary.md` as the readable project glossary until a reviewed shared generator is available.
Keep the shared source pinned to a reviewed commit. Do not download a moving branch in CI.

## Full ontology decision

Do not add a full OWL or RDF ontology now.
Start with stable IDs, definitions, aliases, and simple relations.
If a real use case needs inference or formal queries, define the query and expected result.
Then, write a new MADR for a full ontology.

## Consequences

### Positive

* Another project can use the shared registry without Miniquad.
* Miniquad remains a small library.
* A shared concept keeps the same meaning in each project.

### Negative

* Shared releases need version control.
* A project must check its external references.
* Changes in the separate repository need independent reviews and pinned updates.
* A complete STE review still needs the approved rules and dictionary.

## Confirmation

1. Confirm that the separate terminology repository has its own source and policy.
2. Use the shared concepts and validation script at the pinned revision.
3. Validate the Miniquad extension with a fixed shared version.
4. Test the shared data with a second project.
5. Review whether a full ontology adds necessary value.

## References

* [MADR 0001](0001-use-madr-and-ubiquitous-language.md)
* [MADR 0003](0003-use-asd-ste100-for-communication.md)
* ASD-STE100 Issue 9, January 2025, Part 1, rules 1.5, 1.8, and 1.11.
