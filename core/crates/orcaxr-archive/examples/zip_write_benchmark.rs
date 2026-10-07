//! Streaming ZIP output ownership. Source construction and verification excluded.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
const PAYLOAD_BYTES: usize = 8 << 20;
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

use orcaxr_archive::{
    Archive,
    write::{self, Compression, Limits, Member},
};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
};
fn main() {
    let mut seed = 0x87ac416du32;
    let payload: Vec<_> = (0..PAYLOAD_BYTES)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as u8
        })
        .collect();
    let path = std::env::temp_dir().join(format!("orcaxr-zip-write-{}.zip", std::process::id()));
    let mut output = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let members = ["random.txt", "stored.png", "zeros.txt"].map(|path| Member {
        path,
        compression: Compression::Auto,
    });
    let mut expected = None;
    let mut allocated = 0;
    let mut largest = 0;
    let mut result_bytes = 0;
    for _ in 0..5 {
        output.set_len(0).unwrap();
        output.seek(SeekFrom::Start(0)).unwrap();
        let baseline = LIVE.load(Ordering::Relaxed);
        TOTAL.store(0, Ordering::Relaxed);
        LARGEST.store(0, Ordering::Relaxed);
        LARGE.store(0, Ordering::Relaxed);
        TRACK.store(true, Ordering::Relaxed);
        let receipt = write::archive(
            &mut output,
            &members,
            Limits::default(),
            |i, w| {
                if i < 2 {
                    w.write_all(&payload)?;
                } else {
                    for _ in 0..PAYLOAD_BYTES / 65536 {
                        w.write_all(&[0; 65536])?;
                    }
                }
                Ok::<_, io::Error>(())
            },
            || false,
        )
        .unwrap();
        TRACK.store(false, Ordering::Relaxed);
        assert_eq!(LIVE.load(Ordering::Relaxed), baseline);
        assert_eq!(LARGE.load(Ordering::Relaxed), 0);
        allocated += TOTAL.load(Ordering::Relaxed);
        largest = largest.max(LARGEST.load(Ordering::Relaxed));
        assert!(largest < 1 << 20);
        assert_eq!(receipt.uncompressed_bytes, (3 * PAYLOAD_BYTES) as u64);
        result_bytes = receipt.bytes;
        // Hash/verify only after the measured writer has released its buffers.
        output.seek(SeekFrom::Start(0)).unwrap();
        let mut hash = Sha256::new();
        let mut buf = [0; 65536];
        loop {
            let n = output.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
        }
        let hash = format!("{:x}", hash.finalize());
        if let Some(previous) = &expected {
            assert_eq!(&hash, previous);
        } else {
            expected = Some(hash);
        }
        let mut source = Archive::open(&mut output, Limits::default().zip, || false).unwrap();
        source.verify_all(|| false).unwrap();
    }
    TRACK.store(true, Ordering::Relaxed);
    let control = std::hint::black_box(payload.clone());
    TRACK.store(false, Ordering::Relaxed);
    assert_eq!(LARGE.load(Ordering::Relaxed), 1);
    drop(control);
    drop(output);
    fs::remove_file(path).unwrap();
    println!(
        "{}",
        serde_json::json!({"cycles":5,"sourcePayloadBytes":PAYLOAD_BYTES,"expandedBytes":3*PAYLOAD_BYTES,"archiveBytes":result_bytes,"sha256":expected.unwrap(),"allocationBytes":allocated,"largestAllocationBytes":largest,"payloadAllocations":0,"retainedBytes":0,"positiveControlPayloadAllocations":1})
    );
}
