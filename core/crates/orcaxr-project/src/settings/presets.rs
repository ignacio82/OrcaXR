//! Headless preset inheritance, compatibility and selection
//! (`web/src/settings/presets/PresetGraph.ts`), pinned to Snapmaker OrcaSlicer
//! v2.3.4 `Preset.cpp`/`PresetBundle.cpp` semantics. The browser orders presets
//! with `localeCompare(…, 'en')`; a host `Collation` supplies that order once,
//! at build time, and every later choice uses the resulting ranks.
use crate::js_math::convert::{
    MalformedUri, encode_uri_component, json_stringify, trim_utf16, utf16_number,
};
use orcaxr_contracts::canonical::Value;
use std::{
    cell::RefCell,
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    fmt,
    sync::Arc,
};

/// Text ordering for preset names, vendors and IDs.
pub trait Collation {
    type Error;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, Self::Error>;
}
impl<E, F: FnMut(&[u16], &[u16]) -> Result<Ordering, E>> Collation for F {
    type Error = E;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, E> {
        self(left, right)
    }
}

/// ICU's `en` (CLDR root) collation for printable ASCII and controls, exact:
/// controls other than tab and line breaks are ignorable; whitespace,
/// punctuation and symbols precede digits, then letters with case ignored;
/// at a primary tie, lower case precedes upper case position by position. Any
/// other code unit is refused: a host with non-ASCII presets supplies its own
/// platform collator instead of a guessed order.
#[derive(Debug, Clone, Copy, Default)]
pub struct AsciiRootCollation;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NonAsciiText;
impl fmt::Display for NonAsciiText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("non_ascii_collation")
    }
}
impl std::error::Error for NonAsciiText {}

const ROOT_ORDER: &[u8] = b"\t\n\x0b\x0c\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789";
fn primary(unit: u16) -> Option<u16> {
    let byte = unit as u8;
    if let Some(i) = ROOT_ORDER.iter().position(|b| *b == byte) {
        return Some(i as u16);
    }
    byte.is_ascii_alphabetic()
        .then(|| ROOT_ORDER.len() as u16 + u16::from(byte.to_ascii_lowercase() - b'a'))
}
impl Collation for AsciiRootCollation {
    type Error = NonAsciiText;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, NonAsciiText> {
        if left.iter().chain(right).any(|u| *u >= 0x80) {
            return Err(NonAsciiText);
        }
        let weights = |text: &[u16]| -> Vec<(u16, u8)> {
            text.iter()
                .filter_map(|u| primary(*u).map(|p| (p, u8::from((*u as u8).is_ascii_uppercase()))))
                .collect()
        };
        let (a, b) = (weights(left), weights(right));
        let primaries = a.iter().map(|w| w.0).cmp(b.iter().map(|w| w.0));
        Ok(primaries.then_with(|| a.iter().map(|w| w.1).cmp(b.iter().map(|w| w.1))))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Machine,
    Process,
    Filament,
}
impl Kind {
    pub const ALL: [Kind; 3] = [Kind::Machine, Kind::Process, Kind::Filament];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Machine => "machine",
            Self::Process => "process",
            Self::Filament => "filament",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    System,
    User,
    Project,
    External,
    Default,
    Unknown,
}
impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Project => "project",
            Self::External => "external",
            Self::Default => "default",
            Self::Unknown => "unknown",
        }
    }
}

pub type JsonObject = BTreeMap<Vec<u16>, Value>;

/// `PresetNode`.
#[derive(Debug, Clone, PartialEq)]
pub struct PresetNode {
    pub id: String,
    pub vendor: Vec<u16>,
    pub kind: Kind,
    pub name: Vec<u16>,
    pub parent_id: Option<String>,
    pub source: Source,
    pub is_system: bool,
    pub is_default: bool,
    pub is_visible: bool,
    /// The exact caller payload.
    pub raw: Arc<JsonObject>,
    /// Shallow config-key overlay of every ancestor followed by this payload.
    pub effective: Arc<JsonObject>,
}
/// `PresetAuxiliaryPayload`: an unnamed non-preset entry.
#[derive(Debug, Clone, PartialEq)]
pub struct AuxiliaryPayload {
    pub id: String,
    pub vendor: Vec<u16>,
    pub kind: Kind,
    pub raw: Arc<JsonObject>,
}

names!(IssueCode {
    InvalidCatalog => "invalid-catalog",
    InvalidGroup => "invalid-group",
    InvalidProfile => "invalid-profile",
    DuplicateProfile => "duplicate-profile",
    MissingParent => "missing-parent",
    AmbiguousParent => "ambiguous-parent",
    InheritanceCycle => "inheritance-cycle",
    InheritanceDepth => "inheritance-depth",
});
/// `PresetGraphIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub code: IssueCode,
    pub path: Vec<u16>,
    pub message: Vec<u16>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BuildError<E> {
    /// `PresetGraphError`: every validation issue, in discovery order.
    Graph(Vec<Issue>),
    /// `encodeURIComponent` refused a lone surrogate in a vendor or name.
    MalformedUri,
    Collation(E),
}
impl<E> From<MalformedUri> for BuildError<E> {
    fn from(_: MalformedUri) -> Self {
        Self::MalformedUri
    }
}

