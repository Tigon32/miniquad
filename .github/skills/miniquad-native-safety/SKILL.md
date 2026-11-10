---
name: miniquad-native-safety
description: Check native Rust and FFI code for pointer, callback, resource, and error-handling faults.
---

# Check native code safety

Use this skill for code in `src/native/`, `java/`, and native GPU interfaces.
Read [AGENTS.md](../../../AGENTS.md) and the related issue first.
The presence of `unsafe` does not prove a security fault.

## Procedure

1. Record the target OS, CPU, and source SHA.
2. Find each resource that the code creates. Find the code that releases it.
3. Check raw pointers, null results, memory ownership, and function lifetime.
4. Check `CString`, `CStr`, JNI, X11, Wayland, WGL, EGL, and GL at the interface where they are used.
5. Check shared state. Do not assume that `Send` or `Sync` makes a pointer safe.
6. Test empty, long, invalid, and unreadable input where possible.
7. Check all `unwrap` and `panic!` calls in external callbacks.
8. Check that cleanup occurs after a partial failure or cancellation.
9. Check whether the same callback can run more than once.
10. Run a small repeatable test on the required OS.
11. If that OS is not available, record the result as **blocked**. A cross-compile is not a runtime test.

## Report

Give the exact source line, input, expected result, and observed result.
State the risk and what is not known.
Add the result to an existing issue when the root cause is the same.
Use one issue for each group of related faults.

**Writing review state:** STE-aligned draft. Full dictionary review not done.
