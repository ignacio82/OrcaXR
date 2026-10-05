//! Synthetic graph sharing and streamed-hash evidence, not device qualification.
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::model::{Decode, Encode, Number, ProjectData, ProjectState};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Instant;
const ASSIGNED: usize = 300_000;
const PAYLOAD_BYTES: usize = ASSIGNED * size_of::<Value>();
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
        "../../../../testdata/cross-platform/project-model-vectors.json"
    ))
    .unwrap();
    let mut value = parse(fixture["cases"][0]["stateJson"].as_str().unwrap()).unwrap();
    let asset = first(field(&mut value, "sourceAssets"));
    *field(asset, "byteLength") = Value::Number((ASSIGNED * 48) as f64);
    let mesh = field(asset, "mesh");
    *field(mesh, "triangleCount") = Value::Number(ASSIGNED as f64);
    let positions = field(mesh, "positions");
    *field(positions, "count") = Value::Number((ASSIGNED * 3) as f64);
    *field(positions, "byteLength") = Value::Number((ASSIGNED * 36) as f64);
    let indices = field(mesh, "indices");
    *field(indices, "count") = Value::Number((ASSIGNED * 3) as f64);
    *field(indices, "byteOffset") = Value::Number((ASSIGNED * 36) as f64);
    *field(indices, "byteLength") = Value::Number((ASSIGNED * 12) as f64);
    let Value::Array(plates) = field(&mut value, "plates") else {
        panic!()
    };
    for plate in plates {
        let Value::Array(objects) = field(plate, "objects") else {
            panic!()
        };
        for object in objects {
            let Value::Array(volumes) = field(object, "volumes") else {
                panic!()
            };
            for volume in volumes {
                *field(field(volume, "source"), "triangleCount") = Value::Number(ASSIGNED as f64);
                if let Some(Value::Object(channels)) = self::object(field(volume, "annotations"))
                    .get_mut(&"refinement".encode_utf16().collect::<Vec<_>>())
                {
                    for channel in channels.values_mut() {
                        *field(channel, "triangleCount") = Value::Number(ASSIGNED as f64);
                    }
                }
            }
        }
    }
    let volume = first(field(
        first(field(first(field(&mut value, "plates")), "objects")),
        "volumes",
    ));
    *field(field(volume, "source"), "triangleCount") = Value::Number(ASSIGNED as f64);
    let annotations = field(volume, "annotations");
    object(annotations).remove(&"refinement".encode_utf16().collect::<Vec<_>>());
    *field(first(field(annotations, "color")), "triangles") =
        Value::Array((0..ASSIGNED).map(|i| Value::Number(i as f64)).collect());
    let state = ProjectState::from_value(value).unwrap();
    TRACK.store(true, Ordering::SeqCst);
    let start = Instant::now();
    let original = ProjectData::new(state).unwrap();
    assert_eq!(
        original.fingerprint(),
        fixture["resourceCase"]["fingerprint"].as_str().unwrap()
    );
    let mut history = Vec::new();
    for index in 0..20 {
        let mut next = original.to_candidate();
        let plate = Arc::make_mut(&mut Arc::make_mut(&mut next.plates)[0]);
        let object = Arc::make_mut(&mut Arc::make_mut(&mut plate.objects)[0]);
        let instance = Arc::make_mut(&mut Arc::make_mut(&mut object.instances)[0]);
        instance.transform.translation_mm[0] = Number::new(index as f64 + 0.25).unwrap();
        let next = ProjectData::new(next).unwrap();
        assert!(Arc::ptr_eq(
            &original.state().plates[0].objects[0].volumes,
            &next.state().plates[0].objects[0].volumes
        ));
        history.push(next);
    }
    for snapshot in &history {
        assert_ne!(snapshot.fingerprint(), original.fingerprint());
        assert!(snapshot.same_allocation(&snapshot.clone()));
    }
    TRACK.store(false, Ordering::SeqCst);
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    let largest = LARGEST.load(Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        0,
        "graph snapshots/edits/hash copied the annotation payload"
    );
    // Public mutable exports must copy; prove this instrument sees that allocation.
    TRACK.store(true, Ordering::SeqCst);
    let copy = original.state().to_value().unwrap();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(LARGE.load(Ordering::SeqCst), 1);
    std::hint::black_box(copy);
    println!(
        "{{\"assignedTriangles\":{ASSIGNED},\"annotationArrayBytes\":{PAYLOAD_BYTES},\"immutableEditSnapshots\":20,\"internalPayloadAllocations\":0,\"largestInternalAllocationBytes\":{largest},\"publicCopyPayloadAllocations\":1,\"elapsedMs\":{elapsed:.3}}}"
    );
}
