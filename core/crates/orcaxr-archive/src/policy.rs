//! One host archive policy. A host chooses the generated `ArchiveOptions` budgets
//! from its memory budget and product limits; every detailed ZIP, XML, model,
//! metadata, settings, OPC, envelope and package limit derives from them here,
//! so WASM and JNI hosts enforce the same policy and a new internal limit cannot
//! drift between bindings. Budgets count encoded input and records, not resident
//! memory; hosts still bound concurrent work and size their options to the device.
use crate::{
    ZipLimits,
    archive_layout::ArchiveOptions,
    bbs::{
        facets, foreign,
        model::{self, metadata, settings},
        read_xml::{
            self, Limits as XmlLimits,
            graph::{self, MAX_COMPONENT_GRAPH_DEPTH, MAX_COMPONENT_GRAPH_EXPANSION},
            package as structure, part,
        },
        xml,
    },
    canonical::{self, CompleteLimits, Failure, write as envelope},
    opc, open, package, write,
};
use orcaxr_project::{
    host_layout::MAX_SUPPORTED_DEPTH,
    ingress::{
        AssetInputError, DocumentError, ProjectInputLimits,
        json::{JsonInputError, JsonLimits},
    },
    mesh,
    validation::AdmissionError,
};

/// Package member paths, matching the browser's safe-ZIP policy.
const PATH_BYTES: usize = 512;
/// One XML tag or entity; paint attributes on a single facet are the largest.
const TOKEN_BYTES: usize = 16 << 20;
/// One OPC relationship/content-types tag.
const OPC_TAG_BYTES: usize = 1 << 20;
/// JSON numbers longer than this are not produced by any supported writer.
const NUMBER_BYTES: usize = 1024;
/// The browser's canonical state depth limit.
const STATE_DEPTH: usize = 256;
/// The browser's safe-ZIP expansion ratio.
const COMPRESSION_RATIO: f64 = 1000.0;
/// Bytes per ZIP central-directory record retained while writing.
const INDEX_BYTES_PER_ENTRY: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy(ArchiveOptions);

