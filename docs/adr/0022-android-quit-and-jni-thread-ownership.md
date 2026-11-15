# Apply the quit contract and thread ownership on Android

* Status: **Proposed**
* Date: 2026-11-11
* Source: `7593d86b6e0699d6c905058c0008799c3cce39e5`
* Tracking: [#149](https://github.com/Tigon32/miniquad/issues/149), [#150](https://github.com/Tigon32/miniquad/issues/150), [#151](https://github.com/Tigon32/miniquad/issues/151)
* Writing review state: **STE-aligned draft**. Full dictionary review not done.

## Context and Problem Statement

Android ignores the public quit flags. Back finishes the activity without
the application callback. Native threads attach to the JVM but do not detach.
Asset reads leak native memory and can return bytes that were not read.

The Android source is not qualified for release. A cross-compile does not
prove the Android runtime behavior.

## Decision Drivers

* Preserve the public Rust signatures and result types.
* Apply the documented quit and cancellation behavior.
* Release only resources and thread attachments that Miniquad owns.
* Keep Android runtime limits visible.

## Considered Options

* Document Android quit as unsupported and leave the implementation unchanged.
* Apply the existing quit contract and repair native ownership.
* Replace the Android backend and bindings in one change.

## Decision Outcome

Implement the existing quit contract without a backend rewrite:

* `request_quit()` and Back request `quit_requested_event()` before finish.
* `cancel_quit()` in that callback keeps the activity open.
* `order_quit()` finishes the activity without a cancellation callback.
* OS destruction stops the render thread. An application cannot cancel it.
* Never hold the display mutex while the application callback runs.
* Wake a blocked Android event loop when a public function requests quit.
* Do not call `Activity.finish()` again after OS destruction.

Add a matching Java declaration and JNI callback for Back. This requires
Java and Rust sources from the same revision.

`attach_jni_env()` uses `GetEnv` first. Only a previously detached thread
gets a Miniquad-owned thread-local detach guard. JVM-owned threads do not.
Capture the VM in that private guard. Do not replace a live guard when a
caller manually detaches and attaches the same thread again.

The native asset loader transfers one malloc buffer to its Rust caller.
The caller copies and frees it. Close the asset on every path. Reject
invalid lengths, failed reads, and short reads. An empty asset succeeds.
Use a JNI local frame to release the Activity class and AssetManager
references after each read, including error paths.

## Consequences

The Rust API shape stays unchanged. Android Back becomes cancellable.
Applications that relied on immediate Back termination get the documented
application callback first.

Thread-local cleanup must run while the JVM remains live. This follows the
[JNI thread contract](https://developer.android.com/training/articles/perf-jni#threads).
No new native binding range or supported Android version is selected here.
The platform policy remains separate in [#156](https://github.com/Tigon32/miniquad/issues/156).

## Confirmation

Host tests cover exact asset-read outcomes and the real mutex/callback
sequence. Android and WASM cross-checks cover compilation only.

Before qualification, run Android device or emulator tests for repeated,
missing, and empty asset reads; record native heap use. Test request, cancel,
order, Back, and Destroy. Record JNI thread exit and user-thread behavior
with `adb logcat`. These runtime checks are **blocked** in this environment.
Keep #149, #150, and #151 open until their acceptance conditions pass.
