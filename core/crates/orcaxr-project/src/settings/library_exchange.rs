//! The host exchange for the preset library. A host creates a library from a
//! catalog upload and the text it stored, then submits generated contract
//! operations: the browser's install, create, update and delete, plus
//! `setInstalled` and `uninstall`. Bundles cross as bytes; issues are read one
//! at a time after each outcome. The library composes the catalog the profile
//! catalog exchange serves, as the browser's catalog composer does.
//!
//! Every call consults the host's collation and `Date.parse` validity. A
//! request that stamps provenance carries its own `now`; the host's clock is
//! never read, so a replay is deterministic.
use super::{
    catalog_exchange::{CatalogUpload, HostCatalog, LoadError},
    library::{
        Draft, DraftUpdate, Installed, Issue, IssueCode, Library, LibraryHost, Lineage, Outcome,
        ProvenanceSource, coerce_override_value, format_override_value, unreadable_state,
    },
    presets::{BuildError, Collation, JsonObject, Kind},
};
use crate::ingress::json::{JsonInput, JsonInputError, JsonLimits};
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};
use std::{cmp::Ordering, fmt};

/// Why an exchange call was refused. Refusals change nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExchangeError<E> {
    /// The catalog or bundle upload failed its budgets or framing.
    Json(JsonInputError),
    /// The system catalog is not a valid preset graph.
    InvalidCatalog,
    /// A request's JSON text is malformed or not an object.
    InvalidRequest,
    /// The reply would exceed the host's byte budget.
    OutputLimit,
    /// A host policy failed.
    Host(E),
}
impl<E: fmt::Debug> fmt::Display for ExchangeError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(JsonInputError::Limit) => f.write_str("input_limit"),
            Self::Json(_) | Self::InvalidCatalog => f.write_str("invalid_catalog"),
            Self::InvalidRequest => f.write_str("invalid_request"),
            Self::OutputLimit => f.write_str("output_limit"),
            Self::Host(_) => f.write_str("host_policy_failed"),
        }
    }
}
fn built<E>(error: BuildError<E>) -> ExchangeError<E> {
    match error {
        BuildError::Collation(e) => ExchangeError::Host(e),
        BuildError::Graph(_) | BuildError::MalformedUri => ExchangeError::InvalidCatalog,
    }
}

/// The host's collation and timestamps, with the request's `now` as the clock.
struct Stamped<'a, H> {
    host: &'a mut H,
    now: &'a [u16],
}
impl<H: LibraryHost> LibraryHost for Stamped<'_, H> {
    type Error = H::Error;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, H::Error> {
        self.host.compare(left, right)
    }
    fn now(&mut self) -> Vec<u16> {
        self.now.to_vec()
    }
    fn timestamp(&mut self, text: &[u16]) -> Result<bool, H::Error> {
        self.host.timestamp(text)
    }
}
/// The library's collation, for building the composed profile catalog.
struct ByHost<'a, H>(&'a mut H);
impl<H: LibraryHost> Collation for ByHost<'_, H> {
    type Error = H::Error;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, H::Error> {
        self.0.compare(left, right)
    }
}