impl Policy {
    pub fn new(options: ArchiveOptions) -> Self {
        Self(options)
    }
    pub fn options(&self) -> ArchiveOptions {
        self.0
    }
    /// Staged archive input or written output.
    pub fn zip(&self) -> ZipLimits {
        let o = self.0;
        ZipLimits {
            archive_bytes: o.archive_bytes as u64,
            entries: o.entries as u64,
            entry_bytes: o.entry_bytes as u64,
            total_uncompressed_bytes: o.total_bytes as u64,
            compression_ratio: COMPRESSION_RATIO,
            path_bytes: PATH_BYTES as u64,
        }
    }
    fn json(&self) -> JsonLimits {
        let o = self.0;
        JsonLimits {
            max_bytes: o.entry_bytes,
            max_nodes: o.records.saturating_add(o.paint_nodes),
            max_text_units: o.text_units,
            max_number_bytes: NUMBER_BYTES,
            max_depth: MAX_SUPPORTED_DEPTH,
        }
    }
    fn mesh(&self) -> mesh::Limits {
        let o = self.0;
        mesh::Limits {
            asset_bytes: o.asset_bytes,
            vertices: o.vertices,
            indices: o.triangles.saturating_mul(3),
        }
    }
    fn model(&self) -> model::Limits {
        let o = self.0;
        model::Limits {
            mesh: self.mesh(),
            records: o.records,
            text_units: o.text_units,
            paint_entries: o.records,
            paint_nodes: o.paint_nodes,
            vertices: o.vertices,
            triangles: o.triangles,
            output_bytes: o.entry_bytes,
        }
    }
    fn metadata(&self) -> metadata::Limits {
        let o = self.0;
        metadata::Limits {
            records: o.records,
            config_nodes: o.records,
            config_depth: MAX_SUPPORTED_DEPTH,
            text_units: o.text_units,
            drawing_bytes: o.asset_bytes,
            output_bytes: o.entry_bytes,
        }
    }
    fn settings(&self) -> settings::Limits {
        let o = self.0;
        settings::Limits {
            records: o.records,
            config_nodes: o.records,
            config_depth: MAX_SUPPORTED_DEPTH,
            text_units: o.text_units,
            derived_values: o.records,
            output_bytes: o.entry_bytes,
        }
    }
    fn opc(&self) -> opc::Limits {
        let o = self.0;
        opc::Limits {
            part_bytes: o.entry_bytes as u64,
            tag_bytes: OPC_TAG_BYTES.min(o.entry_bytes),
            records: o.records,
            text_units: o.text_units,
            output_bytes: o.entry_bytes,
        }
    }
    /// Completion, preservation and admission shared by both Open paths.
    pub fn complete(&self) -> CompleteLimits {
        let o = self.0;
        CompleteLimits {
            records: o.records,
            text_units: o.text_units,
            assets: o.assets,
            asset_bytes: o.asset_bytes,
            total_asset_bytes: o.total_asset_bytes,
            warnings: o.warnings,
            regenerated_bytes: o.total_bytes,
            model: self.model(),
            metadata: self.metadata(),
            settings: self.settings(),
            opc: self.opc(),
        }
    }
    fn structure(&self) -> structure::Limits {
        let o = self.0;
        // Every vertex, triangle and record is one element; each carries at
        // most a handful of attributes.
        let elements = o
            .vertices
            .saturating_add(o.triangles)
            .saturating_add(o.records);
        structure::Limits {
            xml: XmlLimits {
                input_bytes: o.entry_bytes,
                text_units: o.entry_bytes,
                token_bytes: TOKEN_BYTES.min(o.entry_bytes),
                elements,
                attributes: elements.saturating_mul(8),
                depth: MAX_SUPPORTED_DEPTH,
            },
            part: part::Limits {
                objects: o.records,
                vertices: o.vertices,
                triangles: o.triangles,
                components: o.records,
                build_items: o.records,
                materials: o.records,
                title_text_units: o.text_units,
                facet_encoded_bytes: o.total_bytes,
                facet_refinement_nodes: o.paint_nodes,
                facet_materialization_units: o.paint_nodes,
                extension_attribute_count: o.records,
                extension_attribute_text_units: o.text_units,
            },
            graph: graph::Limits {
                parts: o.entries,
                objects: o.records,
                build_items: o.records,
                references: o.records,
                depth: MAX_COMPONENT_GRAPH_DEPTH,
                expansion: MAX_COMPONENT_GRAPH_EXPANSION,
            },
            model_parts: o.entries,
            model_bytes: o.total_bytes as u64,
        }
    }
    /// Archive Open over both the canonical and foreign paths.
    pub fn open(&self) -> open::Limits {
        let o = self.0;
        let complete = self.complete();
        open::Limits {
            canonical: ProjectInputLimits {
                document: self.json(),
                max_assets: o.assets,
                max_asset_bytes: o.asset_bytes,
                max_total_asset_bytes: o.total_asset_bytes,
            },
            complete,
            foreign: foreign::Limits {
                model: self.structure(),
                metadata_bytes: o.entry_bytes,
                project_json: self.json(),
                materialization_units: o.paint_nodes as u64,
                complete,
            },
        }
    }
    /// Complete package Save.
    pub fn package(&self) -> package::Limits {
        let o = self.0;
        package::Limits {
            records: o.records,
            text_units: o.text_units,
            asset_bytes: o.asset_bytes,
            total_asset_bytes: o.total_asset_bytes,
            warnings: o.warnings,
            model: self.model(),
            metadata: self.metadata(),
            settings: self.settings(),
            opc: self.opc(),
            envelope: envelope::Limits {
                assets: o.assets,
                path_bytes: PATH_BYTES,
                state_nodes: o.records.saturating_add(o.paint_nodes),
                state_depth: STATE_DEPTH,
                output_bytes: o.entry_bytes,
            },
            zip: write::Limits {
                zip: self.zip(),
                index_bytes: o.entries.saturating_mul(INDEX_BYTES_PER_ENTRY),
            },
        }
    }
}

