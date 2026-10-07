//! Canonical asset ownership probe. Source construction is excluded.
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

use orcaxr_archive::{
    Archive, ZipLimits,
    canonical::{CanonicalArchiveSource, ENVELOPE_PATH},
};
use orcaxr_project::{
    assets::content_digest,
    ingress::{ProjectInputLimits, json::JsonLimits},
};
use serde_json::{Value, json};
use std::io::Cursor;
#[allow(dead_code)]
#[path = "../tests/support/package.rs"]
mod support;
fn package() -> (Vec<u8>, usize) {
    let corpus: Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/canonical-archive-vectors.json"
    ))
    .unwrap();
    let bytes = corpus["cases"][0]["archiveHex"]
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect::<Vec<_>>();
    let mut archive = Archive::open(Cursor::new(bytes), ZipLimits::default(), || false).unwrap();
    let mut files = std::collections::BTreeMap::new();
    for i in 0..archive.entries().len() {
        let mut data = Vec::new();
        archive.read_entry(i, &mut data, || false).unwrap();
        files.insert(archive.entries()[i].path().to_owned(), data);
    }
    let mut envelope: Value = serde_json::from_slice(&files[ENVELOPE_PATH]).unwrap();
    let large = vec![73u8; PAYLOAD_BYTES];
    envelope["state"]["sourceAssets"].as_array_mut().unwrap().push(json!({"id":"import:probe:large","kind":"extension","digest":content_digest(&large),"byteLength":large.len(),"mediaType":"application/octet-stream","provenance":{"source":"import"}}));
    envelope["state"]["extensionBlobs"].as_array_mut().unwrap().push(json!({"id":"import:probe:blob","namespace":"probe","path":"blob.bin","assetId":"import:probe:large","relationships":[]}));
    envelope["assetEntries"]
        .as_array_mut()
        .unwrap()
        .push(json!({"assetId":"import:probe:large","path":"large.bin"}));
    files.insert(
        ENVELOPE_PATH.to_owned(),
        serde_json::to_vec(&envelope).unwrap(),
    );
    files.insert("large.bin".into(), large.clone());
    files.insert("blob.bin".into(), large.clone());
    files.insert("unknown.bin".into(), large);
    let mut output = Vec::new();
    let mut central = Vec::new();
    let mut unknown = 0;
    for (name, data) in &files {
        let offset = output.len() as u32;
        let size = data.len() as u32;
        let crc = crc32fast::hash(data);
        let mut local = [0u8; 30];
        local[0..4].copy_from_slice(&0x04034b50u32.to_le_bytes());
        local[4..6].copy_from_slice(&20u16.to_le_bytes());
        local[12..14].copy_from_slice(&33u16.to_le_bytes());
        local[14..18].copy_from_slice(&crc.to_le_bytes());
        local[18..22].copy_from_slice(&size.to_le_bytes());
        local[22..26].copy_from_slice(&size.to_le_bytes());
        local[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
        output.extend_from_slice(&local);
        output.extend_from_slice(name.as_bytes());
        if name == "unknown.bin" {
            unknown = output.len();
        }
        output.extend_from_slice(data);
        let mut entry = [0u8; 46];
        entry[0..4].copy_from_slice(&0x02014b50u32.to_le_bytes());
        entry[4..6].copy_from_slice(&20u16.to_le_bytes());
        entry[6..28].copy_from_slice(&local[4..26]);
        entry[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
        entry[42..46].copy_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(&entry);
        central.extend_from_slice(name.as_bytes());
    }
    let offset = output.len() as u32;
    let size = central.len() as u32;
    output.extend_from_slice(&central);
    let mut end = [0u8; 22];
    end[0..4].copy_from_slice(&0x06054b50u32.to_le_bytes());
    end[8..10].copy_from_slice(&(files.len() as u16).to_le_bytes());
    end[10..12].copy_from_slice(&(files.len() as u16).to_le_bytes());
    end[12..16].copy_from_slice(&size.to_le_bytes());
    end[16..20].copy_from_slice(&offset.to_le_bytes());
    output.extend_from_slice(&end);
    (output, unknown)
}
fn main() {
    let (mut package, unknown) = package();
    let limits = ProjectInputLimits {
        document: JsonLimits {
            max_bytes: 1 << 20,
            max_nodes: 1 << 20,
            max_text_units: 1 << 20,
            max_number_bytes: 1024,
            max_depth: 128,
        },
        max_assets: 4096,
        max_asset_bytes: PAYLOAD_BYTES,
        max_total_asset_bytes: PAYLOAD_BYTES + 1024,
    };
    if std::env::args().any(|arg| arg == "--complete") {
        complete_probe(&package, limits);
        return;
    }
    for corrupt in [false, true] {
        if corrupt {
            package[unknown] ^= 1;
        }
        let baseline = LIVE.load(Ordering::Relaxed);
        LARGE.store(0, Ordering::Relaxed);
        TOTAL.store(0, Ordering::Relaxed);
        LARGEST.store(0, Ordering::Relaxed);
        TRACK.store(true, Ordering::Relaxed);
        for _ in 0..20 {
            let archive = Archive::open(
                Cursor::new(package.as_slice()),
                ZipLimits::default(),
                || false,
            )
            .unwrap();
            let source = CanonicalArchiveSource::decode(
                archive,
                limits,
                &mut |_: &[u16]| Ok::<_, ()>(true),
                || false,
            );
            assert_eq!(source.is_err(), corrupt);
            if let Ok(source) = source {
                let id = &source.project().state().source_assets[1].id;
                let a = source.asset(id).unwrap();
                assert_eq!(a.bytes().len(), PAYLOAD_BYTES);
                assert!(a.same_record(&source.asset(id).unwrap()));
            }
        }
        TRACK.store(false, Ordering::Relaxed);
        let retained = LIVE.load(Ordering::Relaxed) - baseline;
        let large = LARGE.load(Ordering::Relaxed);
        let total = TOTAL.load(Ordering::Relaxed);
        let largest = LARGEST.load(Ordering::Relaxed);
        assert_eq!(retained, 0);
        assert_eq!(large, 20);
        assert_eq!(largest, PAYLOAD_BYTES);
        println!(
            "{{\"assetBytes\":{PAYLOAD_BYTES},\"cycles\":20,\"corruptUnknownMember\":{corrupt},\"allocationBytes\":{total},\"payloadAllocations\":{large},\"largestAllocationBytes\":{largest},\"retainedBytes\":{retained}}}"
        );
    }
}

fn complete_probe(package: &[u8], input_limits: ProjectInputLimits) {
    use orcaxr_archive::canonical::CompleteLimits;
    let l = support::limits();
    let limits = CompleteLimits {
        records: l.records,
        text_units: l.text_units,
        assets: 4096,
        asset_bytes: PAYLOAD_BYTES,
        total_asset_bytes: 2 * PAYLOAD_BYTES + 1024,
        warnings: 4096,
        regenerated_bytes: 128 << 20,
        model: l.model,
        metadata: l.metadata,
        settings: l.settings,
        opc: l.opc,
    };
    // Construction/retention of the immutable compressed source is excluded.
    // Both success and late final-admission failure own exactly two large assets:
    // the envelope's declared asset and the independently adopted unknown member.
    for late_failure in [false, true] {
        let baseline = LIVE.load(Ordering::Relaxed);
        LARGE.store(0, Ordering::Relaxed);
        TOTAL.store(0, Ordering::Relaxed);
        LARGEST.store(0, Ordering::Relaxed);
        TRACK.store(true, Ordering::Relaxed);
        for _ in 0..5 {
            let archive =
                Archive::open(Cursor::new(package), ZipLimits::default(), || false).unwrap();
            let source = CanonicalArchiveSource::decode(
                archive,
                input_limits,
                &mut |_: &[u16]| Ok::<_, ()>(true),
                || false,
            )
            .unwrap();
            let id = source.project().state().source_assets[1].id.clone();
            let lease = source.asset(&id).unwrap();
            let mut timestamp_calls = 0;
            let mut policy = |_: &[u16]| {
                timestamp_calls += 1;
                if late_failure && timestamp_calls > 2 {
                    Err(())
                } else {
                    Ok(true)
                }
            };
            let result = source.complete(limits, &mut policy, || false);
            assert_eq!(result.is_err(), late_failure);
            if let Ok(completed) = result {
                assert!(lease.same_record(&completed.asset(&id).unwrap()));
                let unknown = completed.project().state().source_assets.last().unwrap();
                assert_eq!(
                    completed.asset(&unknown.id).unwrap().bytes().len(),
                    PAYLOAD_BYTES
                );
                completed.into_prepared().unwrap();
            }
        }
        TRACK.store(false, Ordering::Relaxed);
        let retained = LIVE.load(Ordering::Relaxed) - baseline;
        let payloads = LARGE.load(Ordering::Relaxed);
        let allocated = TOTAL.load(Ordering::Relaxed);
        let largest = LARGEST.load(Ordering::Relaxed);
        assert_eq!(retained, 0);
        assert_eq!(payloads, 10);
        assert_eq!(largest, PAYLOAD_BYTES);
        println!(
            "{}",
            json!({"phase":"complete-canonical-import","cycles":5,"assetBytes":PAYLOAD_BYTES,"lateAdmissionFailure":late_failure,"allocationBytes":allocated,"payloadAllocations":payloads,"largestAllocationBytes":largest,"retainedBytes":retained})
        );
    }
    for mismatch in [false, true] {
        let baseline = LIVE.load(Ordering::Relaxed);
        LARGE.store(0, Ordering::Relaxed);
        TOTAL.store(0, Ordering::Relaxed);
        LARGEST.store(0, Ordering::Relaxed);
        TRACK.store(true, Ordering::Relaxed);
        for _ in 0..5 {
            use std::io::Write;
            let mut a =
                Archive::open(Cursor::new(package), ZipLimits::default(), || false).unwrap();
            let index = a
                .entries()
                .iter()
                .position(|e| e.path() == "unknown.bin")
                .unwrap();
            let mut compare = a.compare_entry(index, || false).unwrap();
            if mismatch {
                compare.write_all(&[1]).unwrap();
            }
            for _ in 0..PAYLOAD_BYTES / 65536 {
                compare.write_all(&[73; 65536]).unwrap();
            }
            assert_eq!(compare.finish().unwrap(), !mismatch);
        }
        TRACK.store(false, Ordering::Relaxed);
        let retained = LIVE.load(Ordering::Relaxed) - baseline;
        let payloads = LARGE.load(Ordering::Relaxed);
        let allocated = TOTAL.load(Ordering::Relaxed);
        let largest = LARGEST.load(Ordering::Relaxed);
        assert_eq!(retained, 0);
        assert_eq!(payloads, 0);
        assert!(largest < 1 << 20);
        println!(
            "{}",
            json!({"phase":"compare-large-member","cycles":5,"earlyMismatch":mismatch,"allocationBytes":allocated,"payloadAllocations":payloads,"largestAllocationBytes":largest,"retainedBytes":retained})
        );
    }
    let baseline = LIVE.load(Ordering::Relaxed);
    LARGE.store(0, Ordering::Relaxed);
    TRACK.store(true, Ordering::Relaxed);
    let copy = std::hint::black_box(package[..PAYLOAD_BYTES].to_vec());
    drop(copy);
    TRACK.store(false, Ordering::Relaxed);
    assert_eq!(LARGE.load(Ordering::Relaxed), 1);
    assert_eq!(LIVE.load(Ordering::Relaxed), baseline);
    println!(
        "{{\"phase\":\"deliberate-copy-control\",\"payloadAllocations\":1,\"retainedBytes\":0}}"
    );
}
