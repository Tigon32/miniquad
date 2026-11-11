//! Benchmark-only counting allocator for issue #14 allocation-profiling
//! evidence. This crate is intentionally isolated from the `miniquad`
//! package (own `Cargo.toml`, no path dependency either direction) so the
//! root manifest is never edited to use it; see `Cargo.toml` in this
//! directory and `docs/browser-profiling.md`.
//!
//! The actual counting-allocator/churn/reuse logic lives in `core.rs` and
//! is pulled in with `include!`, not a module declaration, so the exact
//! same tokens can also be included by `examples/browser_perf.rs`'s
//! `alloc_profile` module without a Cargo dependency in either direction.
//! See `core.rs`'s module doc for the full `unsafe` contract.
include!("core.rs");

/// A bounded (`u64`/non-negative `i64`) point-in-time read of every counter.
/// Never a rate: callers that want a per-phase total take two snapshots and
/// call [`delta`], which is still a total over the window, not bytes/second.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AllocSnapshot {
    pub alloc_calls: u64,
    pub realloc_calls: u64,
    pub dealloc_calls: u64,
    pub live_bytes: i64,
    pub peak_bytes: u64,
}

pub fn snapshot() -> AllocSnapshot {
    AllocSnapshot {
        alloc_calls: ALLOC_CALLS.load(Ordering::Relaxed),
        realloc_calls: REALLOC_CALLS.load(Ordering::Relaxed),
        dealloc_calls: DEALLOC_CALLS.load(Ordering::Relaxed),
        live_bytes: LIVE_BYTES.load(Ordering::Relaxed),
        peak_bytes: PEAK_BYTES.load(Ordering::Relaxed),
    }
}

/// Window delta between two snapshots. Call-count fields are `u64` because
/// [`delta`] checks them non-negative and never silently clamps a backwards
/// count to 0. `live_bytes` is a real `i64` delta: more frees than allocs
/// inside a window is a legitimate, informative negative number, never an
/// error. `peak_bytes` is also a real `i64` delta, not range-checked: a
/// caller that called [`reset_peak`] between the two snapshots legitimately
/// observes a decrease (the watermark was rebased down), so this field is
/// reported as-is, with no non-negative assumption.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AllocDelta {
    pub alloc_calls: u64,
    pub realloc_calls: u64,
    pub dealloc_calls: u64,
    pub live_bytes: i64,
    pub peak_bytes: i64,
}

/// Returned by [`delta`] when a call-count field went backwards between
/// `before` and `after`. Unlike `live_bytes`/`peak_bytes`, call counters
/// never legitimately decrease for a correctly-ordered (before, after) pair
/// taken around one measured phase (nothing in this crate resets them), so
/// this is reported as an explicit, typed error rather than silently
/// clamped to a success-shaped zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllocDeltaError {
    CallCountWentBackwards {
        field: &'static str,
        before: u64,
        after: u64,
    },
}

