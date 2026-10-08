//! The host exchange for the profile catalog. A host streams catalog JSON
//! under explicit budgets, builds it with its collation, and reads the result
//! one generated contract value at a time: diagnostics, presets, profiles and
//! their engine configurations. It can also reconcile selections and produce
//! the catalog target of a live preflight. A refused catalog still answers,
//! with its diagnostics and no profiles, as the browser's catalog does.
use super::{
    catalog::{CatalogError, Diagnostic, DiagnosticCode, ProfileCatalog},
    presets::{Collation, Kind, PresetNode, SelectionRequest, Source, SubstitutionReason},
};
use crate::{
    ingress::json::{JsonInput, JsonInputError, JsonLimits},
    slicing::{preflight, profile::Target, report},
};
use orcaxr_contracts::project_intent_types as wire;
use std::fmt;

/// A bounded catalog upload; nothing is built until every byte arrived.
pub struct CatalogUpload {
    input: JsonInput,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoadError<E> {
    Json(JsonInputError),
    Collation(E),
}
impl<E: fmt::Debug> fmt::Display for LoadError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(JsonInputError::Limit) => f.write_str("input_limit"),
            Self::Json(_) => f.write_str("invalid_catalog"),
            Self::Collation(_) => f.write_str("collation_failed"),
        }
    }
}
impl CatalogUpload {
    pub fn new(bytes: usize, limits: JsonLimits) -> Result<Self, JsonInputError> {
        Ok(Self {
            input: JsonInput::new(bytes, limits)?,
        })
    }
    pub fn append(&mut self, offset: usize, bytes: &[u8]) -> Result<(), JsonInputError> {
        self.input.append(offset, bytes)
    }
    /// Parse the complete upload and build the catalog. Graph refusals are a
    /// loaded state with diagnostics; malformed JSON and collation failures
    /// refuse the load.
    pub fn build<C: Collation>(
        self,
        collation: &mut C,
    ) -> Result<HostCatalog, LoadError<C::Error>> {
        let value = self.input.finish().map_err(LoadError::Json)?;
        Ok(match ProfileCatalog::build(&value, collation) {
            Ok(catalog) => HostCatalog {
                diagnostics: catalog.diagnostics().to_vec(),
                catalog: Some(catalog),
            },
            Err(CatalogError::Invalid(diagnostics)) => HostCatalog {
                catalog: None,
                diagnostics,
            },
            Err(CatalogError::Collation(e)) => return Err(LoadError::Collation(e)),
        })
    }
}

/// A loaded catalog: compiled, or refused with its diagnostics.
pub struct HostCatalog {
    catalog: Option<ProfileCatalog>,
    diagnostics: Vec<Diagnostic>,
}

