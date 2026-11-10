# Use a reusable concept registry before a full ontology

* Status: **Proposed**
* Date: 2026-11-10
* Scope: Technical terms that Miniquad and other projects can share
* Writing review state: **STE-aligned draft**

## Context and Problem Statement

Different projects can use different words for the same concept.
The current Miniquad glossary is useful for people.
Other tools cannot reliably read its terms and relations.

ASD-STE100 Issue 9 has a controlled dictionary and writing rules.
It also permits approved technical nouns and technical verbs from a subject field.
The standard does not require a full ontology for a company glossary.

How can the project share terms without a large new dependency?

## Decision Drivers

* Give each concept one stable ID and one preferred term.
* Share general engineering terms across projects.
* Keep Miniquad-specific terms separate.
* Add simple relationships that tools can validate.
* Preserve the meaning of each public API name.
* Use only project-authored definitions in the public repository.
* Do not copy the ASD-STE100 dictionary into GitHub.
* Make a complete review possible when an approved dictionary checker is available.

## Considered Options

| Option | Benefit | Problem |
| --- | --- | --- |
| One Markdown glossary only | Easy to read | Tools cannot reliably validate terms and links |
| **Namespaced JSON concepts and a generated Markdown glossary** | Reusable, readable, and easy to test | A small validation script is necessary |
| Full OWL/RDF ontology now | Can support formal semantics and queries | Needs governance, tooling, and a defined query use case |

## Decision Outcome

**Proposed:** Use a small concept registry.

The registry has these files:

* `docs/terminology/core.json`: Shared engineering terms.
* `docs/terminology/miniquad.json`: Miniquad terms.
* `docs/terminology/schema.json`: The data format.
* `scripts/terminology.mjs`: Validation and Markdown generation.
* `docs/glossary.md`: The generated glossary for readers.

Each concept has a stable ID, one preferred term, a definition, and a type.
An entry can also have aliases, a broader concept, and related concepts.

The `core` namespace must not refer to a Miniquad-specific concept.
Other projects can use the shared file without Miniquad.
A project can define its own namespace and additional terms.

Do not change the meaning of an existing concept ID.
If a concept changes meaning, add a new ID and document the replacement.
Use aliases only when the context makes their meaning clear.

The registry is **not** the ASD-STE100 dictionary.
A project technical term is not automatically an approved dictionary word.
Use the approved dictionary and the writing rules during a separate compliance review.

## Full ontology decision

Do not add OWL, RDF, SPARQL, or a graph database now.
Review a full ontology only if the project needs formal queries, logical constraints, or machine inference.
Write the required query and a sample result before the new decision.
Keep JSON export and stable concept IDs if a richer model becomes necessary.

## Consequences

### Positive

* Projects can share definitions and stable identifiers.
* CI can detect repeated IDs, missing references, and broken links.
* A reader can use the generated Markdown file.
* The runtime has no new dependency.

### Negative

* Contributors must keep the source files correct.
* A relationship can be correct in JSON but incorrect in the domain.
* A person must still review definitions and technical meaning.
* The data model does not prove ASD-STE100 compliance.

## Confirmation

1. Add representative shared and Miniquad concepts.
2. Run `node scripts/terminology.mjs --check`.
3. Add a negative test for duplicate IDs and missing relations.
4. Confirm that a project can use `core.json` without `miniquad.json`.
5. Review the model after it is used in a second repository.

## References

* [MADR 0001](0001-use-madr-and-ubiquitous-language.md)
* [MADR 0003](0003-use-asd-ste100-for-communication.md)
* ASD-STE100 Issue 9, January 2025, Part 1, rules 1.1, 1.5, 1.8, 1.11, and 1.12. The source is not reproduced here.
