//! Complete standard model projection over a large borrowed mesh and metadata.
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

use orcaxr_archive::bbs::model::{Authoring, Limits};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::AssetRepository,
    mesh::{self, Coordinates, EncodeOptions},
    model::*,
    validation::ValidatedProject,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, Write},
    sync::Arc,
};
const COUNT: usize = 2_000_000;
fn key(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
struct Sink {
    bytes: usize,
    hash: Sha256,
}
impl Write for Sink {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        assert!(b.len() <= 4096);
        self.bytes += b.len();
        self.hash.update(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        panic!("host owns flush")
    }
}
fn measure(label: &str, mut run: impl FnMut()) {
    let live = LIVE.load(Ordering::Relaxed);
    TOTAL.store(0, Ordering::Relaxed);
    LARGEST.store(0, Ordering::Relaxed);
    LARGE.store(0, Ordering::Relaxed);
    TRACK.store(true, Ordering::SeqCst);
    for _ in 0..5 {
        run();
    }
    TRACK.store(false, Ordering::SeqCst);
    let total = TOTAL.load(Ordering::Relaxed);
    let largest = LARGEST.load(Ordering::Relaxed);
    let retained = LIVE.load(Ordering::Relaxed) as i64 - live as i64;
    let payload = LARGE.load(Ordering::Relaxed);
    assert_eq!(retained, 0);
    assert_eq!(payload, 0);
    assert!(largest < 65536);
    assert!(total < 1 << 20);
    println!(
        "{{\"phase\":\"{label}\",\"cycles\":5,\"allocatedBytes\":{total},\"largestAllocationBytes\":{largest},\"payloadAllocations\":{payload},\"retainedBytes\":{retained}}}"
    );
}
fn main() {
    let c: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/bbs-model-vectors.json"
    ))
    .unwrap();
    let row = c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "split-color")
        .unwrap();
    let mut state =
        ProjectState::from_value(parse(row["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let id = state.source_assets[0].id.clone();
    let positions: Vec<_> = (0..COUNT * 3).map(|i| (i % 97) as f32 / 13.0).collect();
    let indices: Vec<_> = (0..COUNT * 3).map(|i| (i % COUNT) as u32).collect();
    let mesh_limits = mesh::Limits {
        asset_bytes: 48_000_000,
        vertices: COUNT,
        indices: COUNT * 3,
    };
    let payload = mesh::encode(
        EncodeOptions {
            id: id.clone(),
            source_filename: None,
            provenance: None,
            metadata_bytes: 4096,
        },
        Coordinates::Float32(&positions),
        Some(&indices),
        mesh_limits,
        || false,
    )
    .unwrap();
    state.source_assets = vec![Arc::new(
        SourceAssetDescriptor::from_value(payload.descriptor.clone()).unwrap(),
    )]
    .into();
    let plate = Arc::make_mut(&mut Arc::make_mut(&mut state.plates)[0]);
    let object = Arc::make_mut(&mut Arc::make_mut(&mut plate.objects)[0]);
    let volume = Arc::make_mut(&mut Arc::make_mut(&mut object.volumes)[0]);
    volume.source.triangle_count = Number::new(COUNT as f64).unwrap();
    let mut annotations = volume.annotations.to_value().unwrap();
    let Value::Object(fields) = &mut annotations else {
        panic!()
    };
    let Value::Object(refinement) = fields.get_mut(&key("refinement")).unwrap() else {
        panic!()
    };
    let Value::Object(color) = refinement.get_mut(&key("color")).unwrap() else {
        panic!()
    };
    color.insert(key("triangleCount"), Value::Number(COUNT as f64));
    volume.annotations = Arc::new(FacetAnnotations::from_value(annotations).unwrap());
    let attribute = Value::Object(BTreeMap::from([
        (key("namespace"), Value::String(key("urn:large"))),
        (key("name"), Value::String(key("payload"))),
        (key("value"), Value::String(vec![38; PAYLOAD_BYTES / 2])),
    ]));
    let extensions = Value::Object(BTreeMap::from([(
        key("https://orcaxr.martinez.fyi/3mf/project/1/core-object-attributes"),
        Value::Array(vec![attribute]),
    )]));
    volume.extension_data = Some(JsonObject::new(extensions).unwrap());
    let mut timestamps = |_: &[u16]| Ok::<_, ()>(true);
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut timestamps).unwrap();
    let mut repo = AssetRepository::new();
    repo.put_owned(payload).unwrap();
    let asset = repo.peek(&id).unwrap();
    drop(repo);
    drop(positions);
    drop(indices);
    let limits = Limits {
        mesh: mesh_limits,
        records: 100,
        text_units: 16 << 20,
        paint_entries: 100,
        paint_nodes: 100,
        vertices: COUNT,
        triangles: COUNT,
        output_bytes: 1 << 30,
    };
    measure("prepare-borrowed-large-model", || {
        std::hint::black_box(Authoring::new(&project, [asset.clone()], limits, || false).unwrap());
    });
    let prepared = Authoring::new(&project, [asset.clone()], limits, || false).unwrap();
    let mut identity = None;
    measure("write-complete-large-model", || {
        let mut out = Sink {
            bytes: 0,
            hash: Sha256::new(),
        };
        assert_eq!(prepared.write(&mut out, || false).unwrap(), out.bytes);
        let current = (out.bytes, <[u8; 32]>::from(out.hash.finalize()));
        if let Some(expected) = identity {
            assert_eq!(current, expected);
        } else {
            identity = Some(current);
        }
    });
    let (size, digest) = identity.unwrap();
    let digest = digest
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect::<String>();
    println!(
        "{{\"vertices\":{COUNT},\"triangles\":{COUNT},\"sourceBytes\":48000000,\"extensionUtf16Bytes\":{PAYLOAD_BYTES},\"outputBytes\":{size},\"sha256\":\"{digest}\"}}"
    );
    TOTAL.store(0, Ordering::Relaxed);
    let live = LIVE.load(Ordering::Relaxed);
    TRACK.store(true, Ordering::SeqCst);
    std::hint::black_box(asset.bytes().to_vec());
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(TOTAL.load(Ordering::Relaxed), 48_000_000);
    assert_eq!(LIVE.load(Ordering::Relaxed), live);
    println!(
        "{{\"phase\":\"deliberate-copy-control\",\"allocatedBytes\":48000000,\"retainedBytes\":0}}"
    );
}