/// Component-wise `after - before`, or an explicit [`AllocDeltaError`] if a
/// call-count field moved backwards (for example, `before`/`after` were
/// swapped by a caller mistake). Never silently reports a nonsensical
/// negative call count as a clamped zero.
pub fn delta(before: &AllocSnapshot, after: &AllocSnapshot) -> Result<AllocDelta, AllocDeltaError> {
    macro_rules! checked_field {
        ($field:ident) => {
            if after.$field < before.$field {
                return Err(AllocDeltaError::CallCountWentBackwards {
                    field: stringify!($field),
                    before: before.$field,
                    after: after.$field,
                });
            }
        };
    }
    checked_field!(alloc_calls);
    checked_field!(realloc_calls);
    checked_field!(dealloc_calls);
    Ok(AllocDelta {
        alloc_calls: after.alloc_calls - before.alloc_calls,
        realloc_calls: after.realloc_calls - before.realloc_calls,
        dealloc_calls: after.dealloc_calls - before.dealloc_calls,
        live_bytes: after.live_bytes - before.live_bytes,
        peak_bytes: after.peak_bytes as i64 - before.peak_bytes as i64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[global_allocator]
    static ALLOC: CountingAllocator = CountingAllocator::new();

    /// `ALLOC_CALLS`/`LIVE_BYTES`/`PEAK_BYTES` are process-wide statics, but
    /// `cargo test`'s default harness runs test functions concurrently on
    /// multiple OS threads. Each test below asserts an absolute (not just
    /// non-decreasing) call count or live-byte value around its own narrow
    /// window, so a second test's activity touching the same statics while
    /// this one is mid-measurement is a real cross-test race, not a flaky
    /// test: confirmed by directly observing this crate's `cargo test`
    /// (default parallel threads, 12 logical CPUs here) fail
    /// nondeterministically, while `--test-threads=1` passed 8/8 repeated
    /// runs. This lock makes each test body's own measured window mutually
    /// exclusive with every other test body, but it does **not** fully
    /// eliminate the race: `--test-threads=2` was directly observed to
    /// still fail with this lock in place, because the harness's own
    /// per-thread setup/teardown around a test body (for example thread
    /// spawn/stdout-capture machinery) still touches the global allocator
    /// outside any lock a test body can take. This crate's tests are
    /// therefore run with `--test-threads=1` (see `docs/browser-
    /// profiling.md`), and this lock is kept only as defense-in-depth
    /// documentation of each test's own intended isolation, not as a
    /// sufficient fix by itself. This does not change
    /// `CountingAllocator`'s own thread-safety (it stays correct for
    /// concurrent allocation from real multi-threaded benchmarks), only
    /// this module's self-test isolation.
    static TEST_SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn noop_control_is_exactly_zero() {
        let _guard = TEST_SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = snapshot();
        let after = snapshot();
        let d = delta(&before, &after).expect("a no-op phase never moves a call count backwards");
        assert_eq!(
            d.alloc_calls, 0,
            "a no-op phase must detect zero new allocations"
        );
        assert_eq!(d.realloc_calls, 0);
        assert_eq!(d.dealloc_calls, 0);
        assert_eq!(d.live_bytes, 0);
        assert_eq!(d.peak_bytes, 0);
    }

    #[test]
    fn known_allocation_and_deallocation_are_detected() {
        let _guard = TEST_SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_peak(); // isolate this window's peak from any process-wide history
        let before = snapshot();
        {
            let v: Vec<u8> = vec![0u8; 4096];
            let during = snapshot();
            let during_delta =
                delta(&before, &during).expect("allocation only ever increases call counts");
            assert!(
                during_delta.alloc_calls >= 1,
                "allocating a Vec must record at least one alloc call"
            );
            assert!(
                during_delta.live_bytes >= 4096,
                "live bytes must reflect the allocated Vec"
            );
            assert!(
                during_delta.peak_bytes >= 4096,
                "peak bytes must reach at least the allocated size"
            );
            std::hint::black_box(&v);
        }
        let after = snapshot();
        let full_delta = delta(&before, &after).expect("drop only ever increases dealloc_calls");
        assert!(
            full_delta.dealloc_calls >= 1,
            "dropping the Vec must record at least one dealloc call"
        );
        assert_eq!(
            full_delta.live_bytes, 0,
            "live bytes must return to the pre-allocation level after drop"
        );
    }

    #[test]
    fn churn_and_reuse_produce_identical_output_with_different_allocation_counts() {
        let _guard = TEST_SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        const FRAMES: usize = 20;
        const COUNT: usize = 32;
        const SEED: u64 = 7;

        // Per-frame checksums, not cloned Vecs: a `.clone()` call on each
        // frame's output would itself allocate inside the measured window,
        // hiding the real reuse-vs-churn difference this test exists to
        // show. A fixed-size `[f32; FRAMES]` array, allocated on the stack
        // before either snapshot, never allocates on the heap, so it can
        // record "same functional output" without polluting either phase's
        // counters.
        let mut churn_checksums = [0f32; FRAMES];
        let mut reuse_checksums = [0f32; FRAMES];

        // Isolated phase 1: deliberate churn, one Vec per frame.
        let mut scratch = Vec::new();
        let before_churn = snapshot();
        for frame in 0..FRAMES {
            let output = churn_frame(COUNT, SEED + frame as u64);
            churn_checksums[frame] = checksum(&output);
        }
        let after_churn = snapshot();
        let churn_delta =
            delta(&before_churn, &after_churn).expect("churn only ever increases alloc_calls");

        // Isolated phase 2: repeated reuse of one scratch buffer.
        let before_reuse = snapshot();
        for frame in 0..FRAMES {
            reuse_frame(&mut scratch, COUNT, SEED + frame as u64);
            reuse_checksums[frame] = checksum(&scratch);
        }
        let after_reuse = snapshot();
        let reuse_delta =
            delta(&before_reuse, &after_reuse).expect("reuse only ever increases alloc_calls");

        // Same functional output: never change production default behavior.
        assert_eq!(
            churn_checksums, reuse_checksums,
            "churn and reuse must render identical per-frame output"
        );

        // Real detected difference: churn allocates its Vec's backing store
        // every frame; reuse only grows `scratch` once (frame 0) and then
        // makes no further allocation calls for the remaining frames at the
        // same or smaller size.
        assert_eq!(
            churn_delta.alloc_calls, FRAMES as u64,
            "each churn frame must allocate exactly one new Vec backing store"
        );
        assert!(
            reuse_delta.alloc_calls < churn_delta.alloc_calls,
            "reuse must perform strictly fewer allocation calls than churn for identical output"
        );
        assert!(
            reuse_delta.alloc_calls <= 1,
            "reuse must allocate at most once (the initial grow), then make no further alloc calls"
        );
    }

    #[test]
    fn delta_rejects_a_call_count_that_moved_backwards() {
        let before = AllocSnapshot {
            alloc_calls: 10,
            realloc_calls: 0,
            dealloc_calls: 5,
            live_bytes: 100,
            peak_bytes: 200,
        };
        let after = AllocSnapshot {
            alloc_calls: 9, // moved backwards: caller passed (before, after) swapped, or bad input
            ..before
        };
        let err = delta(&before, &after)
            .expect_err("a decreasing alloc_calls must be rejected, not clamped to 0");
        assert_eq!(
            err,
            AllocDeltaError::CallCountWentBackwards {
                field: "alloc_calls",
                before: 10,
                after: 9
            }
        );
    }

    #[test]
    fn delta_reports_negative_live_and_peak_bytes_as_valid_after_a_reset() {
        // Simulates taking a snapshot, calling reset_peak(), then taking a
        // second snapshot after more frees than allocs: both deltas are
        // legitimately negative and must be reported exactly, not clamped.
        let before = AllocSnapshot {
            alloc_calls: 50,
            realloc_calls: 0,
            dealloc_calls: 40,
            live_bytes: 1000,
            peak_bytes: 1500,
        };
        let after = AllocSnapshot {
            alloc_calls: 55,
            realloc_calls: 0,
            dealloc_calls: 48, // more frees than allocs since `before` => live_bytes drops
            live_bytes: 600,
            peak_bytes: 50, // reset_peak() rebased this below `before.peak_bytes`
        };
        let d = delta(&before, &after).expect("live_bytes/peak_bytes decreasing is never an error");
        assert_eq!(
            d.live_bytes, -400,
            "a real net-free window must report a negative delta, not 0"
        );
        assert_eq!(
            d.peak_bytes, -1450,
            "a post-reset peak below the prior window's peak must be reported exactly"
        );
    }
}
