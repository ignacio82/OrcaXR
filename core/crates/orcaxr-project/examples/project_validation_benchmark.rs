//! Sparse graph validation and proof-reuse allocation evidence, not device timing.
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{model::*, validation::*};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
const ASSIGNED: usize = 100_000;
const PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
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
fn object(value: &mut Value) -> &mut BTreeMap<Vec<u16>, Value> {
    let Value::Object(fields) = value else {
        panic!()
    };
    fields
}
fn field<'a>(value: &'a mut Value, name: &str) -> &'a mut Value {
    object(value)
        .get_mut(&name.encode_utf16().collect::<Vec<_>>())
        .unwrap()
}
fn first(value: &mut Value) -> &mut Value {
    let Value::Array(values) = value else {
        panic!()
    };
    &mut values[0]
}

fn main() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-validation-vectors.json"
    ))
    .unwrap();
    let base = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "base")
        .unwrap();
    let mut value = parse(base["stateJson"].as_str().unwrap()).unwrap();
    let mesh = field(first(field(&mut value, "sourceAssets")), "mesh");
    *field(mesh, "triangleCount") = Value::Number(1_897_256.0);
    let volume = first(field(
        first(field(first(field(&mut value, "plates")), "objects")),
        "volumes",
    ));
    *field(field(volume, "source"), "triangleCount") = Value::Number(1_897_256.0);
    *field(
        first(field(field(volume, "annotations"), "color")),
        "triangles",
    ) = Value::Array((0..ASSIGNED).map(|i| Value::Number(i as f64)).collect());
    let mut state = ProjectState::from_value(value).unwrap();
    let config = Value::Object(BTreeMap::from([
        (
            "notes".encode_utf16().collect(),
            Value::String(vec![b'x' as u16; PAYLOAD_BYTES / 2]),
        ),
        (
            "metadata".encode_utf16().collect(),
            Value::Array((0..ASSIGNED).map(|i| Value::Number(i as f64)).collect()),
        ),
    ]));
    // Equal but separately owned config values exercise structural comparison,
    // including a wide array. Create the payloads before tracking validation.
    state.config = JsonObject::new(config.clone()).unwrap();
    state.settings_base_config = Some(JsonObject::new(config).unwrap());
    state.settings_overrides = Some(JsonObject::new(Value::Object(BTreeMap::new())).unwrap());
    let data = ProjectData::new(state).unwrap();
    let mut policy = V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    );
    TRACK.store(true, Ordering::SeqCst);
    let valid = ValidatedProject::new(data.clone(), &mut policy).unwrap();
    TRACK.store(false, Ordering::SeqCst);
    let largest = LARGEST.load(Ordering::SeqCst);
    let total = TOTAL.load(Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        0,
        "validation copied a payload or allocated dense roots"
    );
    assert!(
        total < ASSIGNED * 32 + 65536,
        "validation allocated scalar diagnostic paths or a wide equality stack: {total}"
    );
    assert!(valid.data().same_allocation(&data));
    TRACK.store(true, Ordering::SeqCst);
    for _ in 0..200 {
        let copy = valid.clone();
        assert!(valid.same_allocation(&copy));
        assert!(copy.report().is_valid());
        assert_eq!(copy.fingerprint(), data.fingerprint());
        assert!(Arc::ptr_eq(&copy.state().plates, &data.state().plates));
        std::hint::black_box(copy);
    }
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(
        TOTAL.load(Ordering::SeqCst),
        total,
        "proof reuse allocated or revalidated"
    );
    TRACK.store(true, Ordering::SeqCst);
    let public_copy = valid.state().config.to_value().unwrap();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(LARGE.load(Ordering::SeqCst), 1);
    std::hint::black_box(public_copy);
    println!(
        "{{\"sourceTriangles\":1897256,\"assignedTriangles\":{ASSIGNED},\"configurationTextBytes\":{PAYLOAD_BYTES},\"validationAllocationBytes\":{total},\"largestValidationAllocationBytes\":{largest},\"internalPayloadAllocations\":0,\"proofReuseCycles\":200,\"proofReuseAllocationBytes\":0,\"publicCopyPayloadAllocations\":1}}"
    );
}
