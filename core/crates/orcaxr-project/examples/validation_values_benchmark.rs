//! Constant-memory timestamp parsing evidence; no platform timezone qualification.
use orcaxr_project::validation::timestamp::{V8IntegerMode, parse};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
const UNITS: usize = 1024 * 1024;
const PAYLOAD_BYTES: usize = 3 * UNITS * size_of::<u16>();
static TRACK: AtomicBool = AtomicBool::new(false);
static LARGE: AtomicUsize = AtomicUsize::new(0);
static LARGEST: AtomicUsize = AtomicUsize::new(0);
struct Counted;
fn record(size: usize) {
    if TRACK.load(Ordering::Relaxed) {
        LARGEST.fetch_max(size, Ordering::Relaxed);
        if size >= PAYLOAD_BYTES {
            LARGE.fetch_add(1, Ordering::Relaxed);
        }
    }
}
// SAFETY: The unchanged System allocator contract is forwarded for every call;
// counters allocate no memory and cannot alter pointer ownership or alignment.
unsafe impl GlobalAlloc for Counted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: Forward the caller's valid allocation layout.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        // SAFETY: Forward the caller's valid allocation layout.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: Forward the original System allocation and its layout.
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        // SAFETY: Forward ownership, layout and requested nonzero size unchanged.
        unsafe { System.realloc(pointer, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: Counted = Counted;

fn main() {
    let mut input = vec![0x20; UNITS];
    input.extend(std::iter::repeat_n(0x28, UNITS));
    input.extend(std::iter::repeat_n(0x29, UNITS));
    input.extend("Jan 1 2000 GMT".encode_utf16());
    let bytes = input.len() * size_of::<u16>();
    TRACK.store(true, Ordering::SeqCst);
    for _ in 0..20 {
        let value = parse(std::hint::black_box(&input), V8IntegerMode::Smi31).unwrap();
        assert_eq!(
            value.resolve::<()>(|_| panic!()).unwrap(),
            Some(946_684_800_000)
        );
    }
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(
        LARGEST.load(Ordering::SeqCst),
        0,
        "timestamp parsing allocated"
    );
    assert_eq!(LARGE.load(Ordering::SeqCst), 0);
    TRACK.store(true, Ordering::SeqCst);
    let copy = input.clone();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(LARGE.load(Ordering::SeqCst), 1);
    assert_eq!(LARGEST.load(Ordering::SeqCst), bytes);
    std::hint::black_box(copy);
    println!(
        "{{\"inputBytes\":{bytes},\"parseCycles\":20,\"parserAllocationBytes\":0,\"copyControlAllocations\":1}}"
    );
}