// Budget refusals nest through every decoder. Allocation failures count: they
// are fallible reservations sized by host budgets. Fixed format limits (graph
// depth/expansion) are invalid input, not host budgets.
fn zip_limit(e: &crate::Error) -> bool {
    matches!(e, crate::Error::ResourceLimit)
}
fn opc_limit(e: &opc::Error) -> bool {
    match e {
        opc::Error::Limits | opc::Error::ResourceLimit => true,
        opc::Error::Archive(e) => zip_limit(e),
        _ => false,
    }
}
fn facets_limit(e: &facets::Error) -> bool {
    matches!(
        e,
        facets::Error::Limits | facets::Error::NodeLimit | facets::Error::OutputLimit
    )
}
fn xml_limit(e: &xml::Error) -> bool {
    matches!(e, xml::Error::OutputLimit | xml::Error::TextLimit)
}
fn mesh_limit(e: &mesh::Error) -> bool {
    matches!(e, mesh::Error::Limits | mesh::Error::Allocation)
}
fn model_limit(e: &model::Error) -> bool {
    match e {
        model::Error::ResourceLimit => true,
        model::Error::Mesh(e) => mesh_limit(e),
        model::Error::Xml(e) => xml_limit(e),
        model::Error::Paint(e) => facets_limit(e),
        _ => false,
    }
}
fn settings_limit(e: &settings::Error) -> bool {
    matches!(
        e,
        settings::Error::ResourceLimit | settings::Error::OutputLimit
    )
}
fn structure_limit(e: &structure::Error) -> bool {
    match e {
        structure::Error::Limits | structure::Error::Allocation => true,
        structure::Error::Archive(e) => zip_limit(e),
        structure::Error::Xml(e) => matches!(e, read_xml::Failure::ResourceLimit),
        structure::Error::Part(part::Error::Limits | part::Error::Allocation) => true,
        structure::Error::Part(part::Error::Facet(e)) => facets_limit(e),
        structure::Error::Graph(graph::Error::Limits | graph::Error::Allocation) => true,
        _ => false,
    }
}
fn failure_limit(e: &Failure) -> bool {
    match e {
        Failure::ResourceLimit | Failure::Json(JsonInputError::Limit) => true,
        Failure::Archive(e) => zip_limit(e),
        Failure::Opc(e) => opc_limit(e),
        Failure::Bbs(e) => model_limit(e),
        Failure::Settings(e) => settings_limit(e),
        Failure::Foreign(
            foreign::Failure::ResourceLimit | foreign::Failure::Json(JsonInputError::Limit),
        ) => true,
        Failure::Foreign(foreign::Failure::Model(e)) => structure_limit(e),
        _ => false,
    }
}

/// Bounded, redacted host code for a refused staged archive: no member path,
/// name or content escapes. Every binding reports the same codes.
pub fn archive_code(e: crate::Error) -> &'static str {
    match e {
        crate::Error::ResourceLimit => "resource_limit",
        crate::Error::Cancelled => "cancelled",
        _ => "invalid_archive",
    }
}
/// Bounded, redacted host code for a refused Open: `resource_limit` when a host
/// budget refused it, so hosts can tell "too large" from "invalid".
pub fn open_code<E>(e: &canonical::Error<E>) -> &'static str {
    use canonical::Error;
    match e {
        Error::Failure(Failure::Cancelled) => "cancelled",
        Error::Failure(Failure::Archive(crate::Error::Cancelled)) => "cancelled",
        Error::Failure(e) if failure_limit(e) => "resource_limit",
        Error::Document(
            DocumentError::AssetBudget | DocumentError::Json(JsonInputError::Limit),
        )
        | Error::Asset(AssetInputError::Allocation) => "resource_limit",
        Error::Failure(Failure::Archive(_)) => "invalid_archive",
        Error::Document(DocumentError::Admission(AdmissionError::Timestamp(_))) => {
            "timestamp_service"
        }
        _ => "invalid_document",
    }
}
/// Bounded, redacted host code for a refused Save. Projects the browser also
/// refuses to save (for example unresolvable plate origins) are unsavable.
pub fn save_code(e: package::Error) -> &'static str {
    match e {
        package::Error::Cancelled | package::Error::Zip(crate::Error::Cancelled) => "cancelled",
        package::Error::ResourceLimit
        | package::Error::Envelope(envelope::Error::ResourceLimit) => "resource_limit",
        package::Error::Zip(e) if zip_limit(&e) => "resource_limit",
        package::Error::Opc(e) if opc_limit(&e) => "resource_limit",
        package::Error::Model(e) if model_limit(&e) => "resource_limit",
        package::Error::Settings(e) if settings_limit(&e) => "resource_limit",
        _ => "unsavable_project",
    }
}
