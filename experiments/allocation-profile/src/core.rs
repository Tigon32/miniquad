// Shared counting-allocator core for issue #14. Included (never linked as a
// Cargo dependency) by both `experiments/allocation-profile/src/lib.rs` and
// the benchmark-only `alloc_profile` module in `examples/browser_perf.rs`
// via `include!("core.rs")` / `include!("../experiments/allocation-profile/
// src/core.rs")`. `include!` splices these tokens into the including file
// at compile time; it adds no crate, no path dependency, and needs no root
// `Cargo.toml` edit, while keeping both call sites byte-identical instead of
// two independently-maintained copies.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

static ALLOC_CALLS: AtomicU64 = AtomicU64::new(0);
static REALLOC_CALLS: AtomicU64 = AtomicU64::new(0);
static DEALLOC_CALLS: AtomicU64 = AtomicU64::new(0);
/// Signed because a snapshot delta can observe more frees than allocations
/// within the measured window (bytes freed that were allocated earlier).
static LIVE_BYTES: AtomicI64 = AtomicI64::new(0);
static PEAK_BYTES: AtomicU64 = AtomicU64::new(0);

fn update_peak(live: i64) {
    if live <= 0 {
        return;
    }
    let live = live as u64;
    let mut observed = PEAK_BYTES.load(Ordering::Relaxed);
    while live > observed {
        match PEAK_BYTES.compare_exchange_weak(observed, live, Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => break,
            Err(current) => observed = current,
        }
    }
}

fn record_alloc(bytes: i64) {
    ALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
    let live = LIVE_BYTES.fetch_add(bytes, Ordering::Relaxed) + bytes;
    update_peak(live);
}

fn record_dealloc(bytes: i64) {
    DEALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
    LIVE_BYTES.fetch_sub(bytes, Ordering::Relaxed);
}

fn record_realloc(old_bytes: i64, new_bytes: i64) {
    REALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
    let live =
        LIVE_BYTES.fetch_add(new_bytes - old_bytes, Ordering::Relaxed) + (new_bytes - old_bytes);
    update_peak(live);
}

/// Benchmark-only global allocator. Do not install this in production code;
/// it exists to make real `alloc`/`realloc`/`dealloc` call counts and live
/// byte totals observable for issue #14 evidence, not to change allocation
/// behavior or performance.
///
/// # `unsafe` contract (read before changing this file)
///
/// Every method here delegates unchanged to `System`, which already
/// satisfies `GlobalAlloc`'s safety contract for the arguments it receives
/// (same `Layout`/pointer it was given, per the trait's own caller
/// contract). The only work added is a fetch-add/fetch-sub on a plain
/// atomic with `Ordering::Relaxed`, never a heap allocation, lock, or
/// panic, so this cannot recurse into itself or deadlock from inside
/// `alloc`/`dealloc`/`realloc`. Counters are process-wide `static`s, so
/// concurrent allocation from multiple threads is reflected correctly
/// (each call still records exactly once), but a snapshot taken from one
/// thread while another thread allocates is only accurate as of some
/// interleaving, not a single atomic point in time; both call sites that
/// include this file run single-threaded benchmarks, so that limit does
/// not affect their results.
pub struct CountingAllocator;

impl CountingAllocator {
    pub const fn new() -> Self {
        CountingAllocator
    }
}

impl Default for CountingAllocator {
    fn default() -> Self {
        Self::new()
    }
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            record_alloc(layout.size() as i64);
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc_zeroed(layout);
        if !ptr.is_null() {
            record_alloc(layout.size() as i64);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        record_dealloc(layout.size() as i64);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_ptr = System.realloc(ptr, layout, new_size);
        if !new_ptr.is_null() {
            record_realloc(layout.size() as i64, new_size as i64);
        }
        new_ptr
    }
}

/// Rebase the peak watermark to the current live total. `PEAK_BYTES` is a
/// process-wide monotonic maximum by design; resetting it lets a caller
/// isolate "the peak reached strictly within this window" (an absolute
/// reading taken right after the reset) instead of reporting the
/// difference between two unrelated global watermarks. Single-threaded use
/// only: a concurrent allocation between the `load` and `store` below
/// could be rebased away, which is acceptable for this file's
/// single-threaded benchmarks and documented here rather than left
/// implicit.
pub fn reset_peak() {
    let live = LIVE_BYTES.load(Ordering::Relaxed).max(0) as u64;
    PEAK_BYTES.store(live, Ordering::Relaxed);
}

/// One frame-shaped element (4 `f32`s), matching `examples/browser_perf.rs`
/// `Vertex`'s layout without depending on that type, so this file stays a
/// single shared copy usable from both call sites.
pub type Elem = [f32; 4];

fn make_elem(i: usize, seed: u64) -> Elem {
    let v = ((seed.wrapping_add(i as u64)) % 1000) as f32 / 1000.0;
    [v, v, v, 1.0 - v]
}

/// Deliberate churn: a fresh `Vec` every call, matching the production
/// `stress_vertices` collection pattern in `examples/browser_perf.rs`.
pub fn churn_frame(count: usize, seed: u64) -> Vec<Elem> {
    (0..count).map(|i| make_elem(i, seed)).collect()
}

/// Reuse: write into a scratch buffer the caller keeps across calls,
/// growing it only if it is too small, so steady-state repeated calls at or
/// below the high-water-mark size make no further allocation calls.
pub fn reuse_frame(scratch: &mut Vec<Elem>, count: usize, seed: u64) {
    scratch.clear();
    scratch.reserve(count);
    for i in 0..count {
        scratch.push(make_elem(i, seed));
    }
}

pub fn checksum(elems: &[Elem]) -> f32 {
    elems
        .iter()
        .fold(0f32, |acc, e| acc + e[0] + e[1] + e[2] + e[3])
}
