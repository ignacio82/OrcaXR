//! Synthetic allocation evidence, not a device-performance qualification.
use orcaxr_contracts::canonical::parse;
use orcaxr_project::assets::AssetRepository;
use orcaxr_project::ids::AssetId;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

const PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
static TRACK: AtomicBool = AtomicBool::new(false);
static LARGE_ALLOCS: AtomicUsize = AtomicUsize::new(0);
static LARGE_BYTES: AtomicUsize = AtomicUsize::new(0);
struct Counted;
fn count(size: usize) {
    if TRACK.load(Ordering::Relaxed) && size >= PAYLOAD_BYTES {
        LARGE_ALLOCS.fetch_add(1, Ordering::Relaxed);
        LARGE_BYTES.fetch_add(size, Ordering::Relaxed);
    }
}
// SAFETY: All operations delegate their unchanged allocator contract to System;
// the counters allocate no memory and never affect alignment or ownership.
unsafe impl GlobalAlloc for Counted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        // SAFETY: The caller supplies the GlobalAlloc layout contract unchanged.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        // SAFETY: The caller supplies the GlobalAlloc layout contract unchanged.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: The original System allocation and layout are forwarded unchanged.
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count(size);
        // SAFETY: Ownership, layout and requested nonzero size come from the caller.
        unsafe { System.realloc(pointer, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: Counted = Counted;
fn main() {
    let bytes = vec![0x8f; PAYLOAD_BYTES];
    let descriptor=parse(&format!(r#"{{"id":"import:bench:mesh","digest":"opaque","byteLength":{PAYLOAD_BYTES},"kind":"mesh","mediaType":"application/octet-stream"}}"#)).unwrap();
    let id = AssetId::try_from_str("import:bench:mesh").unwrap();
    let mut repository = AssetRepository::new();
    repository.put(&descriptor, &bytes).unwrap();
    let original = repository.capture_internal();
    let lease = repository.peek(&id).unwrap();
    let start = Instant::now();
    TRACK.store(true, Ordering::SeqCst);
    // Include first digest computation, then repeated branch/capture/restore.
    let fingerprint = repository.bundle_fingerprint().to_owned();
    for _ in 0..200 {
        let saved = repository.capture_internal();
        assert!(saved.same_version(&original));
        repository.remove(&id);
        repository.bundle_fingerprint();
        repository.restore_internal(&saved).unwrap();
        assert!(lease.same_record(&repository.peek(&id).unwrap()));
        assert_eq!(repository.bundle_fingerprint(), fingerprint);
    }
    TRACK.store(false, Ordering::SeqCst);
    let internal_allocations = LARGE_ALLOCS.load(Ordering::SeqCst);
    let internal_bytes = LARGE_BYTES.load(Ordering::SeqCst);
    assert_eq!(
        internal_allocations, 0,
        "History/fingerprint path allocated a mesh-sized buffer"
    );
    // Prove the counter would detect a real public payload copy.
    TRACK.store(true, Ordering::SeqCst);
    let copy = repository.get(&id).unwrap();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(copy.bytes, bytes);
    assert_ne!(copy.bytes.as_ptr(), lease.bytes().as_ptr());
    assert_eq!(LARGE_ALLOCS.load(Ordering::SeqCst), 1);
    assert_eq!(LARGE_BYTES.load(Ordering::SeqCst), PAYLOAD_BYTES);
    println!(
        "{{\"payloadBytes\":{PAYLOAD_BYTES},\"historyCycles\":200,\"internalPayloadAllocations\":{internal_allocations},\"internalPayloadAllocatedBytes\":{internal_bytes},\"publicReadPayloadAllocatedBytes\":{PAYLOAD_BYTES},\"elapsedMs\":{:.3}}}",
        start.elapsed().as_secs_f64() * 1000.0
    );
}
