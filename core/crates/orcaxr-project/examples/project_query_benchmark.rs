//! Query captures retain large metadata/paint; bounded reads must not copy it.
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    model::*,
    query::{QueryNode, layout::*},
    store::*,
    validation::*,
};
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

fn main() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-validation-vectors.json"
    ))
    .unwrap();
    let base = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "base")
        .unwrap();
    let mut state =
        ProjectState::from_value(parse(base["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    state.name = Text::new(vec![b'x' as u16; PAYLOAD_BYTES / 2]);
    let config = JsonObject::new(Value::Object(BTreeMap::from([(
        "notes".encode_utf16().collect(),
        Value::String(vec![b'y' as u16; PAYLOAD_BYTES / 2]),
    )])))
    .unwrap();
    state.config = config.clone();
    state.settings_base_config = Some(config);
    state.settings_overrides = None;
    Arc::make_mut(
        Arc::make_mut(&mut Arc::make_mut(&mut state.source_assets)[0])
            .mesh
            .as_mut()
            .unwrap(),
    )
    .triangle_count = Number::new(1_897_256.0).unwrap();
    let plate = Arc::make_mut(&mut Arc::make_mut(&mut state.plates)[0]);
    let object = Arc::make_mut(&mut Arc::make_mut(&mut plate.objects)[0]);
    let volume = Arc::make_mut(&mut Arc::make_mut(&mut object.volumes)[0]);
    volume.source.triangle_count = Number::new(1_897_256.0).unwrap();
    Arc::make_mut(&mut volume.annotations).color =
        Assignments::from_value(Value::Array(vec![Value::Object(BTreeMap::from([
            (
                "value".encode_utf16().collect(),
                Value::String(state.filaments.physical[0].id.as_utf16().to_vec()),
            ),
            (
                "triangles".encode_utf16().collect(),
                Value::Array((0..ASSIGNED).map(|i| Value::Number(i as f64)).collect()),
            ),
        ]))]))
        .unwrap();
    let mut policy = |_: &[u16]| Ok::<_, ()>(true);
    let admitted = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut policy).unwrap();
    let store = ProjectStore::new(admitted.clone());
    let root = QueryNode::new(store.snapshot());
    drop(store);
    TRACK.store(true, Ordering::SeqCst);
    for _ in 0..200 {
        std::hint::black_box(root.metadata().unwrap());
        std::hint::black_box(
            root.read_text(TextField::Name, 0, MAX_TEXT_CHUNK_UNITS)
                .unwrap(),
        );
        let plates = root.children(Relation::Plates, 1).unwrap();
        let objects = plates
            .node(0)
            .unwrap()
            .children(Relation::Objects, 0)
            .unwrap();
        let volumes = objects
            .node(0)
            .unwrap()
            .children(Relation::Volumes, 0)
            .unwrap();
        std::hint::black_box(volumes.page(0, 1).unwrap());
        let v = volumes.node(0).unwrap();
        assert!(v.snapshot().project().same_allocation(&admitted));
        std::hint::black_box(
            v.read_text(
                TextField::Name,
                0,
                v.text(TextField::Name).unwrap().unwrap().len(),
            )
            .unwrap(),
        );
    }
    TRACK.store(false, Ordering::SeqCst);
    let largest = LARGEST.load(Ordering::SeqCst);
    let total = TOTAL.load(Ordering::SeqCst);
    assert_eq!(LARGE.load(Ordering::SeqCst), 0);
    assert!(largest <= 65536);
    TRACK.store(true, Ordering::SeqCst);
    let positive = admitted.state().config.to_value().unwrap();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(LARGE.load(Ordering::SeqCst), 1);
    std::hint::black_box(positive);
    println!(
        "{{\"sourceTriangles\":1897256,\"assignedTriangles\":{ASSIGNED},\"nameBytes\":{PAYLOAD_BYTES},\"configBytes\":{PAYLOAD_BYTES},\"queryCycles\":200,\"internalAllocationBytes\":{total},\"largestInternalAllocationBytes\":{largest},\"internalPayloadAllocations\":0,\"publicCopyPayloadAllocations\":1}}"
    );
}
