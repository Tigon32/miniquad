# Use a distinct project identity and retain the Miniquad source history

* Status: **Proposed**
* Date: 2026-11-10
* Scope: Repository name, package name, documentation, and source attribution
* Writing review state: **STE-aligned draft**

## Context and Problem Statement

This project started as a fork of [Miniquad](https://github.com/not-fl3/miniquad).
The fork now adds tests, policies, and changes to the browser interface.
The proposed roadmap also includes voxel worlds and optional server-side execution.

Those new features are **proposed**. They are not yet part of the supported API.
The old project name does not describe the intended long-term scope.

The owner wants a new project name.
The owner also requires clear credit for the original project and contributors.
The new name is **not selected**.

## Decision Drivers

* Give the new project its own identity.
* Keep the original code history and licence notices.
* Identify the exact source from which the project evolved.
* Avoid breaking current Rust users without a migration plan.
* Preserve the JS/WASM interface until its replacement has tests.
* Do not claim that proposed features exist.
* Keep the name independent of one game or rendering technique.
* Keep a clear route for upstream changes and their attribution.

## Options

| Option | Benefit | Problem |
| --- | --- | --- |
| Keep `miniquad` as the long-term name | No migration work | The name does not identify the wider project |
| Rename the GitHub repository and Rust crate at once | One visible identity | It can break dependency URLs and package names |
| **Give the project a new identity in stages** | Clear credit and a tested migration | Old and new names coexist during migration |

## Proposed Decision

**Proposed:** Select a new project name before the code or package rename.
Use one primary name in the README, repository, release notes, and documentation.

The new project must be distinct from Miniquad.
The original Miniquad name must remain in its source attribution.
Do not suggest that the upstream maintainers endorse the new project.

### Keep the source and licence record

1. Retain the Git commit history where the hosting platform permits it.
2. Keep `LICENSE-MIT` and `LICENSE-APACHE` and all required notices.
3. Keep the original copyright notices.
4. Give credit to Fedor Logachev and the original Miniquad project.
5. Link the upstream repository and its original licence.
6. Describe fork-specific changes as this project's work.
7. If a source file has another author or licence, retain that notice.

### Rename in separate steps

1. **Choose and review the name.** Check repository, package, domain, and trademark conflicts before public release.
2. **Prepare the project identity.** Update the README, documentation, source links, and diagrams. Keep an explicit upstream attribution page.
3. **Rename the GitHub repository.** Check redirects, forks, workflows, and outside references. Do not assume every external link still works.
4. **Plan the Rust crate name.** A new `[package].name` changes dependency resolution. Keep a separate compatibility decision and migration guide.
5. **Review the JS/WASM interface.** Do not change import names or the ABI version for branding alone.
6. **Test the migration.** Build the old API examples and new package examples. Run the required CI and browser tests.
7. **Release and communicate.** Publish the new name and support policy. State which old names remain compatible.

The original crate name `miniquad` stays in `Cargo.toml` until the owner selects the new name and approves the compatibility plan.

## Consequences

### Positive

* The new identity can describe a wider game engine.
* Users can find the original Miniquad source and licence.
* Existing consumers get a defined migration path.

### Negative

* Two names can appear in documentation during migration.
* Some users must change Git URLs or Rust dependency declarations.
* Trademark, package availability, and compatibility need review.

## Confirmation

1. Record the selected project name and its conflict review.
2. Confirm that the upstream attribution and required licence files remain.
3. Test examples against the new crate or migration alias.
4. Verify that repository links and CI checks work after the rename.
5. Update this proposed decision or supersede it with an accepted naming decision.

## References

* [Original Miniquad repository](https://github.com/not-fl3/miniquad)
* [Upstream attribution](../upstream-attribution.md)
* [MADR 0003 — Technical writing](0003-use-asd-ste100-for-communication.md)
* [MADR 0004 — Independent technical terminology](0004-reusable-concept-registry.md)
