//! What binds a slice's output, against the browser (`slice-sidecar-vectors.json`):
//! every plate's profile snapshot over the project model corpus and its
//! profile-identity variants, every output binding the browser accepts or
//! refuses — with its words — byte for byte, and each malformed request
//! refused; then the sidecar's own rules: its parts must name one output.
use orcaxr_project::slicing::sidecar::{
    Engine, INVALID_REQUEST, Route, binding_json, native_route_json, profiles_json, sidecar_json,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

type Exchange = fn(&str) -> Result<String, &'static str>;
/// One way to break a sidecar request.
type Change = Box<dyn Fn(&mut Value)>;

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/slice-sidecar-vectors.json"
    ))
    .unwrap()
}

#[test]
fn reference_sources_are_current() {
    for source in corpus()["sources"].as_array().unwrap() {
        let path = format!("../../../{}", source["path"].as_str().unwrap());
        let bytes =
            std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            source["sha256"].as_str().unwrap(),
            "{}",
            source["path"]
        );
    }
}

#[test]
fn profiles_and_bindings_match_the_browser() {
    let corpus = corpus();
    let sections: [(&str, Exchange, usize); 2] = [
        ("profiles", profiles_json, 57),
        ("bindings", binding_json, 73),
    ];
    for (section, answer, count) in sections {
        let cases = corpus[section].as_array().unwrap();
        assert_eq!(cases.len(), count, "{section}");
        for case in cases {
            let request = case["request"].as_str().unwrap();
            assert_eq!(
                answer(request).unwrap(),
                case["reply"].as_str().unwrap(),
                "{section} {}",
                case["name"]
            );
        }
    }
    let refusals: [(&str, Exchange, usize); 2] = [
        ("profileRefusals", profiles_json, 8),
        ("bindingRefusals", binding_json, 5),
    ];
    for (section, answer, count) in refusals {
        let cases = corpus[section].as_array().unwrap();
        assert_eq!(cases.len(), count, "{section}");
        for case in cases {
            assert_eq!(
                answer(case["request"].as_str().unwrap()),
                Err(INVALID_REQUEST),
                "{section} {}",
                case["request"]
            );
        }
    }
}

const COMMIT: &str = "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626";

fn sha(text: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(text.as_bytes()))
}

fn engine() -> Engine {
    Engine {
        commit: COMMIT.encode_utf16().collect(),
        artifact_hash: sha("engine").encode_utf16().collect(),
    }
}

/// A plate's profiles, from the corpus.
fn profiles() -> Value {
    let corpus = corpus();
    let case = corpus["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["reply"].as_str().unwrap().contains("\"tool\""))
        .unwrap();
    serde_json::from_str(case["reply"].as_str().unwrap()).unwrap()
}

fn native() -> Value {
    let route = Route::android_native(engine()).unwrap().to_value();
    let mut text = Vec::new();
    route.write_canonical(&mut text).unwrap();
    serde_json::from_slice(&text).unwrap()
}

fn request() -> Value {
    let profiles = profiles();
    json!({
        "binding": {
            "jobId": "slice-0123456789abcdef",
            "plateId": "plate-1",
            "sourceRevision": 3,
            "sourceHash": "fnv1a64:0123456789abcdef",
            "sourceAssetHash": "fnv1a64:fedcba9876543210",
            "projectInputHash": sha("archive"),
            "gcodeOutputHash": sha("gcode"),
            "effectiveConfigHash": profiles["effectiveConfigHash"],
            "engineCommit": COMMIT,
            "engineArtifactHash": sha("engine"),
        },
        "gcodeBytes": 1234,
        "profiles": profiles,
        "route": native(),
        "summary": {"empty": false, "perTool": [{"toolIndex": 0, "lengthMm": 12.5, "material": "PLA"}], "layerCount": 20},
        "warnings": ["one"],
    })
}

fn answer(request: &Value) -> Value {
    serde_json::from_str(&sidecar_json(&request.to_string()).unwrap()).unwrap()
}

#[test]
fn this_devices_route_is_named_by_its_engine() {
    let route = native();
    assert_eq!(
        route,
        json!({
            "engine": {"artifactHash": sha("engine"), "commit": COMMIT},
            "id": format!("slicer-client:android-native:{}", sha("engine")),
            "kind": "android-native",
            "protocolVersion": 1,
        })
    );
    assert_eq!(
        serde_json::from_str::<Value>(
            &native_route_json(&json!({"engine": route["engine"]}).to_string()).unwrap()
        )
        .unwrap(),
        route
    );
    for (commit, hash) in [
        ("", sha("engine")),
        (&COMMIT[1..], sha("engine")),
        (COMMIT, sha("engine")[1..].to_string()),
        (COMMIT, sha("engine").to_uppercase()),
    ] {
        let request = json!({"engine": {"commit": commit, "artifactHash": hash}});
        assert!(
            native_route_json(&request.to_string())
                .unwrap()
                .contains("\"error\""),
            "{request}"
        );
    }
    for request in ["{}", r#"{"engine":{"commit":"a"}}"#, r#"{"engine":[]}"#] {
        assert_eq!(native_route_json(request), Err(INVALID_REQUEST));
    }
}

