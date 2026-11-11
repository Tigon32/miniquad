# Architecture decision records

Use [MADR](https://adr.github.io/madr/) to record important technical decisions.
Use the [project glossary](../glossary.md) for technical terms.
Use [MADR 0003](0003-use-asd-ste100-for-communication.md) for the writing rules.
The documents are **STE-aligned drafts**. We have not completed a full ASD-STE100 dictionary check.

## Decision index

* [0001 — Use MADR and one technical glossary](0001-use-madr-and-ubiquitous-language.md) — **Proposed**
* [0002 — Use risk-based tests and selective TDD](0002-risk-based-verification-and-selective-tdd.md) — **Proposed**
* [0003 — Use ASD-STE100 for project communication](0003-use-asd-ste100-for-communication.md) — **Accepted**
* [0004 — Keep shared terminology in a separate repository](0004-reusable-concept-registry.md) — **Proposed**
* [0005 — Use low-cost CI and risk-based test lanes](0005-low-cost-ci-and-risk-based-test-lanes.md) — **Accepted**
* [0006 — Use a distinct project identity and retain Miniquad credits](0006-distinct-project-identity-and-upstream-attribution.md) — **Proposed**
* [0007 — Use supported and secure development tools](0007-use-supported-and-secure-toolchains.md) — **Accepted**
* [0008 — Keep optional voxel simulation outside Miniquad core](0008-optional-voxel-topologies.md) — **Proposed**
* [0009 — Keep browser adoption tools outside the core library](0009-optional-browser-adoption-layer.md) — **Proposed**
* [0011 — Add optional hexagonal-prism voxels beside cubic voxels](0011-optional-hexagonal-prism-topology.md) — **Proposed**
* [0012 — Add an optional 2D hex layout to the drawing companion](0012-optional-2d-hex-layouts.md) — **Proposed**
* [0014 — Keep code comments minimal and track future work in issues](0014-minimal-code-comments-and-tracked-work.md) — **Accepted**
* [0016 — Support a bounded set of modern, security-maintained platforms](0016-modern-platform-support-policy.md) — **Proposed**
* [0017 — Manage worktree ownership and post-merge cleanup](0017-manage-worktree-lifecycles.md) — **Accepted**

## Write a new decision

1. Copy the sections from MADR 0003.
2. Give the file the next number and a clear name.
3. Record the problem, options, decision, and effects.
4. Use short sentences and the terms in the glossary.
5. Link the related issue and pull request.
6. Do not change an **Accepted** decision without a new MADR. Use the status **Superseded** for the old decision.
