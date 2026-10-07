//! Borrowed mesh validation/bounds and explicit materialization allocation evidence.
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

use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::AssetRepository,
    mesh::{self, BoundsLimits, Coordinates, EncodeOptions, Limits, Mesh},
    model::{Decode, Number, ProjectState, SourceAssetDescriptor, Text},
};
use std::sync::Arc;
fn measure(label: &str, payloads: usize, mut run: impl FnMut()) {
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
    let total = TOTAL.load(Ordering::Relaxed);
    let largest = LARGEST.load(Ordering::Relaxed);
    let large = LARGE.load(Ordering::Relaxed);
    assert_eq!(retained, 0);
    assert_eq!(large, payloads);
    if payloads == 0 {
        assert!(total < 1 << 20);
        assert!(largest < 65536);
    }
    println!(
        "{{\"phase\":\"{label}\",\"cycles\":20,\"allocatedBytes\":{total},\"largestAllocationBytes\":{largest},\"payloadAllocations\":{large},\"retainedBytes\":{retained}}}"
    );
}
fn main() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/mesh-vectors.json"
    ))
    .unwrap();
    let mut state = ProjectState::from_value(
        parse(corpus["bounds"][0]["stateJson"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    drop(corpus);
    let id = state.source_assets[0].id.clone();
    let selected = vec![state.plates[0].objects[0].instances[0].id.clone()];
    const VERTICES: usize = 2_000_000;
    const TRIANGLES: usize = 2_000_000;
    let positions: Vec<f32> = (0..VERTICES)
        .flat_map(|i| [(i % 1000) as f32, (i / 1000) as f32, (i % 7) as f32])
        .collect();
    let indices: Vec<u32> = (0..TRIANGLES * 3).map(|i| (i % VERTICES) as u32).collect();
    let limits = Limits {
        asset_bytes: 64 << 20,
        vertices: VERTICES,
        indices: indices.len(),
    };
    let options = || EncodeOptions {
        metadata_bytes: 1 << 20,
        id: id.clone(),
        source_filename: Some(Text::from_utf8("synthetic.mesh")),
        provenance: None,
    };
    let mut payload = mesh::encode(
        options(),
        Coordinates::Float32(&positions),
        Some(&indices),
        limits,
        || false,
    )
    .unwrap();
    assert_eq!(payload.bytes.len(), 48_000_000);
    let Value::Object(fields) = &mut payload.descriptor else {
        panic!()
    };
    fields.insert(
        "extra".encode_utf16().collect(),
        Value::String(vec![120; PAYLOAD_BYTES / 2]),
    );
    let descriptor = SourceAssetDescriptor::from_value(payload.descriptor.clone()).unwrap();
    state.source_assets = vec![Arc::new(descriptor)].into();
    let plate = Arc::make_mut(&mut Arc::make_mut(&mut state.plates)[0]);
    let object = Arc::make_mut(&mut Arc::make_mut(&mut plate.objects)[0]);
    let volume = Arc::make_mut(&mut Arc::make_mut(&mut object.volumes)[0]);
    volume.source.triangle_count = Number::new(TRIANGLES as f64).unwrap();
    let volume_transform = volume.transform.clone();
    let instance_transform = object.instances[0].transform.clone();
    let mut repo = AssetRepository::new();
    repo.put_owned(payload).unwrap();
    let lease = repo.peek(&id).unwrap();
    let snapshot = repo.capture_internal();
    let pointer = lease.bytes().as_ptr();
    measure("borrowed-validation-bounds", 0, || {
        let mesh = Mesh::open(lease.clone(), limits, || false).unwrap();
        let retained = mesh.clone();
        drop(mesh);
        assert_eq!(retained.asset().bytes().as_ptr(), pointer);
        assert!(retained.asset().same_record(&lease));
        let b = retained
            .bounds(&volume_transform, &instance_transform, || false)
            .unwrap();
        std::hint::black_box(b);
    });
    let limits_bounds = BoundsLimits {
        mesh: limits,
        selected: 1,
        assets: 1,
        vertex_visits: VERTICES,
    };
    measure("canonical-instance-bounds", 0, || {
        std::hint::black_box(
            mesh::instance_bounds(&state, &snapshot, &selected, None, limits_bounds, || false)
                .unwrap(),
        );
    });
    measure("packed-encoding", 20, || {
        let payload = mesh::encode(
            options(),
            Coordinates::Float32(&positions),
            Some(&indices),
            limits,
            || false,
        )
        .unwrap();
        assert_eq!(payload.bytes.len(), 48_000_000);
        std::hint::black_box(payload);
    });
    let mesh = Mesh::open(lease, limits, || false).unwrap();
    measure("explicit-expanded-copy", 20, || {
        let expanded = mesh.expand(72_000_000, || false).unwrap();
        assert_eq!(expanded.len() * 4, 72_000_000);
        std::hint::black_box(expanded);
    });
}
