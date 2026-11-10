# Browser and WebGL upstream triage

* Date: 2026-11-10
* Fork source: [`5b60b7db7c7b8ff059d8c823b8185ae7ece5d807`](https://github.com/Tigon32/miniquad/tree/5b60b7db7c7b8ff059d8c823b8185ae7ece5d807)
* Upstream: [not-fl3/miniquad](https://github.com/not-fl3/miniquad)
* State: **Source and upstream-metadata review**
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

This document assigns each relevant upstream report to one local issue.
It does not claim that a merged patch passes all browser or native tests.
All upstream issues and PRs in the table were **open** when reviewed on 2026-11-10.
A local merge does not close the upstream PR or issue.

## Upstream issue mapping

| Upstream report | Problem | Local owner | Disposition |
| --- | --- | --- | --- |
| [#577](https://github.com/not-fl3/miniquad/issues/577) | WebGL1 render-target failure reported with a Macroquad example | [#13](https://github.com/Tigon32/miniquad/issues/13) and [#11](https://github.com/Tigon32/miniquad/issues/11) | **Test pending.** Add a WebGL1 offscreen-render test. Do not claim the imported cache fix repairs this report. |
| [#588](https://github.com/not-fl3/miniquad/issues/588) | The JS bridge expects a canvas when the script starts | [#15](https://github.com/Tigon32/miniquad/issues/15) and [#8](https://github.com/Tigon32/miniquad/issues/8) | **Design pending.** Test delayed canvas creation and lifecycle separation before changing the API. |
| [#612](https://github.com/not-fl3/miniquad/issues/612) | Firefox ResistFingerprinting can produce invalid time values | [#15](https://github.com/Tigon32/miniquad/issues/15) and [#12](https://github.com/Tigon32/miniquad/issues/12) | **Reproduction pending.** Record Firefox mode and frame-time values before changing the timing source. |
| [#633](https://github.com/not-fl3/miniquad/issues/633) | Deleted texture handle reused during mobile WebGL scene changes | [#13](https://github.com/Tigon32/miniquad/issues/13) | **Patch present; test pending.** Fork PR #2 imports upstream #691. Test texture delete/recreate on real mobile browsers. |
| [#517](https://github.com/not-fl3/miniquad/issues/517) | Proposed change to keyboard input events and API | [#8](https://github.com/Tigon32/miniquad/issues/8) and [#19](https://github.com/Tigon32/miniquad/issues/19) | **Deferred API proposal.** Current bridge input defects are tested separately. Any breaking event API needs a new MADR and compatibility plan. |

## Upstream pull request mapping

| Upstream PR | Current upstream state | Fork status | Next action |
| --- | --- | --- | --- |
| [#602](https://github.com/not-fl3/miniquad/pull/602) — release mouse outside canvas | Open | **Integrated** by [fork PR #1](https://github.com/Tigon32/miniquad/pull/1) | Keep the window mouse-up regression under #8 and #11 |
| [#698](https://github.com/not-fl3/miniquad/pull/698) — Cmd/modifier and key release | Open | **Integrated** by fork PR #1 | Keep focus/key-transition tests under #8 and #21 |
| [#701](https://github.com/not-fl3/miniquad/pull/701) — clipboard focus isolation | Open | **Integrated** by fork PR #1 | Keep clipboard behavior tests under #8 and #21 |
| [#691](https://github.com/not-fl3/miniquad/pull/691) — texture cache cleanup | Open | **Integrated** by [fork PR #2](https://github.com/Tigon32/miniquad/pull/2) | Run actual WebGL delete/recreate tests under #13 |
| [#682](https://github.com/not-fl3/miniquad/pull/682) — replace GPU buffer storage on updates | Open | **Integrated** by fork PR #2 | Verify correct output and measure GPU upload cost under #14 and #12 |
| [#587](https://github.com/not-fl3/miniquad/pull/587) — remove duplicate WASM loader code | Open | **Equivalent local work** in [fork PR #38](https://github.com/Tigon32/miniquad/pull/38) | Do not copy the old patch over the newer validated loader. Test both load paths under #15 |
| [#692](https://github.com/not-fl3/miniquad/pull/692) — asynchronous shader compilation | Open | **Not integrated** | Hold for the measured optimization work in #14 and #12. It changes the shader API. Write a compatibility decision first |

## Existing fork work

[PR #1](https://github.com/Tigon32/miniquad/pull/1) merged selected browser input changes.
[PR #2](https://github.com/Tigon32/miniquad/pull/2) merged texture cache and buffer changes.
These are **source integrations**.
They do not establish full GPU or browser platform qualification.

[PR #38](https://github.com/Tigon32/miniquad/pull/38) replaced the old missing-import fallback.
It also rejects ABI version mismatches.
[PR #44](https://github.com/Tigon32/miniquad/pull/44) corrected the Quote and Slash codes.
The required Chromium smoke and Node tests passed for those local PRs.
Firefox, desktop WebKit, iOS Safari, and Android Chrome still need the relevant deep tests.

## Rules for future upstream changes

1. Read the current upstream issue or PR and record its revision.
2. Check whether the source change already exists in this fork.
3. Use one local issue for each fault family.
4. Record what changed in each supported browser and platform.
5. Write a failing test for a reproducible defect.
6. Check a compatible patch in a small integration PR.
7. Compare performance with an unchanged workload when the patch changes GPU behavior.
8. Do not close an upstream report from a local source merge.
9. If a patch changes the public API, use a MADR before integration.
10. Keep source links, checks, and test limits in the local keeper issue.

## Remaining qualification

The following work is **not done** by this triage:

* Browser input and loader compatibility: #8, #11 and #21.
* WebGL1 render targets, mobile textures and GPU lifecycle: #13.
* Firefox privacy timing and loader architecture: #15.
* Rust buffer and shader performance measurements: #12 and #14.
* A versioned Rust API change and release compatibility: #19.

The upstream triage can close when this mapping is reviewed.
The linked implementation and runtime issues must remain open.
