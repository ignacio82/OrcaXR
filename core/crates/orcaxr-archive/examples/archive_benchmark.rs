//! Synthetic archive expansion ownership. Input construction is excluded.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
const PAYLOAD_BYTES: usize = 1024 * 1024;
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

use flate2::{Compression, write::DeflateEncoder};
use orcaxr_archive::{Archive, ZipLimits};
use std::io::{Cursor, Write};
fn package(bytes: usize) -> Vec<u8> {
    let payload = (0..bytes)
        .map(|i| ((i % 1024).wrapping_mul(73) ^ ((i % 1024) / 7)) as u8)
        .collect::<Vec<_>>();
    let crc = crc32fast::hash(&payload);
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(&payload).unwrap();
    let compressed = encoder.finish().unwrap();
    let mut archive = Vec::new();
    let mut u16 = |n: u16| archive.extend_from_slice(&n.to_le_bytes());
    u16(0x4b50);
    u16(0x0403);
    u16(20);
    u16(0);
    u16(8);
    u16(0);
    u16(33);
    archive.extend_from_slice(&crc.to_le_bytes());
    archive.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    archive.extend_from_slice(&(bytes as u32).to_le_bytes());
    archive.extend_from_slice(&[1, 0, 0, 0, b'a']);
    archive.extend_from_slice(&compressed);
    let offset = archive.len();
    archive.extend_from_slice(&0x02014b50u32.to_le_bytes());
    archive.extend_from_slice(&[20, 0, 20, 0, 0, 0, 8, 0, 0, 0, 33, 0]);
    archive.extend_from_slice(&crc.to_le_bytes());
    archive.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    archive.extend_from_slice(&(bytes as u32).to_le_bytes());
    archive.extend_from_slice(&[1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, b'a']);
    let size = archive.len() - offset;
    archive.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0]);
    archive.extend_from_slice(&(size as u32).to_le_bytes());
    archive.extend_from_slice(&(offset as u32).to_le_bytes());
    archive.extend_from_slice(&[0, 0]);
    archive
}
fn main() {
    for bytes in [1 << 20, 16 << 20] {
        let package = package(bytes);
        let baseline = LIVE.load(Ordering::Relaxed);
        LARGE.store(0, Ordering::Relaxed);
        TOTAL.store(0, Ordering::Relaxed);
        LARGEST.store(0, Ordering::Relaxed);
        TRACK.store(true, Ordering::Relaxed);
        for _ in 0..20 {
            let mut archive = Archive::open(
                Cursor::new(package.as_slice()),
                ZipLimits::default(),
                || false,
            )
            .unwrap();
            archive.verify_all(|| false).unwrap();
        }
        TRACK.store(false, Ordering::Relaxed);
        let retained = LIVE.load(Ordering::Relaxed) - baseline;
        let total = TOTAL.load(Ordering::Relaxed);
        let largest = LARGEST.load(Ordering::Relaxed);
        let large = LARGE.load(Ordering::Relaxed);
        assert_eq!(retained, 0);
        assert_eq!(large, 0);
        assert!(largest <= 65_557);
        println!(
            "{{\"memberBytes\":{bytes},\"archiveBytes\":{},\"cycles\":20,\"allocationBytes\":{total},\"largestAllocationBytes\":{largest},\"payloadAllocations\":{large},\"retainedBytes\":{retained}}}",
            package.len()
        );
    }
}
