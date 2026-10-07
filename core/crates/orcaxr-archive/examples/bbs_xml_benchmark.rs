//! Borrowed BBS mesh XML and UTF-16 streaming allocation evidence.
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

use orcaxr_archive::bbs::xml::{Limits, Writer};
use orcaxr_project::{
    assets::AssetRepository,
    ids::AssetId,
    mesh::{self, Coordinates, EncodeOptions, Mesh},
};
use sha2::{Digest, Sha256};
use std::io::{self, Write};
const VERTICES: usize = 2_000_000;
struct Sink {
    bytes: usize,
    hash: Sha256,
}
impl Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        assert!(bytes.len() <= 4096);
        self.bytes += bytes.len();
        self.hash.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        panic!("host owns durable flush")
    }
}
fn measure(label: &str, cycles: usize, mut run: impl FnMut()) {
    let live = LIVE.load(Ordering::Relaxed);
    TOTAL.store(0, Ordering::Relaxed);
    LARGEST.store(0, Ordering::Relaxed);
    TRACK.store(true, Ordering::SeqCst);
    for _ in 0..cycles {
        run();
    }
    TRACK.store(false, Ordering::SeqCst);
    let total = TOTAL.load(Ordering::Relaxed);
    let largest = LARGEST.load(Ordering::Relaxed);
    let retained = LIVE.load(Ordering::Relaxed) as i64 - live as i64;
    assert_eq!(total, 0);
    assert_eq!(retained, 0);
    println!(
        "{{\"phase\":\"{label}\",\"cycles\":{cycles},\"allocatedBytes\":{total},\"largestAllocationBytes\":{largest},\"retainedBytes\":{retained}}}"
    );
}
fn main() {
    let id = AssetId::try_from_utf16("import:mesh:bbs-writer".encode_utf16().collect::<Vec<_>>())
        .unwrap();
    let references: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-number-vectors.json"
    ))
    .unwrap();
    let fixture = &references["vertices"];
    let pattern: Vec<_> = fixture["patternBits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| f32::from_bits(n.as_u64().unwrap() as u32))
        .collect();
    assert_eq!(fixture["count"], VERTICES);
    let positions: Vec<_> = (0..VERTICES * 3)
        .map(|i| pattern[i % pattern.len()])
        .collect();
    let limits = mesh::Limits {
        asset_bytes: positions.len() * 4,
        vertices: VERTICES,
        indices: 0,
    };
    let payload = mesh::encode(
        EncodeOptions {
            id: id.clone(),
            source_filename: None,
            provenance: None,
            metadata_bytes: 4096,
        },
        Coordinates::Float32(&positions),
        Some(&[]),
        limits,
        || false,
    )
    .unwrap();
    let mut repo = AssetRepository::new();
    repo.put_owned(payload).unwrap();
    let mesh = Mesh::open(repo.peek(&id).unwrap(), limits, || false).unwrap();
    drop(positions);
    let expected: Vec<u8> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&fixture["sha256"].as_str().unwrap()[i..i + 2], 16).unwrap())
        .collect();
    measure("borrowed-two-million-vertex-xml", 5, || {
        let mut sink = Sink {
            bytes: 0,
            hash: Sha256::new(),
        };
        let mut writer = Writer::new(
            &mut sink,
            Limits {
                output_bytes: 1 << 30,
                text_units: 0,
            },
            || false,
        )
        .unwrap();
        for vertex in mesh.positions() {
            writer.vertex(vertex).unwrap();
        }
        let size = writer.finish().unwrap();
        assert_eq!(size, sink.bytes);
        assert_eq!(size as u64, fixture["bytes"].as_u64().unwrap());
        assert_eq!(&sink.hash.finalize()[..], expected);
    });
    let text = vec![38; PAYLOAD_BYTES / 2];
    measure("borrowed-eight-mib-utf16", 20, || {
        let mut sink = Sink {
            bytes: 0,
            hash: Sha256::new(),
        };
        let mut writer = Writer::new(
            &mut sink,
            Limits {
                output_bytes: 32 << 20,
                text_units: text.len(),
            },
            || false,
        )
        .unwrap();
        writer.attribute(&text).unwrap();
        assert_eq!(writer.finish().unwrap(), text.len() * 5);
    });
    let live = LIVE.load(Ordering::Relaxed);
    TOTAL.store(0, Ordering::Relaxed);
    LARGEST.store(0, Ordering::Relaxed);
    TRACK.store(true, Ordering::SeqCst);
    std::hint::black_box(text.clone());
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(TOTAL.load(Ordering::Relaxed), PAYLOAD_BYTES);
    assert_eq!(LARGEST.load(Ordering::Relaxed), PAYLOAD_BYTES);
    assert_eq!(LIVE.load(Ordering::Relaxed), live);
    println!(
        "{{\"phase\":\"deliberate-copy-control\",\"allocatedBytes\":{PAYLOAD_BYTES},\"retainedBytes\":0}}"
    );
}