/// `JSON.parse` of host bytes. `Ok(None)` is text that is not JSON (or holds
/// a number that overflows); only a budget breach refuses.
fn parse_bytes(bytes: &[u8], limits: JsonLimits) -> Result<Option<Value>, JsonInputError> {
    let mut input = JsonInput::new(bytes.len(), limits)?;
    for (i, chunk) in bytes
        .chunks(crate::ingress::json::MAX_CHUNK_BYTES)
        .enumerate()
    {
        match input.append(i * crate::ingress::json::MAX_CHUNK_BYTES, chunk) {
            Ok(()) => {}
            Err(JsonInputError::Limit) => return Err(JsonInputError::Limit),
            Err(_) => return Ok(None),
        }
    }
    match input.finish() {
        Ok(value) => Ok(Some(value)),
        Err(JsonInputError::Limit) => Err(JsonInputError::Limit),
        Err(_) => Ok(None),
    }
}
/// A request's JSON object.
fn json_object<E>(units: &[u16]) -> Result<JsonObject, ExchangeError<E>> {
    let source = String::from_utf16(units).map_err(|_| ExchangeError::InvalidRequest)?;
    match orcaxr_contracts::canonical::parse(&source) {
        Ok(Value::Object(fields)) => Ok(fields),
        _ => Err(ExchangeError::InvalidRequest),
    }
}
fn optional_json(units: &wire::OptionalJsonText) -> Option<&[u16]> {
    match units {
        wire::OptionalJsonText::Absent(_) => None,
        wire::OptionalJsonText::Value(text) => Some(text),
    }
}
fn canonical_units(value: &Value) -> Vec<u16> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .expect("writing to memory cannot fail");
    String::from_utf8(bytes)
        .expect("canonical JSON is UTF-8")
        .encode_utf16()
        .collect()
}
fn optional_text(units: &wire::OptionalText) -> Option<Vec<u16>> {
    match units {
        wire::OptionalText::Absent(_) => None,
        wire::OptionalText::Value(text) => Some(text.clone()),
    }
}
fn optional_units(units: Option<&[u16]>) -> wire::OptionalText {
    match units {
        Some(u) => wire::OptionalText::Value(u.to_vec()),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
fn kind(kind: &wire::CatalogPresetKind) -> Kind {
    match kind {
        wire::CatalogPresetKind::Machine => Kind::Machine,
        wire::CatalogPresetKind::Process => Kind::Process,
        wire::CatalogPresetKind::Filament => Kind::Filament,
    }
}
fn wire_kind(kind: Kind) -> wire::CatalogPresetKind {
    match kind {
        Kind::Machine => wire::CatalogPresetKind::Machine,
        Kind::Process => wire::CatalogPresetKind::Process,
        Kind::Filament => wire::CatalogPresetKind::Filament,
    }
}
fn source(source: &wire::OptionalProvenanceSource) -> Option<ProvenanceSource> {
    match source {
        wire::OptionalProvenanceSource::Absent(_) => None,
        wire::OptionalProvenanceSource::Value(wire::LibraryProvenanceSource::UserDerived) => {
            Some(ProvenanceSource::UserDerived)
        }
        wire::OptionalProvenanceSource::Value(wire::LibraryProvenanceSource::Imported) => {
            Some(ProvenanceSource::Imported)
        }
    }
}
fn lineage(l: &Lineage) -> wire::LibraryLineage {
    wire::LibraryLineage {
        vendor: l.vendor.clone(),
        kind: wire_kind(l.kind),
        name: l.name.clone(),
    }
}
fn code(code: IssueCode) -> wire::LibraryIssueCode {
    use wire::LibraryIssueCode as W;
    match code {
        IssueCode::InvalidState => W::InvalidState,
        IssueCode::InvalidBundle => W::InvalidBundle,
        IssueCode::UnsupportedSchema => W::UnsupportedSchema,
        IssueCode::EngineMismatch => W::EngineMismatch,
        IssueCode::UnknownPrinterModel => W::UnknownPrinterModel,
        IssueCode::UnknownPrinterVariant => W::UnknownPrinterVariant,
        IssueCode::UnknownBasePreset => W::UnknownBasePreset,
        IssueCode::BaseNotInstantiable => W::BaseNotInstantiable,
        IssueCode::DuplicatePresetName => W::DuplicatePresetName,
        IssueCode::ReservedKey => W::ReservedKey,
        IssueCode::UnknownPresetKey => W::UnknownPresetKey,
        IssueCode::InvalidValue => W::InvalidValue,
        IssueCode::InvalidProvenance => W::InvalidProvenance,
        IssueCode::InvalidName => W::InvalidName,
        IssueCode::UnknownPreset => W::UnknownPreset,
        IssueCode::DependentPreset => W::DependentPreset,
        IssueCode::GraphRejected => W::GraphRejected,
        IssueCode::NothingInstalled => W::NothingInstalled,
    }
}
/// UTF-8 for a host, within its byte budget. Library text is well formed:
/// `JSON.stringify` escapes lone surrogates.
fn utf8<E>(units: &[u16], max_bytes: usize) -> Result<Vec<u8>, ExchangeError<E>> {
    let bytes = String::from_utf16(units)
        .expect("stable JSON escapes lone surrogates")
        .into_bytes();
    if bytes.len() > max_bytes {
        return Err(ExchangeError::OutputLimit);
    }
    Ok(bytes)
}

/// A library a host owns, and the issues of its latest outcome.
pub struct HostLibrary {
    library: Library,
    issues: Vec<Issue>,
}

impl HostLibrary {
    /// `PresetLibraryStore`: the system catalog, and the text the host stored
    /// (`None` when nothing was). Stored text that is not JSON, or exceeds
    /// `limits`, loads as `unreadable_state`, so a bad write never locks the
    /// operator out. The load's issues are the first outcome's.
    pub fn create<H: LibraryHost>(
        catalog: CatalogUpload,
        stored: Option<&[u8]>,
        limits: JsonLimits,
        host: &mut H,
    ) -> Result<Self, ExchangeError<H::Error>> {
        let catalog = catalog.finish().map_err(ExchangeError::Json)?;
        let state = stored.map(|bytes| {
            parse_bytes(bytes, limits)
                .ok()
                .flatten()
                .unwrap_or_else(unreadable_state)
        });
        let (library, issues) = Library::create(&catalog, state.as_ref(), host).map_err(built)?;
        Ok(Self { library, issues })
    }
    pub fn library(&self) -> &Library {
        &self.library
    }

    /// `applyPresetLibraryOperation` for every mutating operation.
    pub fn apply<H: LibraryHost>(
        &mut self,
        operation: &wire::LibraryOperation,
        host: &mut H,
    ) -> Result<wire::LibraryOutcome, ExchangeError<H::Error>> {
        use wire::LibraryOperation as Op;
        let outcome = match operation {
            Op::Install(s) => self
                .library
                .install_printer(&s.vendor, &s.model, &s.variants, host),
            Op::SetInstalled(s) => {
                let selections: Vec<Installed> = s
                    .selections
                    .iter()
                    .map(|s| Installed {
                        vendor: s.vendor.clone(),
                        model: s.model.clone(),
                        variants: s.variants.clone(),
                    })
                    .collect();
                self.library.set_installed(&selections, host)
            }
            Op::Uninstall(m) => self.library.uninstall_printer(&m.vendor, &m.model, host),
            Op::Create(c) => {
                let d = &c.draft;
                let draft = Draft {
                    vendor: optional_text(&d.vendor),
                    kind: kind(&d.kind),
                    name: d.name.clone(),
                    inherits: d.inherits.clone(),
                    overrides: optional_json(&d.overrides_json)
                        .map(json_object)
                        .transpose()?,
                    license: optional_text(&d.license),
                    version: optional_text(&d.version),
                    note: optional_text(&d.note),
                    source: source(&d.source),
                };
                let mut stamped = Stamped { host, now: &c.now };
                self.library.create_custom_preset(&draft, &mut stamped)
            }
            Op::Update(u) => {
                let d = &u.draft;
                let update = DraftUpdate {
                    vendor: optional_text(&d.vendor),
                    kind: match &d.kind {
                        wire::OptionalPresetKind::Absent(_) => None,
                        wire::OptionalPresetKind::Value(k) => Some(kind(k)),
                    },
                    name: optional_text(&d.name),
                    inherits: optional_text(&d.inherits),
                    overrides: optional_json(&d.overrides_json)
                        .map(json_object)
                        .transpose()?,
                    license: optional_text(&d.license),
                    version: optional_text(&d.version),
                    note: optional_text(&d.note),
                    source: source(&d.source),
                };
                let mut stamped = Stamped { host, now: &u.now };
                self.library.update_custom_preset(
                    &u.vendor,
                    kind(&u.kind),
                    &u.name,
                    &update,
                    &mut stamped,
                )
            }
            Op::Delete(p) => {
                self.library
                    .delete_custom_preset(&p.vendor, kind(&p.kind), &p.name, host)
            }
        }
        .map_err(ExchangeError::Host)?;
        Ok(self.record(outcome))
    }
    /// `importBundle`: bytes that are not JSON are an `invalid-bundle`
    /// outcome; only a budget breach refuses.
    pub fn import<H: LibraryHost>(
        &mut self,
        bundle: &[u8],
        limits: JsonLimits,
        host: &mut H,
    ) -> Result<wire::LibraryOutcome, ExchangeError<H::Error>> {
        let parsed = parse_bytes(bundle, limits).map_err(ExchangeError::Json)?;
        let outcome = self
            .library
            .import_bundle(parsed.as_ref(), host)
            .map_err(ExchangeError::Host)?;
        Ok(self.record(outcome))
    }
    fn record(&mut self, outcome: Outcome) -> wire::LibraryOutcome {
        let reply = wire::LibraryOutcome {
            ok: outcome.ok,
            issue_count: outcome.issues.len() as u64,
        };
        self.issues = outcome.issues;
        reply
    }
    /// The latest outcome's issues: creation, an operation, an import, or a
    /// catalog update plan or application.
    pub fn issue_count(&self) -> usize {
        self.issues.len()
    }
    pub fn issue(&self, index: usize) -> Option<wire::LibraryIssue> {
        let i = self.issues.get(index)?;
        Some(wire::LibraryIssue {
            code: code(i.code),
            error: i.error,
            path: i.path.clone(),
            message: i.message.clone(),
        })
    }

    /// `exportBundle` as UTF-8, stamped with the host's `exported_at`.
    pub fn export<E>(
        &self,
        exported_at: &[u16],
        max_bytes: usize,
    ) -> Result<Vec<u8>, ExchangeError<E>> {
        utf8(&self.library.export_bundle(exported_at), max_bytes)
    }
    /// The text to store (`PresetLibraryStore.save`), as UTF-8.
    pub fn state<E>(&self, max_bytes: usize) -> Result<Vec<u8>, ExchangeError<E>> {
        utf8(&self.library.state_json(), max_bytes)
    }

    pub fn view(&self) -> wire::LibraryView {
        wire::LibraryView {
            configured: self.library.is_configured(),
            fingerprint: self.library.catalog_fingerprint().encode_utf16().collect(),
            vendors: self.library.installed_vendors(),
            custom_count: self.library.state().custom_presets.len() as u64,
        }
    }
    /// One custom preset, in the library's order.
    pub fn custom_preset(&self, index: usize) -> Option<wire::LibraryCustomPreset> {
        let p = self.library.state().custom_presets.get(index)?;
        let v = &p.provenance;
        Some(wire::LibraryCustomPreset {
            vendor: p.vendor.clone(),
            kind: wire_kind(p.kind),
            name: p.name.clone(),
            inherits: p.inherits.clone(),
            overrides_json: canonical_units(&Value::Object(p.overrides.clone())),
            provenance: wire::LibraryProvenance {
                source: match v.source {
                    ProvenanceSource::UserDerived => wire::LibraryProvenanceSource::UserDerived,
                    ProvenanceSource::Imported => wire::LibraryProvenanceSource::Imported,
                },
                license: v.license.clone(),
                version: v.version.clone(),
                derived_from: lineage(&v.derived_from),
                created_at: v.created_at.clone(),
                updated_at: v.updated_at.clone(),
                note: optional_units(v.note.as_deref()),
            },
        })
    }
    pub fn inventory<H: LibraryHost>(
        &self,
        host: &mut H,
    ) -> Result<wire::LibraryInventory, ExchangeError<H::Error>> {
        let inventory = self.library.inventory(host).map_err(ExchangeError::Host)?;
        Ok(wire::LibraryInventory {
            vendors: inventory.vendors,
            models: inventory
                .models
                .into_iter()
                .map(|m| wire::LibraryModel {
                    vendor: m.vendor,
                    model: m.model,
                    installed: m.installed,
                    variants: m
                        .variants
                        .into_iter()
                        .map(|v| wire::LibraryVariant {
                            variant: v.variant,
                            preset_name: v.preset_name,
                            preset_id: v.preset_id.encode_utf16().collect(),
                            nozzle_diameter: match v.nozzle_diameter {
                                Some(n) => wire::OptionalFinite::Value(n),
                                None => wire::OptionalFinite::Absent(wire::Empty {}),
                            },
                            installed: v.installed,
                        })
                        .collect(),
                })
                .collect(),
        })
    }
    /// `basePresetsFor`.
    pub fn bases(&self, request: &wire::LibraryBaseRequest) -> wire::LibraryBases {
        // Preset IDs are percent-encoded ASCII; anything else names no preset.
        let id = |t: &wire::OptionalText| optional_text(t).map(|u| String::from_utf16_lossy(&u));
        let (printer, process) = (id(&request.printer_id), id(&request.process_id));
        wire::LibraryBases {
            ids: self
                .library
                .base_presets_for(kind(&request.kind), printer.as_deref(), process.as_deref())
                .into_iter()
                .map(|n| n.id.encode_utf16().collect())
                .collect(),
        }
    }
    /// The composed catalog as the profile catalog the rest of the app reads.
    pub fn catalog<H: LibraryHost>(
        &self,
        host: &mut H,
    ) -> Result<HostCatalog, ExchangeError<H::Error>> {
        HostCatalog::from_value(&self.library.compose_catalog(), &mut ByHost(host)).map_err(|e| {
            match e {
                LoadError::Collation(e) => ExchangeError::Host(e),
                LoadError::Json(e) => ExchangeError::Json(e),
            }
        })
    }

    /// `planCatalogUpdate` against an uploaded catalog. The plan's issues
    /// become the latest outcome's.
    pub fn plan_update<H: LibraryHost>(
        &mut self,
        next: CatalogUpload,
        host: &mut H,
    ) -> Result<wire::LibraryUpdatePlan, ExchangeError<H::Error>> {
        let next = next.finish().map_err(ExchangeError::Json)?;
        let plan = self
            .library
            .plan_catalog_update(&next, host)
            .map_err(ExchangeError::Host)?;
        let lineages = |list: &[Lineage]| list.iter().map(lineage).collect();
        let reply = wire::LibraryUpdatePlan {
            previous_fingerprint: plan.previous_fingerprint.encode_utf16().collect(),
            next_fingerprint: plan.next_fingerprint.encode_utf16().collect(),
            changed: plan.changed,
            added_models: lineages(&plan.added_models),
            removed_models: lineages(&plan.removed_models),
            removed_variants: lineages(&plan.removed_variants),
            orphaned_custom_presets: lineages(&plan.orphaned_custom_presets),
            issue_count: plan.issues.len() as u64,
            applicable: plan.applicable,
        };
        self.issues = plan.issues;
        Ok(reply)
    }
    /// `applyCatalogUpdate`: on success this library moves onto the catalog.
    pub fn apply_update<H: LibraryHost>(
        &mut self,
        next: CatalogUpload,
        host: &mut H,
    ) -> Result<wire::LibraryOutcome, ExchangeError<H::Error>> {
        let next = next.finish().map_err(ExchangeError::Json)?;
        let (outcome, updated) = self
            .library
            .apply_catalog_update(&next, host)
            .map_err(ExchangeError::Host)?;
        if let Some(updated) = updated {
            self.library = updated;
        }
        Ok(self.record(outcome))
    }
}

/// `coerceOverrideValue`, as canonical JSON.
pub fn coerce<E>(
    request: &wire::LibraryCoerceRequest,
) -> Result<wire::LibraryCoercedValue, ExchangeError<E>> {
    let inherited = optional_json(&request.inherited_json)
        .map(|units| {
            let source = String::from_utf16(units).map_err(|_| ExchangeError::InvalidRequest)?;
            orcaxr_contracts::canonical::parse(&source).map_err(|_| ExchangeError::InvalidRequest)
        })
        .transpose()?;
    Ok(wire::LibraryCoercedValue {
        json: canonical_units(&coerce_override_value(inherited.as_ref(), &request.text)),
    })
}
/// `formatOverrideValue`.
pub fn format<E>(
    request: &wire::LibraryFormatRequest,
) -> Result<wire::LibraryFormattedValue, ExchangeError<E>> {
    let value = optional_json(&request.value_json)
        .map(|units| {
            let source = String::from_utf16(units).map_err(|_| ExchangeError::InvalidRequest)?;
            orcaxr_contracts::canonical::parse(&source).map_err(|_| ExchangeError::InvalidRequest)
        })
        .transpose()?;
    Ok(wire::LibraryFormattedValue {
        text: format_override_value(value.as_ref()),
    })
}
