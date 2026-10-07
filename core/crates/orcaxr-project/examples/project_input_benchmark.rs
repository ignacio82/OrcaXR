//! Synthetic staged document/payload ownership, not device performance.
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::*,
    ingress::{json::*, *},
    model::*,
    validation::*,
};
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

fn main() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-session-vectors.json"
    ))
    .unwrap();
    let source = &fixture["traces"][0]["stateJson"];
    let mut graph = parse(source.as_str().unwrap()).unwrap();
    let Value::Object(root) = &mut graph else {
        panic!()
    };
    root.insert(
        "futureText".encode_utf16().collect(),
        Value::String(vec![120; 1024 * 1024]),
    );
    root.insert(
        "futureWide".encode_utf16().collect(),
        Value::Array((0..100_001).map(|i| Value::Number(f64::from(i))).collect()),
    );
    let Value::Array(assets) = root
        .get_mut(&"sourceAssets".encode_utf16().collect::<Vec<_>>())
        .unwrap()
    else {
        panic!()
    };
    let Value::Object(descriptor) = &mut assets[0] else {
        panic!()
    };
    let bytes = vec![0u8; PAYLOAD_BYTES];
    descriptor.insert(
        "byteLength".encode_utf16().collect(),
        Value::Number(PAYLOAD_BYTES as f64),
    );
    descriptor.insert(
        "digest".encode_utf16().collect(),
        Value::String(content_digest(&bytes).encode_utf16().collect()),
    );
    let mut source = Vec::new();
    graph.write_canonical(&mut source).unwrap();
    let expected = ProjectData::new(ProjectState::from_value(graph).unwrap()).unwrap();
    let limits = ProjectInputLimits {
        document: JsonLimits {
            max_bytes: source.len(),
            max_nodes: 200_000,
            max_text_units: 2 * 1024 * 1024,
            max_number_bytes: 64,
            max_depth: 128,
        },
        max_assets: 1,
        max_asset_bytes: PAYLOAD_BYTES,
        max_total_asset_bytes: PAYLOAD_BYTES,
    };
    let mut time = V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |v: timestamp::LocalDateTime| Ok::<_, ()>(v.civil_milliseconds()),
    );
    TRACK.store(true, Ordering::Relaxed);
    let mut input = ProjectInput::new(source.len(), limits).unwrap();
    for (i, chunk) in source.chunks(MAX_CHUNK_BYTES).enumerate() {
        input.append(i * MAX_CHUNK_BYTES, chunk).unwrap();
    }
    let mut bundle = input.finish(&mut time).unwrap();
    assert_eq!(bundle.project().fingerprint(), expected.fingerprint());
    assert!(bundle.project().data().same_content(&expected));
    let document_total = TOTAL.load(Ordering::Relaxed);
    let document_largest = LARGEST.load(Ordering::Relaxed);
    let id = bundle.project().state().source_assets[0].id.clone();
    let before = LIVE.load(Ordering::Relaxed);
    bundle.begin_asset(&id).unwrap();
    bundle.append_asset(0, &bytes[..MAX_CHUNK_BYTES]).unwrap();
    let staged = LIVE.load(Ordering::Relaxed) - before;
    assert!(staged >= PAYLOAD_BYTES);
    bundle.cancel_asset();
    assert_eq!(LIVE.load(Ordering::Relaxed), before);
    LARGE.store(0, Ordering::Relaxed);
    bundle.begin_asset(&id).unwrap();
    for (i, chunk) in bytes.chunks(MAX_CHUNK_BYTES).enumerate() {
        bundle.append_asset(i * MAX_CHUNK_BYTES, chunk).unwrap();
    }
    bundle.finish_asset().unwrap();
    let (project, assets) = bundle.finish().unwrap();
    assert_eq!(project.fingerprint(), expected.fingerprint());
    let lease = assets.peek(&id).unwrap();
    assert_eq!(lease.bytes(), bytes);
    let payload_allocations = LARGE.load(Ordering::Relaxed);
    assert_eq!(
        payload_allocations, 1,
        "one payload allocation, no copy on repository admission"
    );
    let copy = assets.get(&id).unwrap();
    assert_eq!(copy.bytes, bytes);
    assert_ne!(copy.bytes.as_ptr(), lease.bytes().as_ptr());
    assert_eq!(
        LARGE.load(Ordering::Relaxed),
        2,
        "public copy positive control"
    );
    drop(assets);
    assert_eq!(lease.bytes(), bytes);
    TRACK.store(false, Ordering::Relaxed);
    println!(
        "{}",
        serde_json::json!({"documentBytes":source.len(),"documentAllocationBytes":document_total,"largestDocumentAllocationBytes":document_largest,"assetBytes":PAYLOAD_BYTES,"cancelledAssetReleasedBytes":staged,"assetTransferPayloadAllocations":payload_allocations,"publicReadAdditionalCopies":1})
    );
}
