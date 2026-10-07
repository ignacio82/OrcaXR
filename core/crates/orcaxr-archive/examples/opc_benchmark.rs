//! OPC reconciliation ownership probe. Input decoding is excluded.
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
    envelope["state"]["extensionData"] = json!({"large":"x".repeat(PAYLOAD_BYTES/2)});
    files.insert("_rels/.rels".to_owned(), b"<Relationships><Relationship Id='private' Type='urn:test' Target='/blob.bin#piece'/></Relationships>".to_vec());
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
fn metadata_pointer(source: &CanonicalArchiveSource<Cursor<&[u8]>>) -> usize {
    use orcaxr_contracts::canonical::Value;
    let Value::Object(fields) = source
        .project()
        .state()
        .extension_data
        .as_ref()
        .unwrap()
        .value()
    else {
        unreachable!()
    };
    let Value::String(units) = &fields[&"large".encode_utf16().collect::<Vec<_>>()] else {
        unreachable!()
    };
    units.as_ptr() as usize
}
fn main() {
    use orcaxr_archive::opc::{Authoring, Limits, Source};
    let (package, _) = package();
    let input = ProjectInputLimits {
        document: JsonLimits {
            max_bytes: PAYLOAD_BYTES * 2,
            max_nodes: 1 << 20,
            max_text_units: PAYLOAD_BYTES,
            max_number_bytes: 1024,
            max_depth: 128,
        },
        max_assets: 4096,
        max_asset_bytes: PAYLOAD_BYTES,
        max_total_asset_bytes: PAYLOAD_BYTES + 1024,
    };
    let limits = Limits {
        part_bytes: 1 << 20,
        tag_bytes: 1 << 20,
        records: 4096,
        text_units: 1 << 20,
        output_bytes: 1 << 20,
    };
    for shared in [false, true] {
        LARGE.store(0, Ordering::Relaxed);
        TOTAL.store(0, Ordering::Relaxed);
        LARGEST.store(0, Ordering::Relaxed);
        for _ in 0..20 {
            let baseline = LIVE.load(Ordering::Relaxed);
            let archive = Archive::open(
                Cursor::new(package.as_slice()),
                ZipLimits::default(),
                || false,
            )
            .unwrap();
            let source = CanonicalArchiveSource::decode(
                archive,
                input,
                &mut |_: &[u16]| Ok::<_, ()>(true),
                || false,
            )
            .unwrap();
            let asset = source
                .asset(&source.project().state().source_assets[1].id)
                .unwrap();
            let retained = shared.then(|| source.project().clone());
            let pointer = metadata_pointer(&source);
            TRACK.store(true, Ordering::Relaxed);
            let (source, warnings) = source
                .reconcile_opc(limits, &mut |_: &[u16]| Ok::<_, ()>(true), || false)
                .unwrap();
            assert!(warnings.is_empty());
            assert_eq!(pointer == metadata_pointer(&source), !shared);
            assert!(asset.same_record(&source.asset(asset.id()).unwrap()));
            let author = Authoring::new(
                source.project().state(),
                source.entries().iter().map(|e| e.path()),
                limits,
                || false,
            )
            .unwrap();
            author
                .write_relationships(Source::Root, &mut std::io::sink(), || false)
                .unwrap();
            author
                .write_relationships(Source::Model, &mut std::io::sink(), || false)
                .unwrap();
            author
                .write_content_types(&mut std::io::sink(), || false)
                .unwrap();
            TRACK.store(false, Ordering::Relaxed);
            drop(author);
            drop(warnings);
            drop(source);
            drop(retained);
            drop(asset);
            assert_eq!(LIVE.load(Ordering::Relaxed), baseline);
        }
        let copies = LARGE.load(Ordering::Relaxed);
        let total = TOTAL.load(Ordering::Relaxed);
        let largest = LARGEST.load(Ordering::Relaxed);
        assert_eq!(copies, if shared { 20 } else { 0 });
        assert!(shared || largest <= 65_536);
        println!(
            "{{\"metadataUtf16Bytes\":{PAYLOAD_BYTES},\"cycles\":20,\"retainedSourceSnapshot\":{shared},\"allocationBytes\":{total},\"largestAllocationBytes\":{largest},\"payloadAllocations\":{copies},\"retainedBytes\":0}}"
        );
    }
}
