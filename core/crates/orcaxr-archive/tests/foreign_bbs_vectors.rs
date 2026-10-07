use orcaxr_archive::{
    Archive, ZipLimits,
    bbs::read_xml::{Limits, Scanner, graph, package, part},
};
use orcaxr_project::ingress::json::JsonLimits;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Cursor};

fn corpus() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/foreign-bbs-vectors.json"
    ))
    .unwrap()
}
fn unhex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn xml_limits(input_bytes: usize) -> Limits {
    Limits {
        input_bytes,
        text_units: input_bytes,
        token_bytes: 64 << 10,
        elements: 100_000,
        attributes: 500_000,
        depth: 128,
    }
}
fn part_limits() -> part::Limits {
    part::Limits {
        objects: 100,
        vertices: 1000,
        triangles: 1000,
        components: 1000,
        build_items: 1000,
        materials: 100,
        title_text_units: 4096,
        facet_encoded_bytes: 1 << 20,
        facet_refinement_nodes: 1_000_000,
        facet_materialization_units: 1_000_000,
        extension_attribute_count: 100_000,
        extension_attribute_text_units: 8 << 20,
    }
}
fn package_limits() -> package::Limits {
    package::Limits {
        xml: xml_limits(1 << 20),
        part: part_limits(),
        graph: graph::Limits::default(),
        model_parts: 32,
        model_bytes: 8 << 20,
        project_settings_bytes: 1 << 20,
        project_settings_json: JsonLimits {
            max_bytes: 1 << 20,
            max_nodes: 100_000,
            max_text_units: 1 << 20,
            max_number_bytes: 128,
            max_depth: 64,
        },
    }
}
fn canonical_json(value: orcaxr_contracts::canonical::Value) -> serde_json::Value {
    let mut encoded = Vec::new();
    value.write_canonical(&mut encoded).unwrap();
    serde_json::from_slice(&encoded).unwrap()
}

