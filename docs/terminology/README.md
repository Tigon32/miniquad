# Miniquad domain terminology

This folder contains Miniquad-specific concepts.
The shared engineering terms are in a separate repository.

Shared source: [Tigon32/technical-terminology](https://github.com/Tigon32/technical-terminology)
Reviewed commit: `0e755947aed328d5287e19e2f4adf0e46ae0549b`
Domain file: `miniquad.json`

Do not copy the shared dictionary or the shared validator into Miniquad.
The domain file uses stable concept IDs from the shared registry.

## Validation

Check out the shared repository at the exact commit above.
Run the shared validator against both files:

```sh
node .external/technical-terminology/scripts/validate.mjs \
  .external/technical-terminology/concepts/core.json \
  docs/terminology/miniquad.json
```

The `Terminology CI` workflow runs this test on a PR.
Use a new PR to change the pinned shared revision.
Do not use a moving branch reference.

The domain definitions are project-authored.
They are not a copy of the ASD-STE100 dictionary.
Full dictionary and writing-rule checks still need manual review.

**Writing review state:** STE-aligned draft.
