//! Synthetic sparse-storage/allocation evidence; not a device latency budget.
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::facets::{Channel, FacetChannel, FacetError, Node, ValidationOptions};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

const TRIANGLES: usize = 1_897_256;
const ASSIGNED: usize = 10_000;
static TRACK: AtomicBool = AtomicBool::new(false);
static LARGEST: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
struct Counted;
fn record(bytes: usize) {
    if TRACK.load(Ordering::Relaxed) {
        LARGEST.fetch_max(bytes, Ordering::Relaxed);
        TOTAL.fetch_add(bytes, Ordering::Relaxed);
    }
}
// SAFETY: Allocation ownership and layouts are forwarded unchanged to System;
// counters do not allocate, dereference pointers or change the allocator result.
unsafe impl GlobalAlloc for Counted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: Forward the caller's valid allocation layout unchanged.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: Forward the caller's valid allocation layout unchanged.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: Forward the original System pointer and allocation layout.
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        // SAFETY: Forward the owned pointer, layout and requested nonzero size.
        unsafe { System.realloc(pointer, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: Counted = Counted;
fn main() {
    let mut assignments = parse(r#"[{"value":"import:filament:a","triangles":[]}]"#).unwrap();
    let Value::Array(entries) = &mut assignments else {
        panic!()
    };
    let Value::Object(entry) = &mut entries[0] else {
        panic!()
    };
    entry.insert(
        "triangles".encode_utf16().collect(),
        Value::Array((0..ASSIGNED).map(|i| Value::Number(i as f64)).collect()),
    );
    let encoding=parse(&format!(r#"{{"version":2,"triangleCount":{TRIANGLES},"splits":[{{"triangle":{ASSIGNED},"node":{{"kind":"split","splitSides":1,"specialSide":0,"children":[{{"kind":"leaf","state":{{"kind":"assigned","value":"import:filament:a"}}}},{{"kind":"leaf","state":{{"kind":"unpainted"}}}}]}}}}]}}"#)).unwrap();
    let options = ValidationOptions::new(TRIANGLES as f64, "refinement.color");
    let start = Instant::now();
    TRACK.store(true, Ordering::SeqCst);
    let channel =
        FacetChannel::decode(Channel::Color, &assignments, Some(&encoding), &options).unwrap();
    for _ in 0..5 {
        let remapped = channel.remap(Clone::clone, None).unwrap();
        assert_eq!(remapped.assignments().len(), 1);
        assert_eq!(remapped.assignments()[0].triangles.len(), ASSIGNED);
        assert_eq!(remapped.encoding().unwrap().splits().len(), 1);
        assert_eq!(remapped.expand(ASSIGNED), Err(FacetError::DenseLimit));
    }
    TRACK.store(false, Ordering::SeqCst);
    let largest = LARGEST.load(Ordering::SeqCst);
    let total = TOTAL.load(Ordering::SeqCst);
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    let dense_bytes = TRIANGLES * size_of::<Node>();
    // A per-source-facet allocation would exceed both bounds. Cumulative bytes
    // are checked too, so many small allocations cannot hide dense construction.
    assert!(largest < dense_bytes / 100);
    assert!(total < dense_bytes / 4);
    LARGEST.store(0, Ordering::SeqCst);
    TRACK.store(true, Ordering::SeqCst);
    let expanded = channel.expand(TRIANGLES).unwrap();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(expanded.len(), TRIANGLES);
    assert_eq!(
        LARGEST.load(Ordering::SeqCst),
        dense_bytes,
        "counter must detect actual dense materialization"
    );
    println!(
        "{{\"declaredTriangles\":{TRIANGLES},\"wholeAssignedTriangles\":{ASSIGNED},\"splitTriangles\":1,\"remapCycles\":5,\"sparseLargestAllocationBytes\":{largest},\"sparseTotalAllocatedBytes\":{total},\"explicitDenseAllocationBytes\":{dense_bytes},\"sparseElapsedMs\":{elapsed:.3}}}"
    );
}
