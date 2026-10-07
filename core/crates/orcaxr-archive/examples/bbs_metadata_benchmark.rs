//! Borrowed BBS configuration/emboss/drawing ownership and bounded streaming.
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

use orcaxr_archive::bbs::model::{
    self,
    metadata::{self, Member},
};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::{AssetPayload, AssetRepository, content_digest},
    model::*,
    validation::ValidatedProject,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, Write},
    sync::Arc,
};
fn key(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
struct Sink {
    bytes: usize,
    hash: Sha256,
}
impl Write for Sink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        assert!(bytes.len() <= 4096);
        self.bytes += bytes.len();
        self.hash.update(bytes);
        Ok(bytes.len())
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
        "../../../../testdata/cross-platform/bbs-metadata-vectors.json"
    ))
    .unwrap();
    let row = c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "svg-and-text")
        .unwrap();
    let mut state =
        ProjectState::from_value(parse(row["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let mut repo = AssetRepository::new();
    let mut leases = vec![];
    for (i, a) in row["assets"].as_array().unwrap().iter().enumerate() {
        let mut descriptor = parse(a["descriptorJson"].as_str().unwrap()).unwrap();
        let bytes = if i == 1 {
            vec![120; PAYLOAD_BYTES]
        } else {
            a["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect()
        };
        let Value::Object(ref mut fields) = descriptor else {
            panic!()
        };
        fields.insert(key("byteLength"), Value::Number(bytes.len() as f64));
        fields.insert(key("digest"), Value::String(key(&content_digest(&bytes))));
        let declared = SourceAssetDescriptor::from_value(descriptor.clone()).unwrap();
        let id = declared.id.clone();
        Arc::make_mut(&mut state.source_assets)[i] = Arc::new(declared);
        repo.put_owned(AssetPayload { descriptor, bytes }).unwrap();
        leases.push(repo.peek(&id).unwrap());
    }
    let plate = Arc::make_mut(&mut Arc::make_mut(&mut state.plates)[0]);
    let object = Arc::make_mut(&mut Arc::make_mut(&mut plate.objects)[0]);
    let volume = Arc::make_mut(&mut Arc::make_mut(&mut object.volumes)[0]);
    let mut fields = BTreeMap::new();
    fields.insert(
        key("nested"),
        Value::Object(BTreeMap::from([(
            key("payload"),
            Value::String(vec![38; PAYLOAD_BYTES / 2]),
        )])),
    );
    volume.config = ConfigMap::new(Value::Object(fields)).unwrap();
    let emboss = Arc::make_mut(volume.emboss_text.as_mut().unwrap());
    emboss.text = Text::new(vec![10; PAYLOAD_BYTES / 2]);
    let mut timestamp = |_: &[u16]| Ok::<_, ()>(true);
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut timestamp).unwrap();
    let model = model::Authoring::new(
        &project,
        leases.clone(),
        model::Limits {
            mesh: orcaxr_project::mesh::Limits {
                asset_bytes: 1 << 20,
                vertices: 100,
                indices: 100,
            },
            records: 1000,
            text_units: 1 << 20,
            paint_entries: 100,
            paint_nodes: 100,
            vertices: 100,
            triangles: 100,
            output_bytes: 1 << 20,
        },
        || false,
    )
    .unwrap();
    let limits = metadata::Limits {
        records: 1000,
        config_nodes: 1000,
        config_depth: 128,
        text_units: 32 << 20,
        drawing_bytes: PAYLOAD_BYTES,
        output_bytes: 128 << 20,
    };
    measure("prepare-borrowed-metadata", || {
        std::hint::black_box(
            metadata::Authoring::new(&model, leases.iter().cloned(), limits, || false).unwrap(),
        );
    });
    let metadata =
        metadata::Authoring::new(&model, leases.iter().cloned(), limits, || false).unwrap();
    let pointer = leases[1].bytes().as_ptr();
    drop(repo);
    drop(leases);
    assert_eq!(
        metadata.drawings().next().unwrap().1.bytes().as_ptr(),
        pointer
    );
    let mut identity = None;
    measure("write-borrowed-metadata", || {
        let mut sink = Sink {
            bytes: 0,
            hash: Sha256::new(),
        };
        for member in Member::ALL {
            metadata.write(member, &mut sink, || false).unwrap();
        }
        let current = (sink.bytes, <[u8; 32]>::from(sink.hash.finalize()));
        if let Some(old) = identity {
            assert_eq!(current, old);
        } else {
            identity = Some(current);
        }
    });
    let (bytes, digest) = identity.unwrap();
    let hash = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    println!(
        "{{\"drawingBytes\":{PAYLOAD_BYTES},\"configUtf16Bytes\":{PAYLOAD_BYTES},\"embossUtf16Bytes\":{PAYLOAD_BYTES},\"outputBytes\":{bytes},\"sha256\":\"{hash}\"}}"
    );
    TOTAL.store(0, Ordering::Relaxed);
    let live = LIVE.load(Ordering::Relaxed);
    TRACK.store(true, Ordering::SeqCst);
    std::hint::black_box(metadata.drawings().next().unwrap().1.bytes().to_vec());
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(TOTAL.load(Ordering::Relaxed), PAYLOAD_BYTES);
    assert_eq!(LIVE.load(Ordering::Relaxed), live);
    println!(
        "{{\"phase\":\"deliberate-copy-control\",\"allocatedBytes\":{PAYLOAD_BYTES},\"retainedBytes\":0}}"
    );
}