#[test]
fn a_sidecar_binds_one_output() {
    let request = request();
    let document = answer(&request);
    assert_eq!(document["schema"], "orcaxr.slice-output");
    assert_eq!(document["version"], 1);
    assert_eq!(document["binding"], request["binding"]);
    assert_eq!(document["profiles"], request["profiles"]);
    assert_eq!(document["route"], request["route"]);
    assert_eq!(
        document["statistics"],
        json!({"route": "android-native", "gcodeBytes": 1234, "summary": request["summary"]})
    );
    assert_eq!(document["warnings"], json!(["one"]));

    // An external server's route binds as this device's does.
    let mut external = request.clone();
    external["route"] = json!({
        "engine": {"artifactHash": sha("engine"), "commit": COMMIT},
        "id": "slicer-client:external-server:http://127.0.0.1:3000",
        "kind": "external-server",
        "protocolVersion": 1,
    });
    assert_eq!(answer(&external)["statistics"]["route"], "external-server");

    let refusals: Vec<(&str, Change)> = vec![
        (
            "binding.gcodeOutputHash must be a SHA-256 identity",
            Box::new(|r| r["binding"]["gcodeOutputHash"] = json!("sha256:x")),
        ),
        (
            "binding fields are missing or unknown",
            Box::new(|r| r["binding"]["extra"] = json!(1)),
        ),
        (
            "binding is missing",
            Box::new(|r| r["binding"] = json!(null)),
        ),
        (
            "profiles must be a slice profile snapshot",
            Box::new(|r| r["profiles"]["references"] = json!([])),
        ),
        (
            "profiles must be a slice profile snapshot",
            Box::new(|r| r["profiles"]["references"][0]["tool"] = json!(0)),
        ),
        (
            "profiles must be a slice profile snapshot",
            Box::new(|r| r["profiles"]["effectiveConfigHash"] = json!("x")),
        ),
        (
            "route must be the metadata of an Android slice route",
            Box::new(|r| r["route"]["kind"] = json!("browser-wasm")),
        ),
        (
            "route must be the metadata of an Android slice route",
            Box::new(|r| r["route"]["id"] = json!("slicer-client:android-native:x")),
        ),
        (
            "route must be the metadata of an Android slice route",
            Box::new(|r| r["route"]["protocolVersion"] = json!(2)),
        ),
        (
            "gcodeBytes must be a non-negative safe integer",
            Box::new(|r| r["gcodeBytes"] = json!(-1)),
        ),
        (
            "gcodeBytes must be a non-negative safe integer",
            Box::new(|r| r["gcodeBytes"] = json!(1.5)),
        ),
        (
            "summary must be the totals the engine wrote into the artifact, or null",
            Box::new(|r| r["summary"]["perTool"][0]["toolIndex"] = json!(1)),
        ),
        (
            "summary must be the totals the engine wrote into the artifact, or null",
            Box::new(|r| r["summary"]["layers"] = json!(1)),
        ),
        (
            "summary must be the totals the engine wrote into the artifact, or null",
            Box::new(|r| r["summary"] = json!({"perTool": []})),
        ),
        (
            "warnings must be a list of texts",
            Box::new(|r| r["warnings"] = json!([1])),
        ),
        (
            "binding.effectiveConfigHash is not the effective configuration the plate was sliced with",
            Box::new(|r| r["binding"]["effectiveConfigHash"] = json!(sha("other"))),
        ),
        (
            "binding's engine is not the route's engine",
            Box::new(|r| r["binding"]["engineArtifactHash"] = json!(sha("other"))),
        ),
        (
            "binding's engine is not the route's engine",
            Box::new(|r| r["binding"]["engineCommit"] = json!("0".repeat(40))),
        ),
    ];
    for (message, change) in refusals {
        let mut broken = request.clone();
        change(&mut broken);
        assert_eq!(answer(&broken), json!({"error": message}), "{message}");
    }
    // A summary past the metadata bound is stated as none.
    let mut unstated = request.clone();
    unstated["summary"] = json!(null);
    assert_eq!(answer(&unstated)["statistics"]["summary"], json!(null));
    let mut missing = request.clone();
    missing.as_object_mut().unwrap().remove("warnings");
    assert_eq!(sidecar_json(&missing.to_string()), Err(INVALID_REQUEST));
}
