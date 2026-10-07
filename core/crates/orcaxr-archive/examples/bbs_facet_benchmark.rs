//! Sparse BBS paint decoding and borrowed projection allocation evidence.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
const PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static TRACK: AtomicBool = AtomicBool::new(false);
static LARGE: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
static LARGEST: AtomicUsize = AtomicUsize::new(0);
struct Counted;
fn record(size: usize) {
    if TRACK.load(Ordering::Relaxed) {
        LARGEST.fetch_max(size, Ordering::Relaxed);
        TOTAL.fetch_add(size, Ordering::Relaxed);
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
        {
            // SAFETY: Forward the caller's valid allocation layout.
            let p = unsafe { System.alloc(layout) };
            if !p.is_null() {
                LIVE.fetch_add(layout.size(), Ordering::Relaxed);
            }
            p
        }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        {
            // SAFETY: Forward the caller's valid allocation layout.
            let p = unsafe { System.alloc_zeroed(layout) };
            if !p.is_null() {
                LIVE.fetch_add(layout.size(), Ordering::Relaxed);
            }
            p
        }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: Forward the original System allocation and its layout.
        unsafe { System.dealloc(pointer, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        {
            // SAFETY: Forward ownership, layout and requested nonzero size unchanged.
            let p = unsafe { System.realloc(pointer, layout, size) };
            if !p.is_null() {
                LIVE.fetch_add(size, Ordering::Relaxed);
                LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            }
            p
        }
    }
}
#[global_allocator]
static ALLOCATOR: Counted = Counted;

use orcaxr_archive::bbs::facets::{self, DecodeBudget, Paint, Tree};
use orcaxr_project::facets::{Channel, FacetChannel, Node, PaintValue, Split, State, Triangle};
use std::io::{self, Write};
struct Sink {
    bytes: usize,
    largest: usize,
}
impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        assert!(b.len() <= 4096);
        self.bytes += b.len();
        self.largest = self.largest.max(b.len());
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        panic!("host owns durable flush")
    }
}
fn measure(label: &str, mut run: impl FnMut()) {
    let live = LIVE.load(Ordering::Relaxed);
    TOTAL.store(0, Ordering::Relaxed);
    LARGEST.store(0, Ordering::Relaxed);
    LARGE.store(0, Ordering::Relaxed);
    TRACK.store(true, Ordering::SeqCst);
    for _ in 0..20 {
        run();
    }
    TRACK.store(false, Ordering::SeqCst);
    let retained = LIVE.load(Ordering::Relaxed) as i64 - live as i64;
    let largest = LARGEST.load(Ordering::Relaxed);
    let total = TOTAL.load(Ordering::Relaxed);
    let large = LARGE.load(Ordering::Relaxed);
    assert_eq!(retained, 0);
    assert_eq!(large, 0);
    assert!(largest < 65536);
    assert!(total < 1 << 20);
    println!(
        "{{\"phase\":\"{label}\",\"cycles\":20,\"allocatedBytes\":{total},\"largestAllocationBytes\":{largest},\"payloadAllocations\":{large},\"retainedBytes\":{retained}}}"
    );
}
fn main() {
    let map = [
        None,
        Some(PaintValue::text(
            "enforce".encode_utf16().collect::<Vec<_>>(),
        )),
        Some(PaintValue::text("block".encode_utf16().collect::<Vec<_>>())),
    ];
    for count in [2_000_000, 2_000_000_000] {
        measure(&format!("sparse-{count}-facets"), || {
            let mut budget = DecodeBudget::new(100).unwrap();
            let mut roots = vec![];
            for (index, encoded) in [(4, b"0".as_slice()), (111, b"441"), (count - 1, b"841")] {
                roots.push(Split {
                    triangle: Triangle::new(index as f64).unwrap(),
                    node: facets::decode(
                        encoded,
                        100,
                        &mut budget,
                        |n| map[n as usize].clone(),
                        || false,
                    )
                    .unwrap(),
                });
            }
            let channel = FacetChannel::from_sparse_roots(
                Channel::Support,
                Triangle::new(count as f64).unwrap(),
                roots,
                None,
            )
            .unwrap();
            assert_eq!(channel.assignments().len(), 1);
            assert_eq!(channel.assignments()[0].triangles[0].number(), 111.0);
            assert_eq!(channel.encoding().unwrap().splits().len(), 1);
            assert_eq!(budget.remaining_nodes(), 93);
            let mut sink = Sink {
                bytes: 0,
                largest: 0,
            };
            facets::write(
                Tree::Computed(&channel.encoding().unwrap().splits()[0].node),
                |v| {
                    map.iter()
                        .position(|p| {
                            p.as_ref().is_some_and(|p| match (p, v) {
                                (PaintValue::Text(a), Paint::Text(b)) => a.as_ref() == b,
                                _ => false,
                            })
                        })
                        .map(|n| n as u8)
                },
                &mut sink,
                100,
                || false,
            )
            .unwrap();
            assert_eq!(sink.bytes, 3);
        });
    }
    let text: std::sync::Arc<[u16]> = vec![120; PAYLOAD_BYTES / 2].into();
    let node = Node::leaf(State::Assigned(PaintValue::Text(text.clone())));
    let value = node.to_value();
    let mut pointers = vec![];
    for (name, root) in [
        ("borrowed-computation", Tree::Computed(&node)),
        ("borrowed-persisted", Tree::Persisted(&value)),
    ] {
        measure(name, || {
            let mut sink = Sink {
                bytes: 0,
                largest: 0,
            };
            facets::write(
                root,
                |paint| {
                    let Paint::Text(v) = paint else { panic!() };
                    assert_eq!(v.len() * 2, PAYLOAD_BYTES);
                    Some(64)
                },
                &mut sink,
                100,
                || false,
            )
            .unwrap();
            assert_eq!(sink.bytes, 6);
        });
        facets::write(
            root,
            |paint| {
                if let Paint::Text(v) = paint {
                    pointers.push(v.as_ptr());
                }
                Some(64)
            },
            &mut io::sink(),
            100,
            || false,
        )
        .unwrap();
    }
    assert_eq!(pointers[0], text.as_ptr());
    assert_ne!(pointers[0], pointers[1]);
    // Positive control proves the counter detects a copied persisted payload.
    let live = LIVE.load(Ordering::Relaxed);
    LARGEST.store(0, Ordering::Relaxed);
    LARGE.store(0, Ordering::Relaxed);
    TRACK.store(true, Ordering::SeqCst);
    let copied = value.clone();
    std::hint::black_box(&copied);
    drop(copied);
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(LIVE.load(Ordering::Relaxed), live);
    assert_eq!(LARGE.load(Ordering::Relaxed), 1);
    assert_eq!(LARGEST.load(Ordering::Relaxed), PAYLOAD_BYTES);
    println!(
        "{{\"phase\":\"payload-copy-control\",\"largestAllocationBytes\":{PAYLOAD_BYTES},\"payloadAllocations\":1,\"retainedBytes\":0}}"
    );
}
