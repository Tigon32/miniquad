//! Bounded allocator for bytes that cross the JavaScript-to-Rust ownership
//! boundary (`docs/webgpu-proof-contract.md` section 7).
//!
//! `mq_proof_alloc` hands JavaScript a fresh buffer. A later callback claims
//! it exactly once by pointer and length. `mq_proof_free` releases a buffer
//! that JavaScript could not deliver to a callback. An unknown pointer or a
//! mismatched length never reaches a raw-parts reconstruction.

use std::cell::RefCell;
use std::collections::HashMap;

const MAX_ALLOCATION: usize = 16 * 1024 * 1024;
const MAX_OUTSTANDING: usize = 16 * 1024 * 1024 + 4096;
const MAX_COUNT: usize = 256;

#[derive(Default)]
struct Registry {
    buffers: HashMap<usize, Vec<u8>>,
    reserved: usize,
}

thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default());
}

/// Allocates `len` bytes owned by Rust. Returns a null pointer on failure
/// (the limit was reached, or the host asked for too much memory).
pub fn alloc(len: usize) -> *mut u8 {
    if len > MAX_ALLOCATION {
        return std::ptr::null_mut();
    }
    REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        if registry.buffers.len() >= MAX_COUNT {
            return std::ptr::null_mut();
        }
        if len > MAX_OUTSTANDING.saturating_sub(registry.reserved) {
            return std::ptr::null_mut();
        }
        let mut bytes = Vec::new();
        if bytes.try_reserve_exact(len).is_err() {
            return std::ptr::null_mut();
        }
        bytes.resize(len, 0);
        let ptr = bytes.as_mut_ptr();
        registry.reserved += len;
        registry.buffers.insert(ptr as usize, bytes);
        ptr
    })
}

/// Claims a buffer exactly once. Returns `None` for an unknown pointer or a
/// length that does not match the original allocation; the entry is removed
/// either way, so a second claim attempt also fails.
pub fn claim(ptr: *mut u8, len: usize) -> Option<Vec<u8>> {
    if ptr.is_null() {
        return if len == 0 { Some(Vec::new()) } else { None };
    }
    REGISTRY.with(|registry| {
        let mut registry = registry.borrow_mut();
        let bytes = registry.buffers.remove(&(ptr as usize))?;
        registry.reserved -= bytes.len();
        if bytes.len() != len {
            return None;
        }
        Some(bytes)
    })
}

/// Frees a buffer the host could not deliver to a callback. A no-op for a
/// null pointer or an unknown pointer.
pub fn free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let _ = claim(ptr, len);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alloc_then_claim_round_trips_bytes() {
        let ptr = alloc(5);
        assert!(!ptr.is_null());
        unsafe {
            for (i, byte) in [1u8, 2, 3, 4, 5].iter().enumerate() {
                *ptr.add(i) = *byte;
            }
        }
        let bytes = claim(ptr, 5).expect("claim must succeed for a matching length");
        assert_eq!(bytes, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn claim_twice_fails_the_second_time() {
        let ptr = alloc(4);
        assert!(claim(ptr, 4).is_some());
        assert!(claim(ptr, 4).is_none(), "a claimed buffer must not be claimed twice");
    }

    #[test]
    fn claim_with_mismatched_length_fails_and_still_removes_the_entry() {
        let ptr = alloc(8);
        assert!(claim(ptr, 3).is_none(), "a wrong length must not reconstruct the buffer");
        assert!(claim(ptr, 8).is_none(), "a mismatched claim must remove the entry");
    }

    #[test]
    fn claim_rejects_an_unknown_pointer() {
        let bogus = 0x1000 as *mut u8;
        assert!(claim(bogus, 4).is_none());
    }

    #[test]
    fn zero_length_uses_a_null_pointer_and_an_empty_buffer() {
        assert_eq!(claim(std::ptr::null_mut(), 0), Some(Vec::new()));
        assert_eq!(claim(std::ptr::null_mut(), 1), None);
    }

    #[test]
    fn alloc_rejects_a_request_over_the_single_allocation_limit() {
        assert!(alloc(MAX_ALLOCATION + 1).is_null());
    }

    #[test]
    fn free_is_a_no_op_for_a_null_or_unknown_pointer() {
        free(std::ptr::null_mut(), 0);
        free(0x2000 as *mut u8, 4);
    }
}
