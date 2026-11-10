---
name: miniquad-native-safety
description: Audit and harden Miniquad Rust unsafe/FFI platform backends and resource/event lifecycles without claiming cross-target runtime coverage.
---

# Native Rust/FFI reliability and resilience

Use for `src/native/{windows,linux_x11,linux_wayland,macos,ios,android}*`, `java/`, or the shared GL backend. This is **not** a blanket ban on unsafe: audit explicit invariants at each FFI edge.

1. Freeze target OS/architecture, source revision, and what a local cross-compile can or cannot prove. Map callback registration, thread ownership, event dispatch and native handle create/destroy.
2. Trace pointer validity, lifetime and ownership for CStr/CString, JNI, Wayland/X11, WGL/EGL and GL. Inspect nullable API returns **before** calling `CStr::from_ptr`. Confirm `static mut`/global state has a verifiable synchronization or single-thread invariant; do not infer safety from a `Send`/`Sync` assertion.
3. For external input (drop files, clipboard, window messages), inspect long/non-Unicode paths, unreadable files, enormous payloads, cancellation, reentrancy and a platform error crossing an `extern` callback. Replace unchecked panics with documented fail-safe behavior where the contract permits.
4. For resources, check exact acquire/release symmetry (e.g. `DragFinish`, GL resources, file descriptors, JNI refs), duplicates and late completion after shutdown. Review exceptional paths separately from happy paths.
5. Test real supported OS behaviors if available, with small deterministic synthetic fixtures; cross-compile and Clippy are supporting gates, not runtime proof. Report missing platform access as blocked.
6. Route proven defects into an existing platform issue or one clustered native-backend keeper issue, with exact `path:line`, input, predicted outcome vs reproduced result, risk level and regression criteria.

Prefer small behavior-preserving fixes with tests to multi-platform rewrites. A null pointer or unsafe operation is a candidate to verify, not by itself proof of a remote exploit.
