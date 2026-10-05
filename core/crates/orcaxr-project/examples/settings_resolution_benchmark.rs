//! Synthetic settings projection allocation evidence, not device qualification.
use orcaxr_contracts::canonical::Value;
use orcaxr_project::{
    ids::{SeededRandom, UuidIdSource},
    model::{ConfigMap, Encode, Text, empty_project},
    settings::*,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
const UNITS: usize = 4 * 1024 * 1024;
const PAYLOAD_BYTES: usize = UNITS * size_of::<u16>();
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
fn key(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}
fn main() {
    let notes = key("notes");
    let base = ConfigMap::new(Value::Object(BTreeMap::from([
        (notes.clone(), Value::String(vec![u16::from(b'x'); UNITS])),
        (key("wall_loops"), Value::Number(1.0)),
    ])))
    .unwrap();
    let overrides = ConfigMap::new(Value::Object(BTreeMap::from([(
        key("wall_loops"),
        Value::Number(3.0),
    )])))
    .unwrap();
    let scope = Text::from_utf8("object");
    let note_key = Text::from_utf8("notes");
    let layers = [ScopedOverrideLayer {
        scope: &scope,
        id: None,
        overrides: &overrides,
    }];
    let mut ids = UuidIdSource::new(SeededRandom::new(1.0));
    let mut state = empty_project(
        &mut ids,
        Text::from_utf8("2026-10-05T00:00:00Z"),
        None,
        None,
        None,
    );
    state.config = base.clone();
    let original = if let Value::Object(fields) = base.value() {
        fields.get(&notes).unwrap()
    } else {
        panic!()
    };
    TRACK.store(true, Ordering::SeqCst);
    for _ in 0..200 {
        let resolved = resolve_scoped_config(&base, &layers).unwrap();
        assert!(std::ptr::eq(resolved.get(&notes).unwrap(), original));
        assert!(std::ptr::eq(
            resolved.clone().get(&notes).unwrap(),
            original
        ));
        let explanation = explain_setting(&base, &layers, &note_key).unwrap();
        assert!(std::ptr::eq(explanation.value.unwrap(), original));
        let sanitized = sanitize_scoped_overrides(SettingScope::Project, &base, None);
        assert!(sanitized.removed.is_empty());
        assert!(std::ptr::eq(
            sanitized.overrides.get(&notes).unwrap(),
            original
        ));
        let graph = resolve_config(
            &state,
            ConfigResolutionRequest {
                plate_id: &state.active_plate_id,
                object_id: None,
                volume_id: None,
                layer_range_id: None,
            },
        )
        .unwrap();
        assert!(std::ptr::eq(graph.effective.get(&notes).unwrap(), original));
        assert!(std::ptr::eq(graph.inherited.get(&notes).unwrap(), original));
    }
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(
        LARGE.load(Ordering::SeqCst),
        0,
        "settings resolution copied the configuration payload"
    );
    let largest = LARGEST.load(Ordering::SeqCst);
    let view = resolve_scoped_config(&base, &layers).unwrap();
    TRACK.store(true, Ordering::SeqCst);
    let exported = view.to_value().unwrap();
    TRACK.store(false, Ordering::SeqCst);
    assert_eq!(LARGE.load(Ordering::SeqCst), 1);
    std::hint::black_box(exported);
    println!(
        "{{\"configurationTextBytes\":{PAYLOAD_BYTES},\"resolutionCycles\":200,\"internalPayloadAllocations\":0,\"largestInternalAllocationBytes\":{largest},\"publicCopyPayloadAllocations\":1}}"
    );
}