fn optional_units(units: Option<&[u16]>) -> wire::OptionalText {
    match units {
        Some(u) => wire::OptionalText::Value(u.to_vec()),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
fn optional_str(text: Option<&str>) -> wire::OptionalText {
    optional_units(
        text.map(|t| t.encode_utf16().collect::<Vec<_>>())
            .as_deref(),
    )
}
fn text(units: &wire::OptionalText) -> Option<String> {
    match units {
        wire::OptionalText::Absent(_) => None,
        wire::OptionalText::Value(units) => Some(String::from_utf16_lossy(units)),
    }
}
fn counter(value: Option<usize>) -> wire::OptionalCounter {
    match value {
        Some(n) => wire::OptionalCounter::Value(n as u64),
        None => wire::OptionalCounter::Absent(wire::Empty {}),
    }
}
fn kind(kind: Kind) -> wire::CatalogPresetKind {
    match kind {
        Kind::Machine => wire::CatalogPresetKind::Machine,
        Kind::Process => wire::CatalogPresetKind::Process,
        Kind::Filament => wire::CatalogPresetKind::Filament,
    }
}
fn ids(units: &[u16]) -> String {
    // Preset IDs are percent-encoded ASCII; anything else names no preset.
    String::from_utf16_lossy(units)
}

impl HostCatalog {
    pub fn catalog(&self) -> Option<&ProfileCatalog> {
        self.catalog.as_ref()
    }
    pub fn diagnostic_count(&self) -> usize {
        self.diagnostics.len()
    }
    pub fn diagnostic(&self, index: usize) -> Option<wire::CatalogDiagnostic> {
        let d = self.diagnostics.get(index)?;
        Some(wire::CatalogDiagnostic {
            code: match d.code {
                DiagnosticCode::ProfileCorpusPinnedOverlay => {
                    wire::CatalogDiagnosticCode::ProfileCorpusPinnedOverlay
                }
                DiagnosticCode::InvalidPresetGraph => {
                    wire::CatalogDiagnosticCode::InvalidPresetGraph
                }
                DiagnosticCode::NoCompatibleProcess => {
                    wire::CatalogDiagnosticCode::NoCompatibleProcess
                }
                DiagnosticCode::NoCompatibleFilament => {
                    wire::CatalogDiagnosticCode::NoCompatibleFilament
                }
                DiagnosticCode::UnresolvedCompatibility => {
                    wire::CatalogDiagnosticCode::UnresolvedCompatibility
                }
            },
            error: d.error,
            message: d.message.clone(),
            machine_name: optional_units(d.machine_name.as_deref()),
            process_name: optional_units(d.process_name.as_deref()),
            preset_id: optional_str(d.preset_id.as_deref()),
        })
    }
    pub fn preset_count(&self) -> usize {
        self.catalog
            .as_ref()
            .map_or(0, |c| c.graph().list(None).count())
    }
    /// Every preset in the browser's picker order.
    pub fn preset(&self, index: usize) -> Option<wire::CatalogPreset> {
        let node: &PresetNode = self.catalog.as_ref()?.graph().list(None).nth(index)?;
        Some(wire::CatalogPreset {
            id: node.id.encode_utf16().collect(),
            vendor: node.vendor.clone(),
            kind: kind(node.kind),
            name: node.name.clone(),
            parent_id: optional_str(node.parent_id.as_deref()),
            source: match node.source {
                Source::System => wire::CatalogPresetSource::System,
                Source::User => wire::CatalogPresetSource::User,
                Source::Project => wire::CatalogPresetSource::Project,
                Source::External => wire::CatalogPresetSource::External,
                Source::Default => wire::CatalogPresetSource::Default,
                Source::Unknown => wire::CatalogPresetSource::Unknown,
            },
            is_system: node.is_system,
            is_default: node.is_default,
            is_visible: node.is_visible,
        })
    }
    pub fn profile_count(&self) -> usize {
        self.catalog.as_ref().map_or(0, |c| c.profiles().len())
    }
    pub fn profile(&self, index: usize) -> Option<wire::CatalogProfile> {
        let p = self.catalog.as_ref()?.profiles().get(index)?;
        let id = |text: &str| text.encode_utf16().collect::<Vec<_>>();
        Some(wire::CatalogProfile {
            id: p.id.clone(),
            display_name: p.display_name.clone(),
            machine_name: p.machine_name.clone(),
            process_name: p.process_name.clone(),
            filament_name: p.filament_name.clone(),
            filament_preset_name: p.filament_preset_name.clone(),
            filament_vendor: optional_units(p.filament_vendor.as_deref()),
            machine_preset_id: id(&p.machine_preset_id),
            process_preset_id: id(&p.process_preset_id),
            filament_preset_id: id(&p.filament_preset_id),
        })
    }
    /// A profile's engine wire configuration, keys in UTF-16 order.
    pub fn profile_config(&self, index: usize) -> Option<wire::CatalogConfig> {
        let p = self.catalog.as_ref()?.profiles().get(index)?;
        Some(wire::CatalogConfig {
            entries: p
                .config()
                .into_iter()
                .map(|(key, value)| wire::CatalogConfigEntry { key, value })
                .collect(),
        })
    }
    /// `reconcileSelection`.
    pub fn reconcile(&self, request: &wire::CatalogSelectionRequest) -> wire::CatalogSelection {
        let Some(catalog) = &self.catalog else {
            return wire::CatalogSelection::Unavailable(
                "The profile catalog has not loaded or failed validation."
                    .encode_utf16()
                    .collect(),
            );
        };
        let request = SelectionRequest {
            printer_id: ids(&request.printer_id),
            process_id: text(&request.process_id),
            filament_ids: request.filament_ids.iter().map(text).collect(),
            installed_vendors: match &request.installed_vendors {
                wire::OptionalTextList::Absent(_) => None,
                wire::OptionalTextList::Value(list) => Some(list.clone()),
            },
        };
        match catalog.reconcile(&request) {
            Err(reason) => wire::CatalogSelection::Unavailable(reason.encode_utf16().collect()),
            Ok(s) => {
                let id = |n: &PresetNode| n.id.encode_utf16().collect::<Vec<_>>();
                wire::CatalogSelection::Resolved(wire::ResolvedCatalogSelection {
                    printer: id(&s.printer),
                    process: optional_units(s.process.as_deref().map(id).as_deref()),
                    filaments: s
                        .filaments
                        .iter()
                        .map(|f| optional_units(f.as_deref().map(id).as_deref()))
                        .collect(),
                    substitutions: s
                        .substitutions
                        .iter()
                        .map(|x| wire::CatalogSubstitution {
                            kind: kind(x.kind),
                            slot: counter(x.slot),
                            previous_id: optional_str(x.previous_id.as_deref()),
                            next_id: optional_str(x.next_id.as_deref()),
                            reason: match x.reason {
                                SubstitutionReason::Missing => {
                                    wire::CatalogSubstitutionReason::Missing
                                }
                                SubstitutionReason::Incompatible => {
                                    wire::CatalogSubstitutionReason::Incompatible
                                }
                                SubstitutionReason::NoCompatiblePreset => {
                                    wire::CatalogSubstitutionReason::NoCompatiblePreset
                                }
                            },
                        })
                        .collect(),
                    diagnostics: s
                        .diagnostics
                        .iter()
                        .map(|d| wire::CatalogSelectionDiagnostic {
                            code: match d.code {
                                super::presets::DiagnosticCode::UnresolvedCondition => {
                                    wire::CatalogSelectionDiagnosticCode::UnresolvedCondition
                                }
                                super::presets::DiagnosticCode::NoCompatibleProcess => {
                                    wire::CatalogSelectionDiagnosticCode::NoCompatibleProcess
                                }
                                super::presets::DiagnosticCode::NoCompatibleFilament => {
                                    wire::CatalogSelectionDiagnosticCode::NoCompatibleFilament
                                }
                            },
                            preset_id: optional_str(d.preset_id.as_deref()),
                            slot: counter(d.slot),
                            message: d.message.clone(),
                        })
                        .collect(),
                    complete: s.complete,
                })
            }
        }
    }
    /// `catalogPreflightTarget`, as the catalog target of a `PreflightRequest`.
    pub fn preflight_target(
        &self,
        request: &wire::CatalogTargetRequest,
        max_tools: usize,
    ) -> Result<wire::CatalogPreflightTarget, preflight::Error> {
        let heads: Vec<Option<String>> = request.head_filament_ids.iter().map(text).collect();
        let target = match &self.catalog {
            Some(catalog) => catalog.preflight_target(
                &ids(&request.machine_preset_id),
                &ids(&request.process_preset_id),
                &ids(&request.filament_preset_id),
                &heads,
                request.tool_count,
                max_tools,
            )?,
            // A refused catalog binds nothing; preflight reports every slot.
            None => {
                let length = if request.tool_count.is_nan() || request.tool_count <= 0.0 {
                    0.0
                } else {
                    request.tool_count.floor()
                };
                if length > max_tools as f64 {
                    return Err(preflight::Error::Limits);
                }
                Target {
                    primary: None,
                    filaments: vec![None; length as usize],
                    tool_count: request.tool_count,
                    source: super::super::slicing::profile::Source::Catalog,
                }
            }
        };
        Ok(report::catalog_target(&target))
    }
}
