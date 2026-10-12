//! The external slicer's policy against the production browser
//! (`external-slicer-vectors.mjs`): every endpoint, plan and read must be the
//! browser's, byte for byte, and the pinned build the one it pins.
use orcaxr_contracts::project_intent_types as wire;
use orcaxr_printer::slicer;
use serde_json::Value as Json;

fn text(value: &Json) -> &str {
    value.as_str().unwrap()
}
fn cases<'a>(corpus: &'a Json, name: &str) -> &'a [Json] {
    corpus[name].as_array().unwrap()
}

#[test]
fn external_slicer_answers_as_the_browser_does() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/external-slicer-vectors.json"
    ))
    .unwrap();
    for case in cases(&corpus, "endpoints") {
        let request = text(&case["requestJson"]);
        let input = wire::decode_external_slicer_endpoint_request(request).unwrap();
        assert_eq!(
            wire::encode_external_slicer_endpoint(&slicer::endpoint(&input)).unwrap(),
            text(&case["endpointJson"]),
            "endpoint {request}"
        );
        assert_eq!(
            wire::encode_external_slicer_attestation_plan(&slicer::attestation_plan(&input))
                .unwrap(),
            text(&case["attestationPlanJson"]),
            "attestation plan {request}"
        );
        assert_eq!(
            wire::encode_external_slicer_plan(&slicer::submit_plan(&input)).unwrap(),
            text(&case["submitPlanJson"]),
            "submit plan {request}"
        );
    }
    let short = |request: &str| request[..request.len().min(300)].to_owned();
    for case in cases(&corpus, "attestations") {
        let request = text(&case["requestJson"]);
        let reply = wire::decode_external_slicer_reply(request).unwrap();
        assert_eq!(
            wire::encode_external_slicer_attestation(&slicer::attestation(&reply)).unwrap(),
            text(&case["replyJson"]),
            "attestation {}",
            short(request)
        );
    }
    for case in cases(&corpus, "jobPlans") {
        let request = text(&case["requestJson"]);
        let step = wire::decode_external_slicer_job_request(request).unwrap();
        assert_eq!(
            wire::encode_external_slicer_plan(&slicer::job_plan(&step)).unwrap(),
            text(&case["replyJson"]),
            "job plan {request}"
        );
    }
    for case in cases(&corpus, "submissions") {
        let request = text(&case["requestJson"]);
        let read = wire::decode_external_slicer_submit_read(request).unwrap();
        assert_eq!(
            wire::encode_external_slicer_submission(&slicer::submission(&read)).unwrap(),
            text(&case["replyJson"]),
            "submission {}",
            short(request)
        );
    }
    for case in cases(&corpus, "polls") {
        let request = text(&case["requestJson"]);
        let read = wire::decode_external_slicer_poll_read(request).unwrap();
        assert_eq!(
            wire::encode_external_slicer_poll_step(&slicer::poll(&read)).unwrap(),
            text(&case["replyJson"]),
            "poll {}",
            short(request)
        );
    }
    for case in cases(&corpus, "cancels") {
        let request = text(&case["requestJson"]);
        let read = wire::decode_external_slicer_cancel_read(request).unwrap();
        assert_eq!(
            wire::encode_external_slicer_cancel_step(&slicer::cancel(&read)).unwrap(),
            text(&case["replyJson"]),
            "cancel {}",
            short(request)
        );
    }
    for case in cases(&corpus, "artifacts") {
        let request = text(&case["requestJson"]);
        let read = wire::decode_external_slicer_artifact_read(request).unwrap();
        assert_eq!(
            wire::encode_external_slicer_artifact(&slicer::artifact(&read)).unwrap(),
            text(&case["replyJson"]),
            "artifact {}",
            short(request)
        );
    }
    for case in cases(&corpus, "downloads") {
        let request = text(&case["requestJson"]);
        let read = wire::decode_external_slicer_download_read(request).unwrap();
        assert_eq!(
            wire::encode_external_slicer_download_step(&slicer::download(&read)).unwrap(),
            text(&case["replyJson"]),
            "download {}",
            short(request)
        );
    }
    let counts: Vec<usize> = [
        "endpoints",
        "attestations",
        "jobPlans",
        "submissions",
        "polls",
        "cancels",
        "artifacts",
        "downloads",
    ]
    .iter()
    .map(|name| cases(&corpus, name).len())
    .collect();
    assert_eq!(counts, [72, 230, 156, 247, 196, 44, 49, 102]);
}

/// The external route's metadata against the browser's
/// (`slice-sidecar-vectors.json`): every captured endpoint of the corpus,
/// engines of every shape, and each malformed request refused.
#[test]
fn the_route_is_named_as_the_browser_names_it() {
    let corpus: Json = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/slice-sidecar-vectors.json"
    ))
    .unwrap();
    let routes = cases(&corpus, "routes");
    assert_eq!(routes.len(), 66);
    for case in routes {
        let request = text(&case["request"]);
        assert_eq!(
            slicer::route_json(request).unwrap(),
            text(&case["reply"]),
            "route {request}"
        );
    }
    let refusals = cases(&corpus, "routeRefusals");
    assert_eq!(refusals.len(), 8);
    for case in refusals {
        assert_eq!(
            slicer::route_json(text(&case["request"])),
            Err("invalid_request"),
            "{}",
            case["request"]
        );
    }
}

#[test]
fn the_pinned_build_is_the_browsers() {
    let pinned: Json = serde_json::from_str(include_str!(
        "../../../../contracts/pinned-engine-provenance.json"
    ))
    .unwrap();
    let build = slicer::pinned();
    assert_eq!(build.commit, text(&pinned["commit"]));
    assert_eq!(build.cli_version, text(&pinned["cliVersion"]));
    let pairs = |name: &str| -> Vec<(String, String)> {
        pinned[name]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (text(&p["name"]).to_owned(), text(&p["sha256"]).to_owned()))
            .collect()
    };
    assert_eq!(build.artifacts, pairs("artifacts"));
    assert_eq!(build.cli_patches, pairs("cliPatches"));
    assert!(build.cli_patches.len() >= 4);
    assert!(slicer::engine_supports(
        wire::ExternalSlicerEngine::Wasm,
        "wave-overhangs"
    ));
    assert!(!slicer::engine_supports(
        wire::ExternalSlicerEngine::Cli,
        "wave-overhangs"
    ));
}