const MAX_INHERITANCE_DEPTH: usize = 64;
const MAX_MATCH_QUALITY: f64 = 9_007_199_254_740_991.0;

/// UTF-16 assembly for messages and paths.
#[derive(Default)]
struct Units(Vec<u16>);
impl Units {
    fn s(mut self, text: &str) -> Self {
        self.0.extend(text.encode_utf16());
        self
    }
    fn u(mut self, units: &[u16]) -> Self {
        self.0.extend_from_slice(units);
        self
    }
    /// `JSON.stringify(text)`.
    fn q(self, units: &[u16]) -> Self {
        let quoted = json_stringify(&Value::String(units.to_vec()));
        self.u(&quoted)
    }
}
fn s(text: &str) -> Units {
    Units::default().s(text)
}
fn u(units: &[u16]) -> Units {
    Units::default().u(units)
}
fn key(name: &str) -> Vec<u16> {
    name.encode_utf16().collect()
}
fn get<'a>(object: &'a JsonObject, name: &str) -> Option<&'a Value> {
    object.get(&key(name))
}
/// `optionalString`: a string with non-blank content, trimmed.
fn optional_string(value: Option<&Value>) -> Option<Vec<u16>> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = trim_utf16(text);
            (!trimmed.is_empty()).then(|| trimmed.to_vec())
        }
        _ => None,
    }
}
/// `stringList`: the string entries of an array.
fn string_list(value: Option<&Value>) -> Vec<&[u16]> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| match v {
                Value::String(t) => Some(t.as_slice()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}
fn first_string(value: Option<&Value>) -> Option<&[u16]> {
    match value {
        Some(Value::String(t)) => Some(t),
        other => string_list(other).first().copied(),
    }
}
/// `numericScalar`.
fn numeric_scalar(value: Option<&Value>) -> Option<f64> {
    let scalar = match value {
        Some(Value::Array(items)) => items.first(),
        other => other,
    };
    match scalar {
        Some(Value::Number(n)) if n.is_finite() => Some(*n),
        Some(Value::String(t)) if !trim_utf16(t).is_empty() => {
            Some(utf16_number(t)).filter(|n| n.is_finite())
        }
        _ => None,
    }
}

/// `presetId(vendor, kind, name)`.
pub fn preset_id(vendor: &[u16], kind: Kind, name: &[u16]) -> Result<String, MalformedUri> {
    Ok(format!(
        "preset:{}:{}:{}",
        encode_uri_component(vendor)?,
        kind.as_str(),
        encode_uri_component(name)?
    ))
}

/// A vendor and its machine, process and filament arrays.
type Group<'a> = (&'a Vec<u16>, [Option<&'a Vec<Value>>; 3]);

struct Record {
    id: String,
    vendor: Vec<u16>,
    kind: Kind,
    name: Vec<u16>,
    path: Vec<u16>,
    raw: Arc<JsonObject>,
    parent: Option<usize>,
}

/// The validated preset graph.
#[derive(Debug, Clone, PartialEq)]
pub struct PresetGraph {
    /// In browser order: kind, name, vendor, then ID under the collation.
    ordered: Vec<Arc<PresetNode>>,
    by_id: BTreeMap<String, usize>,
    auxiliary: Vec<AuxiliaryPayload>,
}

impl PresetGraph {
    /// `PresetGraph.build`.
    pub fn build<C: Collation>(
        input: &Value,
        collation: &mut C,
    ) -> Result<Self, BuildError<C::Error>> {
        let mut issues = Vec::new();
        let Value::Object(catalog) = input else {
            return Err(BuildError::Graph(vec![Issue {
                code: IssueCode::InvalidCatalog,
                path: key("$"),
                message: key("Preset catalog must be an object"),
            }]));
        };
        let mut groups: Vec<Group<'_>> = Vec::new();
        for (vendor, value) in catalog {
            if trim_utf16(vendor).is_empty() {
                issues.push(issue(
                    IssueCode::InvalidGroup,
                    key("$"),
                    "Preset vendor names must not be empty",
                ));
                continue;
            }
            let Value::Object(group) = value else {
                issues.push(issue(
                    IssueCode::InvalidGroup,
                    s("$.").u(vendor).0,
                    "Preset vendor group must be an object",
                ));
                continue;
            };
            for name in group.keys() {
                if !Kind::ALL.iter().any(|k| key(k.as_str()) == *name) {
                    issues.push(Issue {
                        code: IssueCode::InvalidGroup,
                        path: s("$.").u(vendor).s(".").u(name).0,
                        message: s("Unknown preset category ").q(name).0,
                    });
                }
            }
            let mut entries = [None, None, None];
            for (slot, kind) in Kind::ALL.iter().enumerate() {
                match get(group, kind.as_str()) {
                    None => {}
                    Some(Value::Array(items)) => entries[slot] = Some(items),
                    Some(_) => issues.push(issue(
                        IssueCode::InvalidGroup,
                        s("$.").u(vendor).s(".").s(kind.as_str()).0,
                        "Preset category must be an array",
                    )),
                }
            }
            groups.push((vendor, entries));
        }
        sort_by(&mut groups, |a, b| collation.compare(a.0, b.0)).map_err(BuildError::Collation)?;

        let mut records: Vec<Record> = Vec::new();
        let mut auxiliary = Vec::new();
        let mut by_scoped: BTreeMap<(Vec<u16>, Kind, Vec<u16>), usize> = BTreeMap::new();
        let mut by_kind_name: BTreeMap<(Kind, Vec<u16>), Vec<usize>> = BTreeMap::new();
        for (vendor, entries) in &groups {
            for (slot, kind) in Kind::ALL.iter().enumerate() {
                let Some(items) = entries[slot] else { continue };
                for (index, entry) in items.iter().enumerate() {
                    let path = s("$.")
                        .u(vendor)
                        .s(".")
                        .s(kind.as_str())
                        .s(&format!("[{index}]"))
                        .0;
                    let Value::Object(raw) = entry else {
                        issues.push(issue(
                            IssueCode::InvalidProfile,
                            path,
                            "Preset payload must be an object",
                        ));
                        continue;
                    };
                    validate_fields(raw, *kind, &path, &mut issues);
                    let Some(name) = optional_string(get(raw, "name")) else {
                        auxiliary.push(AuxiliaryPayload {
                            id: format!(
                                "preset-aux:{}:{}:{index}",
                                encode_uri_component(vendor)?,
                                kind.as_str()
                            ),
                            vendor: (*vendor).clone(),
                            kind: *kind,
                            raw: Arc::new(raw.clone()),
                        });
                        continue;
                    };
                    let id = preset_id(vendor, *kind, &name)?;
                    let scoped = ((*vendor).clone(), *kind, name.clone());
                    if by_scoped.contains_key(&scoped) {
                        issues.push(Issue {
                            code: IssueCode::DuplicateProfile,
                            path,
                            message: s(&format!("Duplicate {} preset ", kind.as_str()))
                                .q(&name)
                                .s(" in vendor ")
                                .q(vendor)
                                .0,
                        });
                        continue;
                    }
                    by_scoped.insert(scoped, records.len());
                    by_kind_name
                        .entry((*kind, name.clone()))
                        .or_default()
                        .push(records.len());
                    records.push(Record {
                        id,
                        vendor: (*vendor).clone(),
                        kind: *kind,
                        name,
                        path,
                        raw: Arc::new(raw.clone()),
                        parent: None,
                    });
                }
            }
        }

        for record in &mut records {
            let Some(parent) = optional_string(get(&record.raw, "inherits")) else {
                continue;
            };
            if let Some(&local) =
                by_scoped.get(&(record.vendor.clone(), record.kind, parent.clone()))
            {
                record.parent = Some(local);
                continue;
            }
            let global = by_kind_name
                .get(&(record.kind, parent.clone()))
                .map_or(&[][..], Vec::as_slice);
            let kind = record.kind.as_str();
            match global {
                [only] => record.parent = Some(*only),
                [] => issues.push(Issue {
                    code: IssueCode::MissingParent,
                    path: u(&record.path).s(".inherits").0,
                    message: s(&format!("{kind} preset "))
                        .q(&record.name)
                        .s(" inherits missing preset ")
                        .q(&parent)
                        .0,
                }),
                _ => issues.push(Issue {
                    code: IssueCode::AmbiguousParent,
                    path: u(&record.path).s(".inherits").0,
                    message: s(&format!("{kind} preset "))
                        .q(&record.name)
                        .s(" has ambiguous cross-vendor parent ")
                        .q(&parent)
                        .0,
                }),
            }
        }
        inheritance_problems(&records, &mut issues);
        if !issues.is_empty() {
            return Err(BuildError::Graph(issues));
        }

        let mut effective: Vec<Option<Arc<JsonObject>>> = vec![None; records.len()];
        for index in 0..records.len() {
            overlay(&records, &mut effective, index);
        }
        let mut nodes: Vec<Arc<PresetNode>> = records
            .iter()
            .zip(effective)
            .map(|(record, effective)| {
                let source = source_of(&record.raw);
                let instantiation = get(&record.raw, "instantiation");
                Arc::new(PresetNode {
                    id: record.id.clone(),
                    vendor: record.vendor.clone(),
                    kind: record.kind,
                    name: record.name.clone(),
                    parent_id: record.parent.map(|p| records[p].id.clone()),
                    source,
                    is_system: source == Source::System,
                    is_default: source == Source::Default
                        || matches!(get(&record.raw, "is_default"), Some(Value::Bool(true))),
                    is_visible: !matches!(instantiation, Some(Value::Bool(false)))
                        && !matches!(instantiation, Some(Value::String(t)) if *t == key("false")),
                    raw: record.raw.clone(),
                    effective: effective.expect("every record overlays"),
                })
            })
            .collect();
        // `compareNodes`: kind, name, vendor, then ID, each by the collation.
        sort_by(&mut nodes, |a, b| {
            chain(
                collation,
                kind_rank(a.kind).cmp(&kind_rank(b.kind)),
                [
                    (&a.name, &b.name),
                    (&a.vendor, &b.vendor),
                    (&key(&a.id), &key(&b.id)),
                ],
            )
        })
        .map_err(BuildError::Collation)?;
        // `compareAuxiliary`: kind, vendor, then ID.
        sort_by(&mut auxiliary, |a, b| {
            chain(
                collation,
                kind_rank(a.kind).cmp(&kind_rank(b.kind)),
                [(&a.vendor, &b.vendor), (&key(&a.id), &key(&b.id))],
            )
        })
        .map_err(BuildError::Collation)?;
        let by_id = nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.clone(), i))
            .collect();
        Ok(Self {
            ordered: nodes,
            by_id,
            auxiliary,
        })
    }

    pub fn get(&self, id: &str) -> Option<&Arc<PresetNode>> {
        self.by_id.get(id).map(|i| &self.ordered[*i])
    }
    fn rank(&self, node: &PresetNode) -> usize {
        self.by_id[&node.id]
    }
    pub fn auxiliary(&self) -> &[AuxiliaryPayload] {
        &self.auxiliary
    }
    /// `list(kind?)`, in browser order.
    pub fn list(&self, kind: Option<Kind>) -> impl Iterator<Item = &Arc<PresetNode>> {
        self.ordered
            .iter()
            .filter(move |n| kind.is_none_or(|k| n.kind == k))
    }
    /// `selectable(kind, installedVendors?)`: visible presets of a kind.
    pub fn selectable<'a>(
        &'a self,
        kind: Kind,
        installed: Option<&'a [Vec<u16>]>,
    ) -> impl Iterator<Item = &'a Arc<PresetNode>> + 'a {
        self.ordered.iter().filter(move |n| {
            n.kind == kind && n.is_visible && installed.is_none_or(|v| v.contains(&n.vendor))
        })
    }

    /// `assessPrinterCompatibility` without a condition evaluator: a preset
    /// that only declares a condition expression is `unresolved`.
    pub fn assess_printer(&self, candidate: &PresetNode, printer: &PresetNode) -> Assessment {
        if candidate.kind == Kind::Machine || printer.kind != Kind::Machine {
            return Assessment::new(Status::Incompatible, Reason::PrinterMismatch);
        }
        if candidate.is_default {
            return Assessment::new(Status::Compatible, Reason::DefaultPreset);
        }
        if printer.name.is_empty() {
            return Assessment::new(Status::Compatible, Reason::EmptyActivePreset);
        }
        let excluded = string_list(get(&candidate.effective, "excluded_printers"));
        if candidate.kind == Kind::Filament && excluded.contains(&printer.name.as_slice()) {
            return Assessment::new(Status::Incompatible, Reason::ExcludedPrinter);
        }
        let compatible = string_list(get(&candidate.effective, "compatible_printers"));
        if !compatible.is_empty() {
            if compatible.contains(&printer.name.as_slice()) {
                return Assessment::new(Status::Compatible, Reason::ExplicitName);
            }
            let parent = printer.parent_id.as_deref().and_then(|id| self.get(id));
            if !printer.is_system
                && let Some(parent) = parent
                && compatible.contains(&parent.name.as_slice())
            {
                return Assessment::new(Status::Compatible, Reason::DirectParentName);
            }
            return Assessment::new(Status::Incompatible, Reason::ExplicitListMiss);
        }
        condition(get(&candidate.effective, "compatible_printers_condition"))
    }
    /// `assessPrintCompatibility` without a condition evaluator.
    pub fn assess_print(
        &self,
        candidate: &PresetNode,
        print: &PresetNode,
        printer: &PresetNode,
    ) -> Assessment {
        if candidate.kind != Kind::Filament
            || print.kind != Kind::Process
            || printer.kind != Kind::Machine
        {
            return Assessment::new(Status::Incompatible, Reason::PrintMismatch);
        }
        if candidate.is_default {
            return Assessment::new(Status::Compatible, Reason::DefaultPreset);
        }
        if print.name.is_empty() {
            return Assessment::new(Status::Compatible, Reason::EmptyActivePreset);
        }
        let compatible = string_list(get(&candidate.effective, "compatible_prints"));
        if !compatible.is_empty() {
            return if compatible.contains(&print.name.as_slice()) {
                Assessment::new(Status::Compatible, Reason::ExplicitName)
            } else {
                Assessment::new(Status::Incompatible, Reason::ExplicitListMiss)
            };
        }
        condition(get(&candidate.effective, "compatible_prints_condition"))
    }
    /// A filament both the printer and the process accept.
    fn filament_fits(
        &self,
        candidate: &PresetNode,
        process: &PresetNode,
        printer: &PresetNode,
    ) -> (Assessment, Option<Assessment>) {
        let printer_assessment = self.assess_printer(candidate, printer);
        let print_assessment = (printer_assessment.status == Status::Compatible)
            .then(|| self.assess_print(candidate, process, printer));
        (printer_assessment, print_assessment)
    }

    /// `resolveSelection` without a condition evaluator.
    pub fn resolve_selection(
        &self,
        request: &SelectionRequest,
    ) -> Result<Selection, UnknownPreset> {
        let printer = self.get(&request.printer_id).ok_or(UnknownPreset)?.clone();
        if printer.kind != Kind::Machine {
            return Err(UnknownPreset);
        }
        let installed = request.installed_vendors.as_deref();
        let mut substitutions = Vec::new();
        let mut diagnostics = Diagnostics::default();
        let requested_process = request
            .process_id
            .as_deref()
            .and_then(|id| self.get(id))
            .cloned();
        let mut process = requested_process.clone().filter(|p| {
            p.kind == Kind::Process && self.assess_printer(p, &printer).status == Status::Compatible
        });
        if process.is_none() {
            let mut compatible = Vec::new();
            for candidate in self.selectable(Kind::Process, installed) {
                match self.assess_printer(candidate, &printer).status {
                    Status::Compatible => compatible.push(candidate.clone()),
                    Status::Unresolved => diagnostics.add(SelectionDiagnostic {
                        code: DiagnosticCode::UnresolvedCondition,
                        preset_id: Some(candidate.id.clone()),
                        slot: None,
                        message: s("Could not evaluate compatibility for process preset ")
                            .u(&candidate.name)
                            .0,
                    }),
                    Status::Incompatible => {}
                }
            }
            let previous = requested_process
                .clone()
                .filter(|p| p.kind == Kind::Process);
            process = self.choose_process(
                &compatible,
                previous.as_deref(),
                optional_string(get(&printer.effective, "default_print_profile")).as_deref(),
            );
            substitutions.push(Substitution {
                kind: Kind::Process,
                slot: None,
                previous_id: request.process_id.clone().filter(|id| !id.is_empty()),
                next_id: process.as_ref().map(|p| p.id.clone()),
                reason: if process.is_none() {
                    SubstitutionReason::NoCompatiblePreset
                } else if requested_process.is_some() {
                    SubstitutionReason::Incompatible
                } else {
                    SubstitutionReason::Missing
                },
            });
            if process.is_none() {
                diagnostics.add(SelectionDiagnostic {
                    code: DiagnosticCode::NoCompatibleProcess,
                    preset_id: None,
                    slot: None,
                    message: s("No visible process preset is compatible with ")
                        .u(&printer.name)
                        .0,
                });
            }
        }

        let defaults = string_list(get(&printer.effective, "default_filament_profile"));
        let slots = 1
            .max(request.filament_ids.len())
            .max(defaults.len())
            .max(nozzle_count(&printer));
        let mut filaments: Vec<Option<Arc<PresetNode>>> = Vec::with_capacity(slots);
        for slot in 0..slots {
            let requested_id = request.filament_ids.get(slot).cloned().flatten();
            // An empty ID is falsy in the browser: no preset was named.
            let named = requested_id.clone().filter(|id| !id.is_empty());
            let requested = named.as_deref().and_then(|id| self.get(id)).cloned();
            let mut selected = None;
            if let (Some(process), Some(candidate)) = (&process, &requested)
                && candidate.kind == Kind::Filament
                && let (a, Some(b)) = self.filament_fits(candidate, process, &printer)
                && a.status == Status::Compatible
                && b.status == Status::Compatible
            {
                selected = Some(candidate.clone());
            }
            if selected.is_none()
                && let Some(process) = &process
            {
                let mut compatible = Vec::new();
                for candidate in self.selectable(Kind::Filament, installed) {
                    let (a, b) = self.filament_fits(candidate, process, &printer);
                    if a.status == Status::Compatible
                        && b.as_ref().is_some_and(|b| b.status == Status::Compatible)
                    {
                        compatible.push(candidate.clone());
                    } else if a.status == Status::Unresolved
                        || b.as_ref().is_some_and(|b| b.status == Status::Unresolved)
                    {
                        diagnostics.add(SelectionDiagnostic {
                            code: DiagnosticCode::UnresolvedCondition,
                            preset_id: Some(candidate.id.clone()),
                            slot: Some(slot),
                            message: s("Could not evaluate compatibility for filament preset ")
                                .u(&candidate.name)
                                .0,
                        });
                    }
                }
                // A slot the request never named inherits the first slot's
                // filament, as Orca fills a new extruder with the active preset.
                let inherited = (slot > 0
                    && named.is_none()
                    && defaults.get(slot).is_none_or(|d| d.is_empty()))
                .then(|| filaments.first().cloned().flatten())
                .flatten();
                let previous = requested
                    .clone()
                    .filter(|r| r.kind == Kind::Filament)
                    .or(inherited.clone());
                let preferred = defaults
                    .get(slot)
                    .map(|v| v.to_vec())
                    .or_else(|| inherited.as_ref().map(|i| i.name.clone()))
                    .or_else(|| defaults.first().map(|v| v.to_vec()));
                selected =
                    self.choose_filament(&compatible, previous.as_deref(), preferred.as_deref());
            }
            if selected.is_none() || selected.as_ref().map(|s| &s.id) != requested_id.as_ref() {
                substitutions.push(Substitution {
                    kind: Kind::Filament,
                    slot: Some(slot),
                    previous_id: named.clone(),
                    next_id: selected.as_ref().map(|s| s.id.clone()),
                    reason: if selected.is_none() {
                        SubstitutionReason::NoCompatiblePreset
                    } else if requested.is_some() {
                        SubstitutionReason::Incompatible
                    } else {
                        SubstitutionReason::Missing
                    },
                });
            }
            if selected.is_none() {
                diagnostics.add(SelectionDiagnostic {
                    code: DiagnosticCode::NoCompatibleFilament,
                    preset_id: None,
                    slot: Some(slot),
                    message: match &process {
                        Some(process) => {
                            s("No visible filament preset is compatible with ")
                                .u(&printer.name)
                                .s(" and ")
                                .u(&process.name)
                                .0
                        }
                        None => {
                            key("A filament cannot be selected without a compatible process preset")
                        }
                    },
                });
            }
            filaments.push(selected);
        }
        let complete = process.is_some() && filaments.iter().all(Option::is_some);
        Ok(Selection {
            printer,
            process,
            filaments,
            substitutions,
            diagnostics: diagnostics.items,
            complete,
        })
    }

    fn choose_process(
        &self,
        candidates: &[Arc<PresetNode>],
        previous: Option<&PresetNode>,
        preferred: Option<&[u16]>,
    ) -> Option<Arc<PresetNode>> {
        self.choose_highest(candidates, |candidate| {
            if candidate.is_default || candidate.source == Source::External {
                return 0.0;
            }
            let previous_alias = previous.and_then(|p| optional_string(get(&p.effective, "alias")));
            let alias = optional_string(get(&candidate.effective, "alias"));
            if previous_alias.is_some() && alias == previous_alias {
                return MAX_MATCH_QUALITY;
            }
            let mut score = if Some(candidate.name.as_slice()) == preferred {
                2.0
            } else {
                1.0
            };
            let previous_height =
                previous.and_then(|p| numeric_scalar(get(&p.effective, "layer_height")));
            let height = numeric_scalar(get(&candidate.effective, "layer_height"));
            if let (Some(previous_height), Some(height)) = (previous_height, height)
                && previous_height > 0.0
                && (height - previous_height).abs() < 0.0005
            {
                score *= 10.0;
            }
            score
        })
    }
    fn choose_filament(
        &self,
        candidates: &[Arc<PresetNode>],
        previous: Option<&PresetNode>,
        preferred: Option<&[u16]>,
    ) -> Option<Arc<PresetNode>> {
        self.choose_highest(candidates, |candidate| {
            if candidate.is_default || candidate.source == Source::External {
                return 0.0;
            }
            let previous_alias = previous.and_then(|p| optional_string(get(&p.effective, "alias")));
            let alias = optional_string(get(&candidate.effective, "alias"));
            if previous_alias.is_some() && alias == previous_alias {
                return MAX_MATCH_QUALITY;
            }
            let mut score = if Some(candidate.name.as_slice()) == preferred {
                2.0
            } else {
                1.0
            };
            let previous_type = previous
                .and_then(|p| first_string(get(&p.effective, "filament_type")))
                .filter(|t| !t.is_empty());
            if let Some(previous_type) = previous_type
                && first_string(get(&candidate.effective, "filament_type")) == Some(previous_type)
            {
                score *= 10.0;
            }
            score
        })
    }
    /// `chooseHighest`: the first best score in browser order.
    fn choose_highest(
        &self,
        candidates: &[Arc<PresetNode>],
        score: impl Fn(&PresetNode) -> f64,
    ) -> Option<Arc<PresetNode>> {
        let mut ordered: Vec<&Arc<PresetNode>> = candidates.iter().collect();
        ordered.sort_by_key(|n| self.rank(n));
        let mut best = None;
        let mut best_score = -1.0;
        for candidate in ordered {
            let value = score(candidate);
            if value > best_score {
                best = Some(candidate.clone());
                best_score = value;
            }
        }
        best
    }
}
/// The kinds' own `localeCompare` order: filament, machine, process.
fn kind_rank(kind: Kind) -> u8 {
    match kind {
        Kind::Filament => 0,
        Kind::Machine => 1,
        Kind::Process => 2,
    }
}
/// `nozzleCount`: an array's length, another present value counts once.
fn nozzle_count(printer: &PresetNode) -> usize {
    match get(&printer.effective, "nozzle_diameter") {
        Some(Value::Array(items)) => items.len(),
        None => 0,
        Some(_) => 1,
    }
}
fn condition(expression: Option<&Value>) -> Assessment {
    match optional_string(expression) {
        None => Assessment::new(Status::Compatible, Reason::ImplicitAll),
        // No engine expression evaluator runs here, as in the browser catalog.
        Some(expression) => Assessment {
            status: Status::Unresolved,
            reason: Reason::ConditionEvaluatorMissing,
            expression: Some(expression),
        },
    }
}
/// `sourceOf`: `from`, trimmed and lower-cased.
fn source_of(raw: &JsonObject) -> Source {
    let Some(from) = optional_string(get(raw, "from")) else {
        return Source::Unknown;
    };
    // Only ASCII spellings match; no other code point lower-cases into them.
    let is = |word: &str| {
        from.len() == word.len()
            && from
                .iter()
                .zip(word.bytes())
                .all(|(u, b)| *u < 0x80 && (*u as u8).eq_ignore_ascii_case(&b))
    };
    [
        Source::System,
        Source::User,
        Source::Project,
        Source::External,
        Source::Default,
    ]
    .into_iter()
    .find(|s| is(s.as_str()))
    .unwrap_or(Source::Unknown)
}
fn issue(code: IssueCode, path: Vec<u16>, message: &str) -> Issue {
    Issue {
        code,
        path,
        message: key(message),
    }
}
/// `validateRelevantFields`.
fn validate_fields(raw: &JsonObject, kind: Kind, path: &[u16], issues: &mut Vec<Issue>) {
    for name in [
        "name",
        "inherits",
        "from",
        "compatible_printers_condition",
        "compatible_prints_condition",
    ] {
        if let Some(value) = get(raw, name)
            && !matches!(value, Value::String(_))
        {
            issues.push(issue(
                IssueCode::InvalidProfile,
                u(path).s(".").s(name).0,
                &format!("{name} must be a string"),
            ));
        }
    }
    if let Some(value) = get(raw, "type")
        && !matches!(value, Value::String(t) if *t == key(kind.as_str()))
    {
        issues.push(Issue {
            code: IssueCode::InvalidProfile,
            path: u(path).s(".type").0,
            message: s(&format!(
                "Profile type must match category {}",
                kind.as_str()
            ))
            .0,
        });
    }
    for name in [
        "compatible_printers",
        "compatible_prints",
        "default_filament_profile",
        "excluded_printers",
    ] {
        let Some(value) = get(raw, name) else {
            continue;
        };
        if !matches!(value, Value::Array(items) if items.iter().all(|v| matches!(v, Value::String(_))))
        {
            issues.push(issue(
                IssueCode::InvalidProfile,
                u(path).s(".").s(name).0,
                &format!("{name} must be an array of strings"),
            ));
        }
    }
    if let Some(value) = get(raw, "instantiation")
        && !matches!(value, Value::Bool(_))
        && !matches!(value, Value::String(t) if *t == key("true") || *t == key("false"))
    {
        issues.push(issue(
            IssueCode::InvalidProfile,
            u(path).s(".instantiation").0,
            r#"instantiation must be true, false, "true", or "false""#,
        ));
    }
}
/// `detectInheritanceProblems`: depth and cycles, each cycle reported once.
fn inheritance_problems(records: &[Record], issues: &mut Vec<Issue>) {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Visiting,
        Visited,
    }
    let mut state: Vec<Option<State>> = vec![None; records.len()];
    let mut reported: BTreeSet<Vec<String>> = BTreeSet::new();
    for start in 0..records.len() {
        let mut stack: Vec<usize> = Vec::new();
        let mut current = Some(start);
        // The browser recurses into the parent; walk the same chain iteratively.
        let mut path: Vec<usize> = Vec::new();
        while let Some(index) = current {
            if state[index] == Some(State::Visited) {
                break;
            }
            if stack.len() >= MAX_INHERITANCE_DEPTH {
                issues.push(issue(
                    IssueCode::InheritanceDepth,
                    u(&records[index].path).s(".inherits").0,
                    &format!("Preset inheritance exceeds {MAX_INHERITANCE_DEPTH} levels"),
                ));
                break;
            }
            if state[index] == Some(State::Visiting) {
                let begin = stack.iter().position(|i| *i == index).unwrap_or(0);
                let cycle: Vec<usize> = stack[begin..].iter().copied().chain([index]).collect();
                let mut ids: Vec<String> = cycle.iter().map(|i| records[*i].id.clone()).collect();
                ids.sort();
                ids.dedup();
                if reported.insert(ids) {
                    let mut message = s("Preset inheritance cycle: ");
                    for (n, i) in cycle.iter().enumerate() {
                        if n > 0 {
                            message = message.s(" -> ");
                        }
                        message = message.u(&records[*i].name);
                    }
                    issues.push(Issue {
                        code: IssueCode::InheritanceCycle,
                        path: u(&records[index].path).s(".inherits").0,
                        message: message.0,
                    });
                }
                break;
            }
            state[index] = Some(State::Visiting);
            path.push(index);
            stack.push(index);
            current = records[index].parent;
        }
        for index in path {
            state[index] = Some(State::Visited);
        }
    }
}
/// `effective(record)`: the parent's overlay, then this payload's keys.
fn overlay(
    records: &[Record],
    cache: &mut [Option<Arc<JsonObject>>],
    index: usize,
) -> Arc<JsonObject> {
    if let Some(done) = &cache[index] {
        return done.clone();
    }
    let mut merged = match records[index].parent {
        Some(parent) => (*overlay(records, cache, parent)).clone(),
        None => JsonObject::new(),
    };
    merged.extend(
        records[index]
            .raw
            .iter()
            .map(|(k, v)| (k.clone(), v.clone())),
    );
    let merged = Arc::new(merged);
    cache[index] = Some(merged.clone());
    merged
}
/// The first unequal comparison, consulting the collation only as needed.
fn chain<C: Collation, const N: usize>(
    collation: &mut C,
    first: Ordering,
    rest: [(&Vec<u16>, &Vec<u16>); N],
) -> Result<Ordering, C::Error> {
    if first != Ordering::Equal {
        return Ok(first);
    }
    for (left, right) in rest {
        let order = collation.compare(left, right)?;
        if order != Ordering::Equal {
            return Ok(order);
        }
    }
    Ok(Ordering::Equal)
}
/// A stable sort whose comparator may fail; the first failure wins.
fn sort_by<T, E>(
    items: &mut [T],
    mut compare: impl FnMut(&T, &T) -> Result<Ordering, E>,
) -> Result<(), E> {
    let failure = RefCell::new(None);
    items.sort_by(|a, b| {
        if failure.borrow().is_some() {
            return Ordering::Equal;
        }
        compare(a, b).unwrap_or_else(|e| {
            *failure.borrow_mut() = Some(e);
            Ordering::Equal
        })
    });
    match failure.into_inner() {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

names!(Status {
    Compatible => "compatible",
    Incompatible => "incompatible",
    Unresolved => "unresolved",
});
names!(Reason {
    DefaultPreset => "default-preset",
    EmptyActivePreset => "empty-active-preset",
    ExplicitName => "explicit-name",
    DirectParentName => "direct-parent-name",
    ImplicitAll => "implicit-all",
    ConditionTrue => "condition-true",
    ConditionFalse => "condition-false",
    ConditionEvaluatorMissing => "condition-evaluator-missing",
    ConditionEvaluationFailed => "condition-evaluation-failed",
    ExplicitListMiss => "explicit-list-miss",
    ExcludedPrinter => "excluded-printer",
    PrinterMismatch => "printer-mismatch",
    PrintMismatch => "print-mismatch",
});
/// `PresetCompatibilityAssessment`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assessment {
    pub status: Status,
    pub reason: Reason,
    pub expression: Option<Vec<u16>>,
}
impl Assessment {
    fn new(status: Status, reason: Reason) -> Self {
        Self {
            status,
            reason,
            expression: None,
        }
    }
}

/// `PresetSelectionRequest`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectionRequest {
    pub printer_id: String,
    pub process_id: Option<String>,
    pub filament_ids: Vec<Option<String>>,
    pub installed_vendors: Option<Vec<Vec<u16>>>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownPreset;
impl fmt::Display for UnknownPreset {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("unknown_preset")
    }
}
impl std::error::Error for UnknownPreset {}
names!(SubstitutionReason {
    Missing => "missing",
    Incompatible => "incompatible",
    NoCompatiblePreset => "no-compatible-preset",
});
/// `PresetSelectionSubstitution`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Substitution {
    pub kind: Kind,
    pub slot: Option<usize>,
    pub previous_id: Option<String>,
    pub next_id: Option<String>,
    pub reason: SubstitutionReason,
}
names!(DiagnosticCode {
    UnresolvedCondition => "unresolved-condition",
    NoCompatibleProcess => "no-compatible-process",
    NoCompatibleFilament => "no-compatible-filament",
});
/// `PresetSelectionDiagnostic`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectionDiagnostic {
    pub code: DiagnosticCode,
    pub preset_id: Option<String>,
    pub slot: Option<usize>,
    pub message: Vec<u16>,
}
/// `deduplicateDiagnostics`: a Map keyed by code, preset and slot keeps the
/// first position and the last value.
#[derive(Default)]
struct Diagnostics {
    items: Vec<SelectionDiagnostic>,
}
impl Diagnostics {
    fn add(&mut self, diagnostic: SelectionDiagnostic) {
        let same = |d: &SelectionDiagnostic| {
            d.code == diagnostic.code
                && d.preset_id == diagnostic.preset_id
                && d.slot == diagnostic.slot
        };
        match self.items.iter_mut().find(|d| same(d)) {
            Some(existing) => *existing = diagnostic,
            None => self.items.push(diagnostic),
        }
    }
}
/// `ResolvedPresetSelection`.
#[derive(Debug, Clone, PartialEq)]
pub struct Selection {
    pub printer: Arc<PresetNode>,
    pub process: Option<Arc<PresetNode>>,
    pub filaments: Vec<Option<Arc<PresetNode>>>,
    pub substitutions: Vec<Substitution>,
    pub diagnostics: Vec<SelectionDiagnostic>,
    pub complete: bool,
}
