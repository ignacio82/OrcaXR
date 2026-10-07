//! Borrowed BBS settings, fallback vectors and reset scripts with bounded output.
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

use orcaxr_archive::bbs::model::{self, settings};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{model::*, validation::ValidatedProject};
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
        "../../../../testdata/cross-platform/bbs-settings-vectors.json"
    ))
    .unwrap();
    let row = c["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "exact-library-2")
        .unwrap();
    let mut state =
        ProjectState::from_value(parse(row["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    // Three independent 8 MiB UTF-16 payloads. Only the missing physical value
    // falls back to the first physical value, so the same payload is emitted twice.
    let mut fields = BTreeMap::new();
    fields.insert(
        key("nested"),
        Value::Object(BTreeMap::from([(
            key("payload"),
            Value::String(vec![34; PAYLOAD_BYTES / 2]),
        )])),
    );
    fields.insert(
        key("before_layer_change_gcode"),
        Value::String(vec![32; PAYLOAD_BYTES / 2]),
    );
    state.config = ConfigMap::new(Value::Object(fields)).unwrap();
    let physical = Arc::make_mut(&mut state.filaments.physical);
    Arc::make_mut(&mut physical[0]).config = ConfigMap::new(Value::Object(BTreeMap::from([(
        key("filament_notes"),
        Value::String(vec![10; PAYLOAD_BYTES / 2]),
    )])))
    .unwrap();
    for f in physical.iter_mut().skip(1) {
        Arc::make_mut(f).config = ConfigMap::new(Value::Object(BTreeMap::new())).unwrap();
    }
    let pattern_tokens =
        PAYLOAD_BYTES / std::mem::size_of::<orcaxr_project::ids::PhysicalFilamentId>();
    let pattern: Vec<_> = (0..pattern_tokens)
        .map(|i| physical[i % 2].id.clone())
        .collect();
    let mixed = Arc::make_mut(&mut Arc::make_mut(&mut state.filaments.mixed)[0]);
    Arc::make_mut(mixed.full_spectrum.as_mut().unwrap()).manual_pattern_groups =
        vec![Arc::from(pattern)].into();
    let mut timestamp = |_: &[u16]| Ok::<_, ()>(true);
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut timestamp).unwrap();
    let model = model::Authoring::new(
        &project,
        [],
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
    let limits = settings::Limits {
        records: 1_000_000,
        config_nodes: 1000,
        config_depth: 128,
        text_units: 128 << 20,
        derived_values: 10000,
        output_bytes: 128 << 20,
    };
    measure("prepare-borrowed-settings", || {
        std::hint::black_box(settings::Authoring::new(&model, limits, || false).unwrap());
    });
    let settings = settings::Authoring::new(&model, limits, || false).unwrap();
    let mut identity = None;
    measure("write-borrowed-settings", || {
        let mut sink = Sink {
            bytes: 0,
            hash: Sha256::new(),
        };
        settings.write(&mut sink, || false).unwrap();
        let current = (sink.bytes, <[u8; 32]>::from(sink.hash.finalize()));
        if let Some(old) = identity {
            assert_eq!(current, old);
        } else {
            identity = Some(current);
        }
    });
    assert_eq!(TOTAL.load(Ordering::Relaxed), 0, "writer must not allocate");
    let (bytes, digest) = identity.unwrap();
    let hash = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    println!(
        "{{\"configUtf16Bytes\":{PAYLOAD_BYTES},\"resetUtf16Bytes\":{PAYLOAD_BYTES},\"fallbackUtf16Bytes\":{PAYLOAD_BYTES},\"patternIdBytes\":{PAYLOAD_BYTES},\"patternTokens\":{pattern_tokens},\"outputBytes\":{bytes},\"sha256\":\"{hash}\"}}"
    );
    TOTAL.store(0, Ordering::Relaxed);
    let live = LIVE.load(Ordering::Relaxed);
    TRACK.store(true, Ordering::SeqCst);
    std::hint::black_box(vec![32u16; PAYLOAD_BYTES / 2]);
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(TOTAL.load(Ordering::Relaxed), PAYLOAD_BYTES);
    assert_eq!(LIVE.load(Ordering::Relaxed), live);
    println!(
        "{{\"phase\":\"deliberate-copy-control\",\"allocatedBytes\":{PAYLOAD_BYTES},\"retainedBytes\":0}}"
    );
}