#[test]
fn browser_authored_foreign_archives_stream_through_zip_and_xml_admission() {
    let corpus = corpus();
    assert_eq!(corpus["format"], 1);
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let bytes = unhex(case["archiveBytesHex"].as_str().unwrap());
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            case["archiveSha256"].as_str().unwrap(),
            "{name} ZIP identity"
        );
        let mut archive = Archive::open(Cursor::new(bytes), ZipLimits::default(), || false)
            .unwrap_or_else(|error| panic!("{name} ZIP: {error:?}"));
        archive.verify_all(|| false).unwrap();
        let model_indices = archive
            .entries()
            .iter()
            .enumerate()
            .filter(|(_, entry)| !entry.is_directory() && entry.path().ends_with(".model"))
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        assert!(!model_indices.is_empty(), "{name} has a model part");
        let mut parsed_parts = BTreeMap::new();
        let mut projection_failed = false;
        for index in model_indices {
            let path = archive.entries()[index].path().to_owned();
            let allow_external_paths = path == "3D/3dmodel.model";
            let mut scanner = Scanner::new(
                xml_limits(archive.entries()[index].bytes() as usize),
                || false,
                |_| Ok::<_, ()>(()),
            );
            let streamed = archive.read_entry(index, &mut scanner, || false);
            let admitted = scanner.finish();
            let expected_syntax = name != "refuse-dtd";
            assert_eq!(
                streamed.is_ok() && admitted.is_ok(),
                expected_syntax,
                "{name} XML admission: stream={streamed:?} xml={admitted:?}"
            );
            if expected_syntax && streamed.is_ok() && admitted.is_ok() {
                let mut builder = part::Builder::new(part_limits(), allow_external_paths).unwrap();
                let mut visitor_failure = None;
                let mut scanner = Scanner::new(
                    xml_limits(archive.entries()[index].bytes() as usize),
                    || false,
                    |event| match builder.event(event) {
                        Ok(()) => Ok(()),
                        Err(error) => {
                            visitor_failure = Some(error);
                            Err(error)
                        }
                    },
                );
                let streamed = archive.read_entry(index, &mut scanner, || false);
                let scanned = scanner.finish();
                let should_parse = !matches!(
                    name,
                    "refuse-unknown-unit"
                        | "refuse-duplicate-object-id"
                        | "refuse-invalid-facet-channel-state"
                );
                if !should_parse {
                    assert!(
                        streamed.is_err() && scanned.is_err() && visitor_failure.is_some(),
                        "{name} should fail as a model projection: {scanned:?}"
                    );
                    projection_failed = true;
                    continue;
                }
                assert!(
                    streamed.is_ok() && scanned.is_ok(),
                    "{name} projection stream: {scanned:?}"
                );
                let part = builder
                    .finish()
                    .unwrap_or_else(|error| panic!("{name}: {error:?}"));
                parsed_parts.insert(path.clone(), part.clone());
                {
                    match name {
                        "basic-millimeter" => {
                            assert_eq!(part.title, "Fixture & 🐟");
                            assert_eq!(part.objects.len(), 1);
                            assert_eq!(part.objects[0].name, "Basic triangle");
                            assert_eq!(part.build.len(), 1);
                            assert_eq!(
                                part.build[0].transform[3..12]
                                    .iter()
                                    .step_by(4)
                                    .copied()
                                    .collect::<Vec<_>>(),
                                [10.0, 20.0, 30.0]
                            );
                        }
                        "centimeter-unit-and-material" => {
                            assert_eq!(part.unit, part::Unit::Centimeter);
                            assert_eq!(part.objects[0].material_index, Some(0));
                            assert_eq!(
                                part.objects[0].mesh.as_ref().unwrap().positions[0],
                                [12.5, 25.0, 37.5]
                            );
                        }
                        "painted-facets-and-refinement" => {
                            let mesh = part.objects[0].mesh.as_ref().unwrap();
                            let color = canonical_json(mesh.annotations.color.to_value());
                            assert_eq!(
                                color["assignments"],
                                json!([{
                                    "value":"import:3mf:paint-slot-1",
                                    "triangles":[0]
                                }])
                            );
                            assert_eq!(
                                color["encoding"]["splits"][0]["node"]["children"][0]["state"]["value"],
                                "import:3mf:paint-slot-2"
                            );
                            assert_eq!(
                                color["encoding"]["splits"][0]["node"]["children"][1]["state"]["value"],
                                "import:3mf:paint-slot-1"
                            );
                            assert_eq!(
                                canonical_json(mesh.annotations.support.to_value())["assignments"]
                                    [0]["value"],
                                "enforce"
                            );
                            assert_eq!(
                                canonical_json(mesh.annotations.seam.to_value())["assignments"][0]
                                    ["value"],
                                "avoid"
                            );
                            assert_eq!(
                                canonical_json(mesh.annotations.fuzzy_skin.to_value())["assignments"]
                                    [0]["value"],
                                true
                            );
                            assert_eq!(mesh.annotations.checked_materialization_units(), Some(11));
                            assert_eq!(part.facet_encoded_bytes, 7);
                            assert_eq!(part.facet_refinement_nodes, 7);
                            assert_eq!(part.facet_materialization_units, 11);
                        }
                        "internal-component-expansion" => {
                            assert_eq!(part.objects.len(), 2);
                            assert_eq!(part.objects[1].components.len(), 2);
                            assert_eq!(part.objects[1].components[0].transform[3], 2.0);
                            assert_eq!(part.objects[1].components[1].transform[7], 3.0);
                        }
                        "extension-attributes-preserved" => {
                            let state: Value = serde_json::from_str(
                                case["expected"]["stateJson"].as_str().unwrap(),
                            )
                            .unwrap();
                            let volume = &state["plates"][0]["objects"][0]["volumes"][0];
                            assert_eq!(
                                volume["extensionData"]["https://orcaxr.martinez.fyi/3mf/project/1/core-object-attributes"],
                                json!([{
                                    "namespace":"urn:orcaxr:foreign-fixture",
                                    "name":"object",
                                    "value":"leaf-value"
                                }])
                            );
                            assert_eq!(
                                volume["extensionData"]["https://orcaxr.martinez.fyi/3mf/project/1/core-component-attributes"],
                                json!([{
                                    "namespace":"urn:orcaxr:foreign-fixture",
                                    "name":"component",
                                    "value":"edge-value"
                                }])
                            );
                            assert_eq!(
                                volume["extensionData"]["https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes"],
                                json!([{
                                    "triangle":0,
                                    "attributes":[{
                                        "namespace":"urn:orcaxr:foreign-fixture",
                                        "name":"facet",
                                        "value":"facet-value"
                                    }]
                                }])
                            );
                            assert_eq!(
                                state["plates"][0]["objects"][0]["instances"][0]["extensionData"]["https://orcaxr.martinez.fyi/3mf/project/1/core-build-attributes"],
                                json!([{
                                    "namespace":"urn:orcaxr:foreign-fixture",
                                    "name":"build",
                                    "value":"build-value"
                                }])
                            );

                            let leaf = part.objects.iter().find(|object| object.id == 1).unwrap();
                            assert_eq!(
                                leaf.extension_attributes,
                                [part::ExtensionAttribute {
                                    namespace: "urn:orcaxr:foreign-fixture".into(),
                                    name: "object".into(),
                                    value: "leaf-value".into(),
                                }]
                            );
                            assert_eq!(
                                leaf.mesh.as_ref().unwrap().facet_extension_attributes,
                                [part::FacetExtensionAttributes {
                                    triangle: 0,
                                    attributes: vec![part::ExtensionAttribute {
                                        namespace: "urn:orcaxr:foreign-fixture".into(),
                                        name: "facet".into(),
                                        value: "facet-value".into(),
                                    }],
                                }]
                            );
                            assert_eq!(
                                part.objects[1].components[0].extension_attributes,
                                [part::ExtensionAttribute {
                                    namespace: "urn:orcaxr:foreign-fixture".into(),
                                    name: "component".into(),
                                    value: "edge-value".into(),
                                }]
                            );
                            assert_eq!(
                                part.build[0].extension_attributes,
                                [part::ExtensionAttribute {
                                    namespace: "urn:orcaxr:foreign-fixture".into(),
                                    name: "build".into(),
                                    value: "build-value".into(),
                                }]
                            );
                            assert_eq!(part.extension_attribute_count, 4);
                        }
                        "external-production-part-alias-prefix" if allow_external_paths => {
                            let assembly =
                                part.objects.iter().find(|object| object.id == 10).unwrap();
                            assert_eq!(
                                assembly.components[0].model_path.as_deref(),
                                Some("/3D/Objects/Leaf.model")
                            );
                            assert_eq!(
                                assembly.components[0].transform[3..12]
                                    .iter()
                                    .step_by(4)
                                    .copied()
                                    .collect::<Vec<_>>(),
                                [4.0, 5.0, 6.0]
                            );
                        }
                        "empty-project" => {
                            assert!(part.objects.is_empty() && part.build.is_empty())
                        }
                        _ => {}
                    }
                }
            }
        }
        // Semantic refusals such as an unsupported model unit remain valid XML;
        // this corpus keeps syntax admission separate from model projection.
        assert_eq!(
            case["expected"]["accepted"].as_bool().unwrap(),
            !name.starts_with("refuse-")
        );
        let expected_import = case["expected"]["accepted"].as_bool().unwrap();
        let structural = package::read_model_structure(&mut archive, package_limits(), || false);
        assert_eq!(
            structural.is_ok(),
            expected_import,
            "{name} archive structural admission: {structural:?}"
        );
        if name == "painted-facets-and-refinement" {
            let staged = structural.as_ref().unwrap();
            let staged_part = &staged.parts["3D/3dmodel.model"];
            assert_eq!(staged_part.facet_refinement_nodes, 7);
            let mut low_nodes = package_limits();
            low_nodes.part.facet_refinement_nodes = 6;
            assert!(matches!(
                package::read_model_structure(&mut archive, low_nodes, || false),
                Err(package::Error::Part(part::Error::Facet(
                    orcaxr_archive::bbs::facets::Error::NodeLimit
                )))
            ));
            let mut low_encoded_bytes = package_limits();
            low_encoded_bytes.part.facet_encoded_bytes = 6;
            assert!(matches!(
                package::read_model_structure(&mut archive, low_encoded_bytes, || false),
                Err(package::Error::Part(part::Error::Limits))
            ));
            let mut low_materialization = package_limits();
            low_materialization.part.facet_materialization_units = 10;
            assert!(matches!(
                package::read_model_structure(&mut archive, low_materialization, || false),
                Err(package::Error::Part(part::Error::Limits))
            ));
        }
        if name == "basic-millimeter" {
            let settings = structural
                .as_ref()
                .unwrap()
                .project_settings
                .as_ref()
                .unwrap();
            assert_eq!(
                canonical_json(settings.config.clone())["filament_colour"],
                json!(["#FF0000"])
            );
            let mut small = package_limits();
            small.project_settings_bytes = 10;
            assert!(matches!(
                package::read_model_structure(&mut archive, small, || false),
                Err(package::Error::Limits)
            ));
        }
        if name == "legacy-project-settings-xml" {
            let settings = structural
                .as_ref()
                .unwrap()
                .project_settings
                .as_ref()
                .unwrap();
            let config = canonical_json(settings.config.clone());
            assert_eq!(config["filament_colour"], "#00FF00");
            assert_eq!(config["legacy_enabled"], true);
        }
        if name == "extension-attributes-preserved" {
            let staged = structural.as_ref().unwrap();
            let root = &staged.parts["3D/3dmodel.model"];
            assert_eq!(root.extension_attribute_count, 4);
            let mut low_count = package_limits();
            low_count.part.extension_attribute_count = 3;
            assert!(matches!(
                package::read_model_structure(&mut archive, low_count, || false),
                Err(package::Error::Part(part::Error::Limits))
            ));
            let mut low_text = package_limits();
            low_text.part.extension_attribute_text_units = root.extension_attribute_text_units - 1;
            assert!(matches!(
                package::read_model_structure(&mut archive, low_text, || false),
                Err(package::Error::Part(part::Error::Limits))
            ));
        }
        if name == "external-production-part-alias-prefix" {
            let mut small = package_limits();
            small.part.vertices = 5;
            assert!(matches!(
                package::read_model_structure(&mut archive, small, || false),
                Err(package::Error::Part(part::Error::Limits))
            ));
            let mut small = package_limits();
            small.part.title_text_units = 20;
            assert!(matches!(
                package::read_model_structure(&mut archive, small, || false),
                Err(package::Error::Part(part::Error::Limits))
            ));
        }
        if name == "basic-millimeter" {
            assert!(matches!(
                package::read_model_structure(&mut archive, package_limits(), || true),
                Err(package::Error::Cancelled)
            ));
        }
        if name == "refuse-dtd" || projection_failed {
            assert!(!expected_import);
        } else {
            let resolved =
                graph::resolve("3D/3dmodel.model", &parsed_parts, graph::Limits::default());
            assert_eq!(
                resolved.is_ok(),
                expected_import,
                "{name} component-graph admission: {resolved:?}"
            );
            if name == "extension-attributes-preserved" {
                let resolved = resolved.unwrap();
                let (root, leaves) = resolved
                    .roots
                    .iter()
                    .find(|(root, _)| root.object_id == 10)
                    .unwrap();
                assert_eq!(root.model_path, "3D/3dmodel.model");
                assert_eq!(leaves.len(), 1);
                assert_eq!(
                    leaves[0].component_edge,
                    Some(graph::ComponentEdgeRef {
                        source: graph::ObjectRef {
                            model_path: "3D/3dmodel.model".into(),
                            object_id: 10,
                        },
                        component_index: 0,
                    })
                );
            }
        }
    }
}
