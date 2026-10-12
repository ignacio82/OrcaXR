//! A plate's picture rendered from a captured project: the browser-authored
//! placement scene (a sphere with a modifier placed twice, a second part, a
//! cube) opened as a session, asked for the U1's two sizes, drawn from each
//! one-plate slice capture. The pictures show exactly what prints, framed,
//! on transparency, and are the same bytes every time (the JNI checks hold
//! the host to these digests).
use orcaxr_archive::{
    image::Rgba,
    thumbnail::{self, Scene},
};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    assets::*,
    export::ExportCapture,
    history::*,
    model::*,
    selection::*,
    session::*,
    slicing::thumbnails::{Format, Request},
    validation::*,
};
use sha2::{Digest, Sha256};
use std::io::Read;

/// The placement scene's first plate at 48 × 48 and 300 × 300 (PNG) and 144 × 144 (JPEG).
const DIGESTS: [&str; 3] = [
    "a379bc23c783bb20284d5491a07510c360439ab2b3e9cf4c2bf5ee1a7e6003e3",
    "715756a8fde33b8b72921ff09128b467251126ac8c52d0ad44064173fb4fadd1",
    "bf5e3788f2d66e9875cb17f33b20660a52f1c066f38021be98044111f563b4d0",
];

fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}

/// The placement scene as a session, its configuration asking for `thumbnails`.
fn session(thumbnails: Option<&str>) -> ProjectSession<impl TimestampPolicy<Error = ()>> {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/placement-vectors.json"
    ))
    .unwrap();
    let mut state =
        ProjectState::from_value(parse(fixture["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    if let Some(value) = thumbnails {
        let Value::Object(mut config) = state.config.value().clone() else {
            unreachable!()
        };
        config.insert(
            "thumbnails".encode_utf16().collect(),
            Value::String(value.encode_utf16().collect()),
        );
        state.config = ConfigMap::from_value(Value::Object(config)).unwrap();
    }
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    for asset in fixture["assets"].as_array().unwrap() {
        let bytes: Vec<u8> = asset["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect();
        assets
            .put(
                &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                &bytes,
            )
            .unwrap();
    }
    ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions::default(),
        [1, 2, 3, 4],
    )
    .unwrap()
}

/// The pixels of one of this core's PNGs (unfiltered RGBA rows).
fn pixels(png: &[u8]) -> Rgba {
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    assert_eq!(&png[24..29], &[8, 6, 0, 0, 0]);
    let length = u32::from_be_bytes(png[33..37].try_into().unwrap()) as usize;
    assert_eq!(&png[37..41], b"IDAT");
    let mut raw = Vec::new();
    flate2::read::ZlibDecoder::new(&png[41..41 + length])
        .read_to_end(&mut raw)
        .unwrap();
    let stride = width as usize * 4;
    let mut out = Vec::new();
    for row in raw.chunks_exact(stride + 1) {
        assert_eq!(row[0], 0);
        out.extend_from_slice(&row[1..]);
    }
    assert_eq!(out.len(), stride * height as usize);
    Rgba {
        width,
        height,
        pixels: out,
    }
}

#[test]
fn a_plate_is_drawn_from_its_capture_as_the_printer_asks() {
    let session = session(Some("48x48/PNG, 300x300/PNG, 144x144/JPG, 5000x5000"));
    let capture = ExportCapture::new(&session, &session.capture_guard().unwrap()).unwrap();
    let state = capture.project().state().clone();
    let plate = capture.plate(&state.plates[0].id, &mut utc()).unwrap();
    let rendered = thumbnail::capture(&plate).unwrap();
    assert_eq!(
        rendered.list.problems.len(),
        1,
        "the size no engine accepts is stated"
    );
    let sizes: Vec<(u32, u32, Format)> = rendered
        .pictures
        .iter()
        .map(|(r, _)| (r.width, r.height, r.format))
        .collect();
    assert_eq!(
        sizes,
        [
            (48, 48, Format::Png),
            (300, 300, Format::Png),
            (144, 144, Format::Jpg)
        ]
    );
    if let Ok(folder) = std::env::var("ORCAXR_THUMBNAIL_DUMP") {
        for (request, picture) in &rendered.pictures {
            let name = format!(
                "{folder}/{}x{}.{}",
                request.width,
                request.height,
                request.format.as_str()
            );
            std::fs::write(name, &picture.image).unwrap();
        }
    }
    for (request, picture) in &rendered.pictures {
        if request.format == Format::Jpg {
            assert_eq!(&picture.image[..3], &[0xff, 0xd8, 0xff]);
            continue;
        }
        let image = pixels(&picture.image);
        let opaque = image.pixels.chunks_exact(4).filter(|p| p[3] == 255).count() as u64;
        assert_eq!(opaque, picture.coverage);
        let total = u64::from(request.width * request.height);
        // Three small parts far apart: each shows, framed with slack, never at the edge.
        assert!(
            picture.coverage * 100 > total && picture.coverage * 10 < total,
            "{}",
            picture.coverage
        );
        let w = request.width as usize;
        for (x, y) in [(0, 0), (w - 1, 0), (0, w - 1), (w - 1, w - 1)] {
            assert_eq!(
                image.pixels[(y * w + x) * 4 + 3],
                0,
                "corner {x},{y} is transparent"
            );
        }
    }
    // The same capture draws the same bytes; a second capture of the same state too.
    let again =
        thumbnail::capture(&capture.plate(&state.plates[0].id, &mut utc()).unwrap()).unwrap();
    assert_eq!(rendered.pictures, again.pictures);
    let digests: Vec<String> = rendered
        .pictures
        .iter()
        .map(|(_, picture)| format!("{:x}", Sha256::digest(&picture.image)))
        .collect();
    // `ProjectOutputChecks` renders the same plate over JNI and must write these bytes.
    assert_eq!(digests, DIGESTS);
    let json = thumbnail::capture_json(&plate).unwrap();
    assert!(json.starts_with(r#"{"problems":[{"entry":"5000x5000","reason":"out-of-range"}],"thumbnails":[{"block":"; THUMBNAIL_BLOCK_START\n\n;\n; thumbnail begin 48x48 "#));
}

#[test]
fn only_what_prints_is_drawn() {
    let session = session(None);
    let capture = ExportCapture::new(&session, &session.capture_guard().unwrap()).unwrap();
    let state = capture.project().state().clone();
    let plate = &state.plates[0];
    let request = Request {
        width: 64,
        height: 64,
        format: Format::Png,
    };
    let lookup = |id: &orcaxr_project::ids::AssetId| capture.asset_by_id(id);
    let all = Scene::of(&state, &plate.id, lookup)
        .unwrap()
        .unwrap()
        .rasterize(64, 64);
    // Without the configuration asking, a capture draws nothing.
    assert!(thumbnail::capture(&capture).unwrap().pictures.is_empty());
    // Every instance unprintable: nothing to draw, so no picture rather than a blank one.
    let mut unprintable = state.clone();
    let mut edited = (*unprintable.plates[0]).clone();
    edited.objects = edited
        .objects
        .iter()
        .map(|object| {
            let mut object = (**object).clone();
            object.instances = object
                .instances
                .iter()
                .map(|instance| {
                    let mut instance = (**instance).clone();
                    instance.printable = false;
                    std::sync::Arc::new(instance)
                })
                .collect();
            std::sync::Arc::new(object)
        })
        .collect();
    unprintable.plates = vec![std::sync::Arc::new(edited)].into();
    assert!(
        Scene::of(&unprintable, &plate.id, lookup)
            .unwrap()
            .is_none()
    );
    // Without its modifier, the object draws the same picture: modifiers print nothing.
    let mut bare = state.clone();
    let mut edited = (*bare.plates[0]).clone();
    edited.objects = edited
        .objects
        .iter()
        .map(|object| {
            let mut object = (**object).clone();
            object.volumes = object
                .volumes
                .iter()
                .filter(|volume| volume.role == VolumeRole::Model)
                .cloned()
                .collect();
            std::sync::Arc::new(object)
        })
        .collect();
    bare.plates = vec![std::sync::Arc::new(edited)].into();
    let without = Scene::of(&bare, &plate.id, lookup)
        .unwrap()
        .unwrap()
        .rasterize(64, 64);
    assert_eq!(all, without);
    let _ = request;
}
