//! Complete package output ownership. Input admission and verification excluded.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
const PAYLOAD_BYTES: usize = 8 << 20;
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

#[path = "../tests/support/package.rs"]
mod support;
use orcaxr_archive::{Archive, package};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::{AssetPayload, AssetRepository, content_digest},
    model::*,
    validation::ValidatedProject,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom},
    sync::Arc,
};
fn key(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
fn main() {
    let sources = support::sources();
    // Read reference sources too: the support module is shared with independent
    // qualification tests, not a new benchmark-only project schema.
    assert!(
        !support::references()["cases"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let row = sources["bbs-metadata"]["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "svg-and-text")
        .unwrap();
    let (base, _) = support::input(row);
    let mut state = base.state().clone();
    let mut repo = AssetRepository::new();
    let mut leases = vec![];
    let mut seed = 0x87ac416du32;
    for (i, a) in row["assets"].as_array().unwrap().iter().enumerate() {
        let mut descriptor = parse(a["descriptorJson"].as_str().unwrap()).unwrap();
        let bytes: Vec<u8> = if i == 1 {
            (0..PAYLOAD_BYTES)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    seed as u8
                })
                .collect()
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
        let declaration = SourceAssetDescriptor::from_value(descriptor.clone()).unwrap();
        let id = declaration.id.clone();
        Arc::make_mut(&mut state.source_assets)[i] = Arc::new(declaration);
        repo.put_owned(AssetPayload { descriptor, bytes }).unwrap();
        leases.push(repo.peek(&id).unwrap());
    }
    let plate = Arc::make_mut(&mut Arc::make_mut(&mut state.plates)[0]);
    let object = Arc::make_mut(&mut Arc::make_mut(&mut plate.objects)[0]);
    let volume = Arc::make_mut(&mut Arc::make_mut(&mut object.volumes)[0]);
    volume.config = ConfigMap::new(Value::Object(BTreeMap::from([(
        key("payload"),
        Value::String(vec![38; PAYLOAD_BYTES / 2]),
    )])))
    .unwrap();
    Arc::make_mut(volume.emboss_text.as_mut().unwrap()).text =
        Text::new(vec![10; PAYLOAD_BYTES / 2]);
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut |_: &[u16]| {
        Ok::<_, ()>(true)
    })
    .unwrap();
    drop(base);
    drop(sources);
    drop(repo);
    let mut limits = support::limits();
    limits.metadata.output_bytes = 128 << 20;
    let path = std::env::temp_dir().join(format!("orcaxr-package-{}.3mf", std::process::id()));
    let mut output = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let mut expected = None;
    let mut allocated = 0;
    let mut largest = 0;
    let mut result_bytes = 0;
    let mut expanded = 0;
    for _ in 0..5 {
        output.set_len(0).unwrap();
        output.seek(SeekFrom::Start(0)).unwrap();
        let baseline = LIVE.load(Ordering::Relaxed);
        TOTAL.store(0, Ordering::Relaxed);
        LARGEST.store(0, Ordering::Relaxed);
        LARGE.store(0, Ordering::Relaxed);
        TRACK.store(true, Ordering::Relaxed);
        let receipt = package::write(
            &project,
            leases.iter().cloned(),
            &mut output,
            limits,
            || false,
        )
        .unwrap();
        result_bytes = receipt.zip.bytes;
        expanded = receipt.zip.uncompressed_bytes;
        drop(receipt);
        TRACK.store(false, Ordering::Relaxed);
        assert_eq!(LIVE.load(Ordering::Relaxed), baseline);
        assert_eq!(LARGE.load(Ordering::Relaxed), 0);
        allocated += TOTAL.load(Ordering::Relaxed);
        largest = largest.max(LARGEST.load(Ordering::Relaxed));
        assert!(largest < 1 << 20);
        output.seek(SeekFrom::Start(0)).unwrap();
        let mut hash = Sha256::new();
        let mut buf = [0; 65536];
        loop {
            let n = output.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
        }
        let hash = format!("{:x}", hash.finalize());
        if let Some(previous) = &expected {
            assert_eq!(&hash, previous);
        } else {
            expected = Some(hash);
        }
        let mut archive = Archive::open(&mut output, limits.zip.zip, || false).unwrap();
        archive.verify_all(|| false).unwrap();
    }
    TRACK.store(true, Ordering::Relaxed);
    let control = std::hint::black_box(leases[1].bytes().to_vec());
    TRACK.store(false, Ordering::Relaxed);
    assert_eq!(LARGE.load(Ordering::Relaxed), 1);
    drop(control);
    drop(output);
    fs::remove_file(path).unwrap();
    println!(
        "{}",
        serde_json::json!({"cycles":5,"sourcePayloadBytes":PAYLOAD_BYTES,"configUtf16Bytes":PAYLOAD_BYTES,"embossUtf16Bytes":PAYLOAD_BYTES,"expandedBytes":expanded,"archiveBytes":result_bytes,"sha256":expected.unwrap(),"allocationBytes":allocated,"largestAllocationBytes":largest,"payloadAllocations":0,"retainedBytes":0,"positiveControlPayloadAllocations":1})
    );
}
