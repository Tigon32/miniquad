# Adopt MADR and a ubiquitous language

* Status: **Proposed**
* Date: 2026-11-10
* Decision scope: Miniquad fork and its agentic development workflow

## Context and Problem Statement

Miniquad spans Rust, the JavaScript browser bridge, and platform-specific integrations such as Android Java. Contributors and coding agents may use different names for the same concept, or the same name for different concepts. This makes implementation, reviews, automated changes, and cross-platform testing harder to reason about.

How should we capture important engineering decisions and keep the vocabulary consistent across code, issues, pull requests, agents, and documentation?

## Decision Drivers

* Lightweight, repository-local documentation compatible with GitHub and AI coding agents.
* Consistent meanings across Rust, WebAssembly, JavaScript, WebGL, and native targets.
* Ability to revisit an architectural choice without rewriting history.
* Minimal build-time and runtime dependencies.

## Considered Options

* No formal vocabulary or decision record process.
* Only an informal glossary.
* **MADR-style architectural decision records plus one maintained glossary**.

## Decision Outcome

**Proposed:** Use Markdown Architectural Decision Records (MADR) for important decisions and keep the canonical glossary in [../glossary.md](../glossary.md).

* Create numbered decision records in `docs/adr/`, using the sections **Context and Problem Statement**, **Decision Drivers**, **Considered Options**, **Decision Outcome**, and **Consequences**.
* Use statuses **Proposed**, **Accepted**, **Deprecated**, or **Superseded**; never silently rewrite the rationale for an accepted decision. Record a successor decision instead.
* Use the glossary's preferred terminology in code reviews, issues, PR descriptions, agent prompts, and documentation. Existing public API names are not automatically renamed.
* If a term is missing or ambiguous, propose its definition in the same PR as the change that introduces it.
* Scope the glossary to Miniquad's graphics/runtime concepts. Any future game can extend it in its own repository rather than conflating game and rendering terminology.
* Changes to `master` still follow required PR and CI rules; this documentation does not replace code tests.

## Consequences

### Positive

* Faster review and more reliable agentic changes thanks to explicit shared meaning.
* Decisions become discoverable, auditable and easy to supersede.
* No production code or runtime footprint is added.

### Negative

* PR authors need to keep terms and decisions updated.
* Documentation can become stale if reviews do not enforce it.

## Confirmation

* Review whether new public concepts are reflected in `docs/glossary.md`.
* Link relevant ADRs from future architecture-changing PRs.
* Revisit this decision after several real PRs to see whether the process is helping.

## References

* https://adr.github.io/madr/
