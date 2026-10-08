//! Installed printers and user-authored presets
//! (`web/src/settings/presets/PresetLibrary.ts`). The system catalog is pinned
//! data nobody edits; installation hides uninstalled printers instead of
//! removing them (variants inherit from one another), and a custom preset is an
//! overlay on a base preset, never a free-standing configuration. Every change
//! is proven by rebuilding the composed graph before it replaces the state.
//!
//! A host supplies three policies per call through [`LibraryHost`]: the
//! preset collation, the clock that stamps provenance, and `Date.parse`
//! validity for provenance timestamps.
use super::presets::{BuildError, Collation, JsonObject, Kind, PresetGraph, PresetNode, Status};
use crate::{
    js_math::convert::{
        js_keys, json_stringify, number_to_string, parse_float, trim_utf16, value_to_string,
    },
    validation::TimestampPolicy,
};
use orcaxr_contracts::canonical::Value;
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
};

pub const SCHEMA_VERSION: f64 = 1.0;
pub const BUNDLE_FORMAT: &str = "orcaxr.preset-bundle";
/// Keys the library owns: a bundle may not rename or re-parent itself.
pub const RESERVED_KEYS: &[&str] = &[
    "name",
    "type",
    "inherits",
    "from",
    "instantiation",
    "is_default",
    "setting_id",
];
/// The default vendor of operator-authored presets.
pub const CUSTOM_VENDOR: &str = "OrcaXR Custom";
pub const ENGINE_REPOSITORY: &str = "https://github.com/Snapmaker/OrcaSlicer.git";
pub const ENGINE_COMMIT: &str = "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626";
const MAX_NAME_UNITS: usize = 120;
const DEFAULT_LICENSE: &str = "All rights reserved (operator-authored)";
const DEFAULT_VERSION: &str = "1.0.0";

/// The host policies a library change consults.
pub trait LibraryHost {
    type Error;
    /// `localeCompare(…, 'en')` for preset text.
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, Self::Error>;
    /// The current time as an ISO-8601 string (`new Date().toISOString()`).
    fn now(&mut self) -> Vec<u16>;
    /// Whether `Date.parse(text)` is a number.
    fn timestamp(&mut self, text: &[u16]) -> Result<bool, Self::Error>;
}
/// A collation, a clock and a timestamp policy with one error type.
pub struct Host<C, K, T> {
    pub collation: C,
    pub clock: K,
    pub timestamps: T,
}
impl<E, C, K, T> LibraryHost for Host<C, K, T>
where
    C: Collation<Error = E>,
    K: FnMut() -> Vec<u16>,
    T: TimestampPolicy<Error = E>,
{
    type Error = E;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, E> {
        self.collation.compare(left, right)
    }
    fn now(&mut self) -> Vec<u16> {
        (self.clock)()
    }
    fn timestamp(&mut self, text: &[u16]) -> Result<bool, E> {
        self.timestamps.is_valid(text)
    }
}
/// The graph builder sees the host's collation alone.
struct ByHost<'a, H: LibraryHost>(&'a mut H);
impl<H: LibraryHost> Collation for ByHost<'_, H> {
    type Error = H::Error;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, H::Error> {
        self.0.compare(left, right)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProvenanceSource {
    UserDerived,
    Imported,
}
impl ProvenanceSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserDerived => "user-derived",
            Self::Imported => "imported",
        }
    }
}
/// `PresetLineage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lineage {
    pub vendor: Vec<u16>,
    pub kind: Kind,
    pub name: Vec<u16>,
}
/// `PresetProvenance`: what a custom preset derives from, under what licence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provenance {
    pub source: ProvenanceSource,
    pub license: Vec<u16>,
    pub version: Vec<u16>,
    pub derived_from: Lineage,
    pub created_at: Vec<u16>,
    pub updated_at: Vec<u16>,
    pub note: Option<Vec<u16>>,
}
/// `CustomPresetRecord`: an overlay on a base preset.
#[derive(Debug, Clone, PartialEq)]
pub struct CustomPreset {
    pub vendor: Vec<u16>,
    pub kind: Kind,
    pub name: Vec<u16>,
    pub inherits: Vec<u16>,
    pub overrides: JsonObject,
    pub provenance: Provenance,
}
/// `InstalledPrinterSelection`: the installed variants of one model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub vendor: Vec<u16>,
    pub model: Vec<u16>,
    pub variants: Vec<Vec<u16>>,
}
/// `PresetLibraryState`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LibraryState {
    pub catalog_fingerprint: String,
    pub installed: Vec<Installed>,
    pub custom_presets: Vec<CustomPreset>,
}

names!(IssueCode {
    InvalidState => "invalid-state",
    InvalidBundle => "invalid-bundle",
    UnsupportedSchema => "unsupported-schema",
    EngineMismatch => "engine-mismatch",
    UnknownPrinterModel => "unknown-printer-model",
    UnknownPrinterVariant => "unknown-printer-variant",
    UnknownBasePreset => "unknown-base-preset",
    BaseNotInstantiable => "base-not-instantiable",
    DuplicatePresetName => "duplicate-preset-name",
    ReservedKey => "reserved-key",
    UnknownPresetKey => "unknown-preset-key",
    InvalidValue => "invalid-value",
    InvalidProvenance => "invalid-provenance",
    InvalidName => "invalid-name",
    UnknownPreset => "unknown-preset",
    DependentPreset => "dependent-preset",
    GraphRejected => "graph-rejected",
    NothingInstalled => "nothing-installed",
});
/// `PresetLibraryIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub code: IssueCode,
    pub error: bool,
    pub path: Vec<u16>,
    pub message: Vec<u16>,
}
/// `PresetLibraryResult`: whether the change applied, with every issue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub ok: bool,
    pub issues: Vec<Issue>,
}

/// `CustomPresetDraft`.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub vendor: Option<Vec<u16>>,
    pub kind: Kind,
    pub name: Vec<u16>,
    pub inherits: Vec<u16>,
    pub overrides: Option<JsonObject>,
    pub license: Option<Vec<u16>>,
    pub version: Option<Vec<u16>>,
    pub note: Option<Vec<u16>>,
    pub source: Option<ProvenanceSource>,
}
/// A partial draft for `updateCustomPreset`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DraftUpdate {
    pub vendor: Option<Vec<u16>>,
    pub kind: Option<Kind>,
    pub name: Option<Vec<u16>>,
    pub inherits: Option<Vec<u16>>,
    pub overrides: Option<JsonObject>,
    pub license: Option<Vec<u16>>,
    pub version: Option<Vec<u16>>,
    pub note: Option<Vec<u16>>,
    pub source: Option<ProvenanceSource>,
}

/// One installable printer variant.
#[derive(Debug, Clone, PartialEq)]
pub struct Variant {
    pub variant: Vec<u16>,
    pub preset_name: Vec<u16>,
    pub preset_id: String,
    pub nozzle_diameter: Option<f64>,
    pub installed: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Model {
    pub vendor: Vec<u16>,
    pub model: Vec<u16>,
    pub variants: Vec<Variant>,
    pub installed: bool,
}
/// `PrinterInventory`.
#[derive(Debug, Clone, PartialEq)]
pub struct Inventory {
    pub vendors: Vec<Vec<u16>>,
    pub models: Vec<Model>,
}
/// `PresetCatalogUpdatePlan`.
#[derive(Debug, Clone, PartialEq)]
pub struct UpdatePlan {
    pub previous_fingerprint: String,
    pub next_fingerprint: String,
    pub changed: bool,
    pub added_models: Vec<Lineage>,
    pub removed_models: Vec<Lineage>,
    pub removed_variants: Vec<Lineage>,
    pub orphaned_custom_presets: Vec<Lineage>,
    pub issues: Vec<Issue>,
    pub applicable: bool,
}

/// UTF-16 message assembly.
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
fn key(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn issue(code: IssueCode, path: Vec<u16>, message: Vec<u16>) -> Issue {
    Issue {
        code,
        error: true,
        path,
        message,
    }
}
fn warning(code: IssueCode, path: Vec<u16>, message: Vec<u16>) -> Issue {
    Issue {
        error: false,
        ..issue(code, path, message)
    }
}
fn failed(issues: Vec<Issue>) -> Outcome {
    Outcome { ok: false, issues }
}
fn get<'a>(object: &'a JsonObject, name: &str) -> Option<&'a Value> {
    object.get(&key(name))
}
/// `optionalString`: a non-blank string, trimmed.
fn optional_string(value: Option<&Value>) -> Option<Vec<u16>> {
    match value {
        Some(Value::String(t)) => {
            let trimmed = trim_utf16(t);
            (!trimmed.is_empty()).then(|| trimmed.to_vec())
        }
        _ => None,
    }
}
fn trimmed(units: &[u16]) -> Vec<u16> {
    trim_utf16(units).to_vec()
}
/// `firstNumber`: the first scalar as a finite number, strings by `parseFloat`.
fn first_number(value: Option<&Value>) -> Option<f64> {
    let scalar = match value {
        Some(Value::Array(items)) => items.first(),
        other => other,
    };
    match scalar {
        Some(Value::Number(n)) if n.is_finite() => Some(*n),
        Some(Value::String(t)) => {
            Some(parse_float(&String::from_utf16_lossy(t))).filter(|n| n.is_finite())
        }
        _ => None,
    }
}
/// `printerVariantOf`: `printer_variant`, else the first nozzle diameter.
fn variant_of(node: &PresetNode) -> Option<Vec<u16>> {
    optional_string(get(&node.effective, "printer_variant")).or_else(|| {
        first_number(get(&node.effective, "nozzle_diameter")).map(|n| key(&number_to_string(n)))
    })
}
fn model_of(node: &PresetNode) -> Option<Vec<u16>> {
    optional_string(get(&node.effective, "printer_model"))
}

/// `stableStringify`: JSON with every object's keys in UTF-16 order, array
/// indices included (unlike `JSON.stringify`, which puts those first).
pub fn stable_stringify(value: &Value) -> Vec<u16> {
    let mut out = Vec::new();
    stable(value, &mut out);
    out
}
fn stable(value: &Value, out: &mut Vec<u16>) {
    match value {
        Value::Array(items) => {
            out.push(u16::from(b'['));
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(u16::from(b','));
                }
                stable(item, out);
            }
            out.push(u16::from(b']'));
        }
        Value::Object(fields) => {
            out.push(u16::from(b'{'));
            for (i, (k, v)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(u16::from(b','));
                }
                out.extend(json_stringify(&Value::String(k.clone())));
                out.push(u16::from(b':'));
                stable(v, out);
            }
            out.push(u16::from(b'}'));
        }
        scalar => out.extend(json_stringify(scalar)),
    }
}
/// `fnv1a64Text`: FNV-1a over the text's WTF-8 bytes, as 16 hex digits.
pub fn fnv1a64_text(units: &[u16]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut byte = |b: u8| {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    };
    let mut i = 0;
    while i < units.len() {
        let mut code = u32::from(units[i]);
        if (0xd800..=0xdbff).contains(&code)
            && let Some(&low) = units.get(i + 1)
            && (0xdc00..=0xdfff).contains(&low)
        {
            code = 0x10000 + ((code - 0xd800) << 10) + (u32::from(low) - 0xdc00);
            i += 1;
        }
        // A lone surrogate keeps its own three-byte encoding.
        if code <= 0x7f {
            byte(code as u8);
        } else if code <= 0x7ff {
            byte(0xc0 | (code >> 6) as u8);
            byte(0x80 | (code & 0x3f) as u8);
        } else if code <= 0xffff {
            byte(0xe0 | (code >> 12) as u8);
            byte(0x80 | ((code >> 6) & 0x3f) as u8);
            byte(0x80 | (code & 0x3f) as u8);
        } else {
            byte(0xf0 | (code >> 18) as u8);
            byte(0x80 | ((code >> 12) & 0x3f) as u8);
            byte(0x80 | ((code >> 6) & 0x3f) as u8);
            byte(0x80 | (code & 0x3f) as u8);
        }
        i += 1;
    }
    format!("{hash:016x}")
}
/// `fingerprintGraph`: every preset's identity and payload, sorted.
pub fn fingerprint(graph: &PresetGraph) -> String {
    let mut identities: Vec<Vec<u16>> = graph
        .list(None)
        .map(|n| {
            u(&n.vendor)
                .s("\0")
                .s(n.kind.as_str())
                .s("\0")
                .u(&n.name)
                .s("\0")
                .u(&stable_stringify(&Value::Object((*n.raw).clone())))
                .0
        })
        .collect();
    identities.sort();
    // The browser joins them with U+0001.
    fnv1a64_text(&identities.join(&1))
}

/// A fallible stable sort: the first comparator failure wins.
fn sort_by<T, E>(
    items: &mut [T],
    mut compare: impl FnMut(&T, &T) -> Result<Ordering, E>,
) -> Result<(), E> {
    let mut failure = None;
    items.sort_by(|a, b| {
        if failure.is_some() {
            return Ordering::Equal;
        }
        compare(a, b).unwrap_or_else(|e| {
            failure = Some(e);
            Ordering::Equal
        })
    });
    failure.map_or(Ok(()), Err)
}
/// `compareVariants`: numeric diameters first, then the collation.
fn compare_variants<H: LibraryHost>(
    host: &mut H,
    left: &[u16],
    right: &[u16],
) -> Result<Ordering, H::Error> {
    let a = parse_float(&String::from_utf16_lossy(left));
    let b = parse_float(&String::from_utf16_lossy(right));
    if a.is_finite() && b.is_finite() && a != b {
        return Ok(a.partial_cmp(&b).unwrap_or(Ordering::Equal));
    }
    host.compare(left, right)
}
/// `compareLineage`: vendor, then name.
fn compare_lineage<H: LibraryHost>(
    host: &mut H,
    left: &Lineage,
    right: &Lineage,
) -> Result<Ordering, H::Error> {
    match host.compare(&left.vendor, &right.vendor)? {
        Ordering::Equal => host.compare(&left.name, &right.name),
        order => Ok(order),
    }
}
fn graph_issues<E>(error: BuildError<E>, path: &[u16]) -> Result<Vec<Issue>, E> {
    Ok(match error {
        BuildError::Graph(issues) => issues
            .into_iter()
            .map(|i| issue(IssueCode::GraphRejected, i.path, i.message))
            .collect(),
        BuildError::MalformedUri => vec![issue(
            IssueCode::GraphRejected,
            path.to_vec(),
            key("URI malformed"),
        )],
        BuildError::Collation(e) => return Err(e),
    })
}

/// The pinned system catalog, this operator's installation and custom presets,
/// and the composed graph every change is proven against.
#[derive(Debug, Clone)]
pub struct Library {
    system: JsonObject,
    system_graph: PresetGraph,
    fingerprint: String,
    allowed: BTreeMap<Kind, BTreeSet<Vec<u16>>>,
    state: LibraryState,
    composed: PresetGraph,
}

/// Installed variants by (vendor, model).
type InstalledIndex = BTreeMap<(Vec<u16>, Vec<u16>), BTreeSet<Vec<u16>>>;

/// Where a custom preset's base was found.
enum Base<'a> {
    Node(&'a PresetNode),
    Custom(&'a CustomPreset),
}

impl Library {
    fn new<H: LibraryHost>(
        system: JsonObject,
        system_graph: PresetGraph,
        host: &mut H,
    ) -> Result<Self, BuildError<H::Error>> {
        let fingerprint = fingerprint(&system_graph);
        let mut allowed: BTreeMap<Kind, BTreeSet<Vec<u16>>> =
            Kind::ALL.iter().map(|k| (*k, BTreeSet::new())).collect();
        for node in system_graph.list(None) {
            allowed
                .entry(node.kind)
                .or_default()
                .extend(node.effective.keys().cloned());
        }
        let mut library = Self {
            system,
            composed: system_graph.clone(),
            system_graph,
            state: LibraryState {
                catalog_fingerprint: fingerprint.clone(),
                ..Default::default()
            },
            fingerprint,
            allowed,
        };
        library.composed = PresetGraph::build(&library.compose_catalog(), &mut ByHost(host))?;
        Ok(library)
    }

    /// `PresetLibrary.create`: a malformed system catalog is refused; malformed
    /// local state is reported and replaced by an empty library. A failing host
    /// policy surfaces as `BuildError::Collation`.
    pub fn create<H: LibraryHost>(
        catalog: &Value,
        state: Option<&Value>,
        host: &mut H,
    ) -> Result<(Self, Vec<Issue>), BuildError<H::Error>> {
        let graph = PresetGraph::build(catalog, &mut ByHost(host))?;
        let Value::Object(system) = catalog else {
            unreachable!("a built catalog is an object")
        };
        let mut library = Self::new(system.clone(), graph, host)?;
        let Some(state) = state else {
            return Ok((library, Vec::new()));
        };
        let mut issues = Vec::new();
        let Some(parsed) = parse_state(state, &mut issues, host).map_err(BuildError::Collation)?
        else {
            return Ok((library, issues));
        };
        if !parsed.catalog_fingerprint.is_empty()
            && parsed.catalog_fingerprint != library.fingerprint
        {
            issues.push(warning(
                IssueCode::EngineMismatch,
                key("$.catalogFingerprint"),
                key("This setup was made against a different printer catalog. Anything the current catalog no longer offers is listed below and has not been kept."),
            ));
        }
        let applied = library
            .apply_state(parsed, &key("$"), Vec::new(), host)
            .map_err(BuildError::Collation)?;
        if !applied.ok {
            issues.extend(applied.issues);
        }
        Ok((library, issues))
    }

    pub fn state(&self) -> &LibraryState {
        &self.state
    }
    pub fn catalog_fingerprint(&self) -> &str {
        &self.fingerprint
    }
    pub fn system_graph(&self) -> &PresetGraph {
        &self.system_graph
    }
    /// The composed catalog as a validated graph.
    pub fn graph(&self) -> &PresetGraph {
        &self.composed
    }
    /// True once at least one printer variant is installed.
    pub fn is_configured(&self) -> bool {
        self.state.installed.iter().any(|e| !e.variants.is_empty())
    }
    /// Vendors with an installed variant or a custom preset; every vendor when
    /// nothing is installed. UTF-16 order.
    pub fn installed_vendors(&self) -> Vec<Vec<u16>> {
        let mut vendors: BTreeSet<Vec<u16>> = BTreeSet::new();
        if !self.is_configured() {
            vendors.extend(self.system_graph.list(None).map(|n| n.vendor.clone()));
        } else {
            vendors.extend(
                self.state
                    .installed
                    .iter()
                    .filter(|e| !e.variants.is_empty())
                    .map(|e| e.vendor.clone()),
            );
            vendors.extend(self.state.custom_presets.iter().map(|p| p.vendor.clone()));
        }
        vendors.into_iter().collect()
    }
    pub fn custom_presets(&self, kind: Option<Kind>) -> impl Iterator<Item = &CustomPreset> {
        self.state
            .custom_presets
            .iter()
            .filter(move |p| kind.is_none_or(|k| p.kind == k))
    }

    fn installed_index(&self) -> InstalledIndex {
        let mut index = BTreeMap::new();
        for entry in &self.state.installed {
            // A later entry for the same model replaces the earlier one.
            index.insert(
                (entry.vendor.clone(), entry.model.clone()),
                entry.variants.iter().cloned().collect(),
            );
        }
        index
    }
    /// The installable variants of a model, in graph order.
    fn variants_for_model(&self, vendor: &[u16], model: &[u16]) -> Option<Vec<Vec<u16>>> {
        let mut variants: Vec<Vec<u16>> = Vec::new();
        for node in self.system_graph.list(Some(Kind::Machine)) {
            if node.vendor != vendor || !node.is_system || model_of(node).as_deref() != Some(model)
            {
                continue;
            }
            if let Some(variant) = variant_of(node)
                && !variants.contains(&variant)
            {
                variants.push(variant);
            }
        }
        (!variants.is_empty()).then_some(variants)
    }
    fn system_machine(
        &self,
        vendor: &[u16],
        model: &[u16],
        variant: &[u16],
    ) -> Option<&PresetNode> {
        self.system_graph
            .list(Some(Kind::Machine))
            .find(|n| {
                n.vendor == vendor
                    && model_of(n).as_deref() == Some(model)
                    && variant_of(n).as_deref() == Some(variant)
            })
            .map(|n| &**n)
    }

    /// `inventory`: every installable printer by vendor, model and nozzle.
    pub fn inventory<H: LibraryHost>(&self, host: &mut H) -> Result<Inventory, H::Error> {
        let installed = self.installed_index();
        let mut models: Vec<Model> = Vec::new();
        for node in self.system_graph.list(Some(Kind::Machine)) {
            if !node.is_system {
                continue;
            }
            let (Some(model), Some(variant)) = (model_of(node), variant_of(node)) else {
                continue;
            };
            let position = match models
                .iter()
                .position(|m| m.vendor == node.vendor && m.model == model)
            {
                Some(p) => p,
                None => {
                    models.push(Model {
                        vendor: node.vendor.clone(),
                        model: model.clone(),
                        variants: Vec::new(),
                        installed: false,
                    });
                    models.len() - 1
                }
            };
            let entry = &mut models[position];
            if entry.variants.iter().any(|v| v.variant == variant) {
                continue;
            }
            let is_installed = installed
                .get(&(node.vendor.clone(), model.clone()))
                .is_some_and(|v| v.contains(&variant));
            entry.variants.push(Variant {
                variant,
                preset_name: node.name.clone(),
                preset_id: node.id.clone(),
                nozzle_diameter: first_number(get(&node.effective, "nozzle_diameter")),
                installed: is_installed,
            });
        }
        sort_by(&mut models, |a, b| {
            match host.compare(&a.vendor, &b.vendor)? {
                Ordering::Equal => host.compare(&a.model, &b.model),
                order => Ok(order),
            }
        })?;
        for model in &mut models {
            sort_by(&mut model.variants, |a, b| {
                compare_variants(host, &a.variant, &b.variant)
            })?;
            model.installed = model.variants.iter().any(|v| v.installed);
        }
        let vendors: BTreeSet<Vec<u16>> = models.iter().map(|m| m.vendor.clone()).collect();
        Ok(Inventory {
            vendors: vendors.into_iter().collect(),
            models,
        })
    }

    /// `setInstalled`: replace the installation set; unknown models and
    /// variants are refused, never dropped.
    pub fn set_installed<H: LibraryHost>(
        &mut self,
        selections: &[Installed],
        host: &mut H,
    ) -> Result<Outcome, H::Error> {
        let mut issues = Vec::new();
        let installed =
            self.normalize_installed(selections, &key("$.installed"), &mut issues, host)?;
        if issues.iter().any(|i| i.error) {
            return Ok(failed(issues));
        }
        let candidate = LibraryState {
            installed,
            ..self.state.clone()
        };
        self.apply_state(candidate, &key("$.installed"), issues, host)
    }
    /// `installPrinter`: clearing the last variant uninstalls the model.
    pub fn install_printer<H: LibraryHost>(
        &mut self,
        vendor: &[u16],
        model: &[u16],
        variants: &[Vec<u16>],
        host: &mut H,
    ) -> Result<Outcome, H::Error> {
        if variants.is_empty() {
            return self.uninstall_printer(vendor, model, host);
        }
        let mut selections: Vec<Installed> = self
            .state
            .installed
            .iter()
            .filter(|e| e.vendor != vendor || e.model != model)
            .cloned()
            .collect();
        selections.push(Installed {
            vendor: vendor.to_vec(),
            model: model.to_vec(),
            variants: variants.to_vec(),
        });
        self.set_installed(&selections, host)
    }
    /// `uninstallPrinter`: refused while a custom preset derives from it.
    pub fn uninstall_printer<H: LibraryHost>(
        &mut self,
        vendor: &[u16],
        model: &[u16],
        host: &mut H,
    ) -> Result<Outcome, H::Error> {
        let removed: Vec<&Installed> = self
            .state
            .installed
            .iter()
            .filter(|e| e.vendor == vendor && e.model == model)
            .collect();
        if removed.is_empty() {
            return Ok(failed(vec![issue(
                IssueCode::UnknownPrinterModel,
                key("$.installed"),
                u(vendor).s(" ").u(model).s(" is not installed.").0,
            )]));
        }
        let mut names = BTreeSet::new();
        for entry in &removed {
            for variant in &entry.variants {
                if let Some(node) = self.system_machine(vendor, model, variant) {
                    names.insert(node.name.clone());
                }
            }
        }
        let dependants: Vec<&CustomPreset> = self
            .state
            .custom_presets
            .iter()
            .filter(|p| names.contains(&p.inherits))
            .collect();
        if !dependants.is_empty() {
            let mut list = Units::default();
            for (i, p) in dependants.iter().enumerate() {
                if i > 0 {
                    list = list.s(", ");
                }
                list = list.u(&p.name);
            }
            let n = dependants.len();
            return Ok(failed(vec![issue(
                IssueCode::DependentPreset,
                key("$.customPresets"),
                u(vendor)
                    .s(" ")
                    .u(model)
                    .s(&format!(
                        " still has {n} custom preset{} derived from it (",
                        if n == 1 { "" } else { "s" }
                    ))
                    .u(&list.0)
                    .s("). Delete or re-base them first.")
                    .0,
            )]));
        }
        let remaining: Vec<Installed> = self
            .state
            .installed
            .iter()
            .filter(|e| e.vendor != vendor || e.model != model)
            .cloned()
            .collect();
        self.set_installed(&remaining, host)
    }

    /// `basePresetsFor`: presets a new custom preset of this kind may derive
    /// from; with a printer (and process), only what it can use.
    pub fn base_presets_for(
        &self,
        kind: Kind,
        printer: Option<&str>,
        process: Option<&str>,
    ) -> Vec<&PresetNode> {
        let graph = &self.composed;
        let selectable: Vec<&PresetNode> = graph.selectable(kind, None).map(|n| &**n).collect();
        let printer = printer.and_then(|id| graph.list(Some(Kind::Machine)).find(|n| n.id == id));
        let Some(printer) = printer.filter(|_| kind != Kind::Machine) else {
            return selectable;
        };
        let fits = |n: &PresetNode| graph.assess_printer(n, printer).status == Status::Compatible;
        if kind == Kind::Process {
            return selectable.into_iter().filter(|n| fits(n)).collect();
        }
        let process = process.and_then(|id| graph.list(Some(Kind::Process)).find(|n| n.id == id));
        match process {
            Some(process) => selectable
                .into_iter()
                .filter(|n| {
                    fits(n) && graph.assess_print(n, process, printer).status == Status::Compatible
                })
                .collect(),
            None => selectable.into_iter().filter(|n| fits(n)).collect(),
        }
    }

    /// `createCustomPreset`.
    pub fn create_custom_preset<H: LibraryHost>(
        &mut self,
        draft: &Draft,
        host: &mut H,
    ) -> Result<Outcome, H::Error> {
        let mut issues = Vec::new();
        let Some(record) = self.build_record(draft, None, &mut issues, host)? else {
            return Ok(failed(issues));
        };
        let mut candidate = self.state.clone();
        candidate.custom_presets.push(record);
        self.apply_state(candidate, &key("$.customPresets"), issues, host)
    }
    /// `updateCustomPreset`: identity keys are re-validated; a rename that
    /// would orphan another custom preset is refused.
    pub fn update_custom_preset<H: LibraryHost>(
        &mut self,
        vendor: &[u16],
        kind: Kind,
        name: &[u16],
        update: &DraftUpdate,
        host: &mut H,
    ) -> Result<Outcome, H::Error> {
        let Some(index) = self
            .state
            .custom_presets
            .iter()
            .position(|p| p.vendor == vendor && p.kind == kind && p.name == name)
        else {
            return Ok(failed(vec![unknown_preset(kind, name)]));
        };
        let existing = self.state.custom_presets[index].clone();
        let note = update
            .note
            .clone()
            .or_else(|| existing.provenance.note.clone())
            .filter(|n| !n.is_empty());
        let merged = Draft {
            vendor: Some(
                update
                    .vendor
                    .clone()
                    .unwrap_or_else(|| existing.vendor.clone()),
            ),
            kind: update.kind.unwrap_or(existing.kind),
            name: update.name.clone().unwrap_or_else(|| existing.name.clone()),
            inherits: update
                .inherits
                .clone()
                .unwrap_or_else(|| existing.inherits.clone()),
            overrides: Some(
                update
                    .overrides
                    .clone()
                    .unwrap_or_else(|| existing.overrides.clone()),
            ),
            license: Some(
                update
                    .license
                    .clone()
                    .unwrap_or_else(|| existing.provenance.license.clone()),
            ),
            version: Some(
                update
                    .version
                    .clone()
                    .unwrap_or_else(|| existing.provenance.version.clone()),
            ),
            note,
            source: Some(update.source.unwrap_or(existing.provenance.source)),
        };
        let mut issues = Vec::new();
        let Some(record) = self.build_record(&merged, Some(index), &mut issues, host)? else {
            return Ok(failed(issues));
        };
        let dependants: Vec<&CustomPreset> = self
            .state
            .custom_presets
            .iter()
            .enumerate()
            .filter(|(i, p)| {
                *i != index && p.inherits == existing.name && record.name != existing.name
            })
            .map(|(_, p)| p)
            .collect();
        if !dependants.is_empty() {
            let mut list = Units::default();
            for (i, p) in dependants.iter().enumerate() {
                if i > 0 {
                    list = list.s(", ");
                }
                list = list.q(&p.name);
            }
            return Ok(failed(vec![issue(
                IssueCode::DependentPreset,
                key("$.customPresets"),
                s("Renaming ")
                    .q(&existing.name)
                    .s(" would orphan ")
                    .u(&list.0)
                    .s(".")
                    .0,
            )]));
        }
        let mut candidate = self.state.clone();
        candidate.custom_presets[index] = record;
        self.apply_state(candidate, &key("$.customPresets"), issues, host)
    }
    /// `deleteCustomPreset`: refused while another preset derives from it.
    pub fn delete_custom_preset<H: LibraryHost>(
        &mut self,
        vendor: &[u16],
        kind: Kind,
        name: &[u16],
        host: &mut H,
    ) -> Result<Outcome, H::Error> {
        let Some(index) = self
            .state
            .custom_presets
            .iter()
            .position(|p| p.vendor == vendor && p.kind == kind && p.name == name)
        else {
            return Ok(failed(vec![unknown_preset(kind, name)]));
        };
        let dependants: Vec<&CustomPreset> = self
            .state
            .custom_presets
            .iter()
            .enumerate()
            .filter(|(i, p)| *i != index && p.inherits == name && p.kind == kind)
            .map(|(_, p)| p)
            .collect();
        if !dependants.is_empty() {
            let mut list = Units::default();
            for (i, p) in dependants.iter().enumerate() {
                if i > 0 {
                    list = list.s(", ");
                }
                list = list.q(&p.name);
            }
            return Ok(failed(vec![issue(
                IssueCode::DependentPreset,
                key("$.customPresets"),
                u(&json_stringify(&Value::String(name.to_vec())))
                    .s(" is the base of ")
                    .u(&list.0)
                    .s(".")
                    .0,
            )]));
        }
        let mut candidate = self.state.clone();
        candidate.custom_presets.remove(index);
        self.apply_state(candidate, &key("$.customPresets"), Vec::new(), host)
    }

    /// `composeCatalog`: the system data, uninstalled printers hidden (not
    /// removed: variants inherit from one another), custom presets appended.
    pub fn compose_catalog(&self) -> Value {
        let configured = self.is_configured();
        let installed = self.installed_index();
        let mut composed: BTreeMap<Vec<u16>, [Vec<Value>; 3]> = BTreeMap::new();
        for (vendor, group) in &self.system {
            let target = composed.entry(vendor.clone()).or_default();
            let Value::Object(group) = group else {
                continue;
            };
            for (slot, kind) in Kind::ALL.iter().enumerate() {
                let Some(Value::Array(entries)) = get(group, kind.as_str()) else {
                    continue;
                };
                for entry in entries {
                    target[slot].push(if *kind == Kind::Machine && configured {
                        self.hide_when_not_installed(vendor, entry, &installed)
                    } else {
                        entry.clone()
                    });
                }
            }
        }
        for preset in &self.state.custom_presets {
            let slot = Kind::ALL
                .iter()
                .position(|k| *k == preset.kind)
                .expect("kind");
            composed.entry(preset.vendor.clone()).or_default()[slot].push(custom_payload(preset));
        }
        Value::Object(
            composed
                .into_iter()
                .map(|(vendor, groups)| {
                    let mut group = BTreeMap::new();
                    for (slot, items) in groups.into_iter().enumerate() {
                        group.insert(key(Kind::ALL[slot].as_str()), Value::Array(items));
                    }
                    (vendor, Value::Object(group))
                })
                .collect(),
        )
    }
    fn hide_when_not_installed(
        &self,
        vendor: &[u16],
        entry: &Value,
        installed: &InstalledIndex,
    ) -> Value {
        let Value::Object(fields) = entry else {
            return entry.clone();
        };
        let Some(name) = optional_string(get(fields, "name")) else {
            return entry.clone();
        };
        let Some(node) = super::presets::preset_id(vendor, Kind::Machine, &name)
            .ok()
            .and_then(|id| self.system_graph.get(&id))
        else {
            return entry.clone();
        };
        let (Some(model), Some(variant)) = (model_of(node), variant_of(node)) else {
            return entry.clone();
        };
        if installed
            .get(&(vendor.to_vec(), model))
            .is_some_and(|v| v.contains(&variant))
        {
            return entry.clone();
        }
        let mut hidden = fields.clone();
        hidden.insert(key("instantiation"), Value::String(key("false")));
        Value::Object(hidden)
    }

    /// `exportBundle`: deterministic, reviewable JSON (sorted keys).
    pub fn export_bundle(&self, exported_at: &[u16]) -> Vec<u16> {
        let mut bundle = state_fields(&self.state);
        bundle.remove(&key("schemaVersion"));
        bundle.insert(key("format"), Value::String(key(BUNDLE_FORMAT)));
        bundle.insert(key("schemaVersion"), Value::Number(SCHEMA_VERSION));
        bundle.insert(key("exportedAt"), Value::String(exported_at.to_vec()));
        bundle.insert(
            key("engine"),
            object([
                ("repository", text(ENGINE_REPOSITORY)),
                ("commit", text(ENGINE_COMMIT)),
            ]),
        );
        bundle.insert(
            key("catalogFingerprint"),
            Value::String(key(&self.fingerprint)),
        );
        stable_stringify(&Value::Object(bundle))
    }
    /// The persisted state (`PresetLibraryStore.save`).
    pub fn state_json(&self) -> Vec<u16> {
        stable_stringify(&Value::Object(state_fields(&self.state)))
    }
    /// `importBundle`: replace the library atomically from a parsed bundle;
    /// `None` is text that is not JSON.
    pub fn import_bundle<H: LibraryHost>(
        &mut self,
        parsed: Option<&Value>,
        host: &mut H,
    ) -> Result<Outcome, H::Error> {
        let Some(parsed) = parsed else {
            return Ok(failed(vec![issue(
                IssueCode::InvalidBundle,
                key("$"),
                key("Bundle is not valid JSON."),
            )]));
        };
        let Value::Object(bundle) = parsed else {
            return Ok(failed(vec![issue(
                IssueCode::InvalidBundle,
                key("$"),
                key("Bundle must be a JSON object."),
            )]));
        };
        if !matches!(get(bundle, "format"), Some(Value::String(f)) if *f == key(BUNDLE_FORMAT)) {
            return Ok(failed(vec![issue(
                IssueCode::InvalidBundle,
                key("$.format"),
                s("Bundle format must be ").q(&key(BUNDLE_FORMAT)).s(".").0,
            )]));
        }
        if !matches!(get(bundle, "schemaVersion"), Some(Value::Number(v)) if *v == SCHEMA_VERSION) {
            return Ok(failed(vec![issue(
                IssueCode::UnsupportedSchema,
                key("$.schemaVersion"),
                s("Bundle schema version ")
                    .u(&js_string(get(bundle, "schemaVersion")))
                    .s(&format!(
                        " is not supported by this build (expected {}).",
                        number_to_string(SCHEMA_VERSION)
                    ))
                    .0,
            )]));
        }
        let commit = match get(bundle, "engine") {
            Some(Value::Object(engine)) => optional_string(get(engine, "commit")),
            _ => None,
        };
        if commit.as_deref() != Some(key(ENGINE_COMMIT).as_slice()) {
            return Ok(failed(vec![issue(
                IssueCode::EngineMismatch,
                key("$.engine.commit"),
                s("Bundle was exported against engine ")
                    .u(&commit.unwrap_or_else(|| key("unknown")))
                    .s(&format!("; this build is pinned to {ENGINE_COMMIT}."))
                    .0,
            )]));
        }
        let mut fields = JsonObject::new();
        fields.insert(key("schemaVersion"), Value::Number(SCHEMA_VERSION));
        fields.insert(
            key("catalogFingerprint"),
            Value::String(key(&self.fingerprint)),
        );
        for name in ["installed", "customPresets"] {
            if let Some(value) = get(bundle, name) {
                fields.insert(key(name), value.clone());
            }
        }
        let mut issues = Vec::new();
        let Some(state) = parse_state(&Value::Object(fields), &mut issues, host)? else {
            return Ok(failed(issues));
        };
        self.apply_state(state, &key("$"), issues, host)
    }

    /// `planCatalogUpdate`: what a newer system catalog would do, applying
    /// nothing.
    pub fn plan_catalog_update<H: LibraryHost>(
        &self,
        next: &Value,
        host: &mut H,
    ) -> Result<UpdatePlan, H::Error> {
        let next_graph = match PresetGraph::build(next, &mut ByHost(host)) {
            Ok(graph) => graph,
            Err(error) => {
                return Ok(UpdatePlan {
                    previous_fingerprint: self.fingerprint.clone(),
                    next_fingerprint: String::new(),
                    changed: false,
                    added_models: Vec::new(),
                    removed_models: Vec::new(),
                    removed_variants: Vec::new(),
                    orphaned_custom_presets: Vec::new(),
                    issues: graph_issues(error, &key("$"))?,
                    applicable: false,
                });
            }
        };
        let next_fingerprint = fingerprint(&next_graph);
        let current = model_keys(&self.system_graph);
        let upcoming = model_keys(&next_graph);
        let mut added: Vec<Lineage> = upcoming
            .iter()
            .filter(|(k, _)| !current.iter().any(|(c, _)| c == k))
            .map(|(_, l)| l.clone())
            .collect();
        let mut removed: Vec<Lineage> = current
            .iter()
            .filter(|(k, _)| !upcoming.iter().any(|(c, _)| c == k))
            .map(|(_, l)| l.clone())
            .collect();
        let next_variants = variant_keys(&next_graph);
        let mut removed_variants = Vec::new();
        for entry in &self.state.installed {
            for variant in &entry.variants {
                if !next_variants.contains(&(
                    entry.vendor.clone(),
                    entry.model.clone(),
                    variant.clone(),
                )) {
                    removed_variants.push(Lineage {
                        vendor: entry.vendor.clone(),
                        kind: Kind::Machine,
                        name: u(&entry.model).s(" ").u(variant).0,
                    });
                }
            }
        }
        let next_names: BTreeSet<(Kind, Vec<u16>)> = next_graph
            .list(None)
            .map(|n| (n.kind, n.name.clone()))
            .collect();
        let mut orphaned = Vec::new();
        for (i, preset) in self.state.custom_presets.iter().enumerate() {
            // A base that is another custom preset travels with it.
            let derived_from_custom = self
                .state
                .custom_presets
                .iter()
                .enumerate()
                .any(|(j, c)| j != i && c.kind == preset.kind && c.name == preset.inherits);
            if !next_names.contains(&(preset.kind, preset.inherits.clone())) && !derived_from_custom
            {
                orphaned.push(Lineage {
                    vendor: preset.vendor.clone(),
                    kind: preset.kind,
                    name: preset.name.clone(),
                });
            }
        }
        let mut issues = Vec::new();
        for lineage in &removed_variants {
            issues.push(warning(
                IssueCode::UnknownPrinterVariant,
                key("$.installed"),
                u(&lineage.vendor)
                    .s(" ")
                    .u(&lineage.name)
                    .s(" is no longer in the catalog and would be uninstalled.")
                    .0,
            ));
        }
        for lineage in &orphaned {
            issues.push(issue(
                IssueCode::UnknownBasePreset,
                key("$.customPresets"),
                u(&json_stringify(&Value::String(lineage.name.clone())))
                    .s(" inherits a preset the new catalog no longer contains; re-base it before updating.")
                    .0,
            ));
        }
        for list in [
            &mut added,
            &mut removed,
            &mut removed_variants,
            &mut orphaned,
        ] {
            sort_by(list, |a, b| compare_lineage(host, a, b))?;
        }
        let applicable = !issues.iter().any(|i| i.error);
        Ok(UpdatePlan {
            changed: next_fingerprint != self.fingerprint,
            previous_fingerprint: self.fingerprint.clone(),
            next_fingerprint,
            added_models: added,
            removed_models: removed,
            removed_variants,
            orphaned_custom_presets: orphaned,
            issues,
            applicable,
        })
    }
    /// `applyCatalogUpdate`: move onto a newer catalog, dropping installations
    /// it no longer offers; a plan with blocking issues is refused.
    pub fn apply_catalog_update<H: LibraryHost>(
        &self,
        next: &Value,
        host: &mut H,
    ) -> Result<(Outcome, Option<Library>), H::Error> {
        let plan = self.plan_catalog_update(next, host)?;
        if !plan.applicable {
            return Ok((failed(plan.issues), None));
        }
        let graph = match PresetGraph::build(next, &mut ByHost(host)) {
            Ok(graph) => graph,
            Err(BuildError::Collation(e)) => return Err(e),
            Err(_) => unreachable!("the plan built this catalog"),
        };
        let next_variants = variant_keys(&graph);
        let installed: Vec<Installed> = self
            .state
            .installed
            .iter()
            .map(|e| Installed {
                vendor: e.vendor.clone(),
                model: e.model.clone(),
                variants: e
                    .variants
                    .iter()
                    .filter(|v| {
                        next_variants.contains(&(e.vendor.clone(), e.model.clone(), (*v).clone()))
                    })
                    .cloned()
                    .collect(),
            })
            .filter(|e| !e.variants.is_empty())
            .collect();
        let Value::Object(system) = next else {
            unreachable!("a built catalog is an object")
        };
        let mut library = match Self::new(system.clone(), graph, host) {
            Ok(library) => library,
            Err(BuildError::Collation(e)) => return Err(e),
            Err(_) => unreachable!("an empty library composes its system catalog"),
        };
        let candidate = LibraryState {
            catalog_fingerprint: library.fingerprint.clone(),
            installed,
            custom_presets: self.state.custom_presets.clone(),
        };
        let applied = library.apply_state(candidate, &key("$"), Vec::new(), host)?;
        if !applied.ok {
            let mut issues = plan.issues;
            issues.extend(applied.issues);
            return Ok((failed(issues), None));
        }
        Ok((
            Outcome {
                ok: true,
                issues: plan.issues,
            },
            Some(library),
        ))
    }

    /// The one write path: normalize, then prove by rebuilding the composed
    /// graph. A rejection leaves the library exactly as it was.
    fn apply_state<H: LibraryHost>(
        &mut self,
        candidate: LibraryState,
        path: &[u16],
        mut issues: Vec<Issue>,
        host: &mut H,
    ) -> Result<Outcome, H::Error> {
        let installed = self.normalize_installed(
            &candidate.installed,
            &u(path).s(".installed").0,
            &mut issues,
            host,
        )?;
        let presets = self.normalize_presets(
            &candidate.custom_presets,
            &u(path).s(".customPresets").0,
            &mut issues,
            host,
        )?;
        if issues.iter().any(|i| i.error) {
            return Ok(failed(issues));
        }
        let previous = std::mem::replace(
            &mut self.state,
            LibraryState {
                catalog_fingerprint: self.fingerprint.clone(),
                installed,
                custom_presets: presets,
            },
        );
        match PresetGraph::build(&self.compose_catalog(), &mut ByHost(host)) {
            Ok(graph) => {
                self.composed = graph;
                Ok(Outcome { ok: true, issues })
            }
            Err(error) => {
                self.state = previous;
                issues.extend(graph_issues(error, path)?);
                Ok(failed(issues))
            }
        }
    }

    /// `normalizeInstalled`: trimmed known models and variants, one entry per
    /// model, variants and models in catalog order.
    fn normalize_installed<H: LibraryHost>(
        &self,
        selections: &[Installed],
        path: &[u16],
        issues: &mut Vec<Issue>,
        host: &mut H,
    ) -> Result<Vec<Installed>, H::Error> {
        let mut by_model: Vec<Installed> = Vec::new();
        for (index, entry) in selections.iter().enumerate() {
            let at = u(path).s(&format!("[{index}]")).0;
            let vendor = trimmed(&entry.vendor);
            let model = trimmed(&entry.model);
            let Some(available) = self.variants_for_model(&vendor, &model) else {
                let or_empty = |t: &[u16]| {
                    if t.is_empty() {
                        key("(empty)")
                    } else {
                        t.to_vec()
                    }
                };
                issues.push(issue(
                    IssueCode::UnknownPrinterModel,
                    at,
                    u(&or_empty(&vendor))
                        .s(" ")
                        .u(&or_empty(&model))
                        .s(" is not in the catalog.")
                        .0,
                ));
                continue;
            };
            let position = match by_model
                .iter()
                .position(|e| e.vendor == vendor && e.model == model)
            {
                Some(p) => p,
                None => {
                    by_model.push(Installed {
                        vendor: vendor.clone(),
                        model: model.clone(),
                        variants: Vec::new(),
                    });
                    by_model.len() - 1
                }
            };
            for variant in &entry.variants {
                let normalized = trimmed(variant);
                if !available.contains(&normalized) {
                    let mut sorted = available.clone();
                    sort_by(&mut sorted, |a, b| compare_variants(host, a, b))?;
                    let mut list = Units::default();
                    for (i, v) in sorted.iter().enumerate() {
                        if i > 0 {
                            list = list.s(", ");
                        }
                        list = list.u(v);
                    }
                    issues.push(issue(
                        IssueCode::UnknownPrinterVariant,
                        at.clone(),
                        u(&vendor)
                            .s(" ")
                            .u(&model)
                            .s(" has no ")
                            .q(&normalized)
                            .s(" variant (available: ")
                            .u(&list.0)
                            .s(").")
                            .0,
                    ));
                    continue;
                }
                let variants = &mut by_model[position].variants;
                if !variants.contains(&normalized) {
                    variants.push(normalized);
                }
            }
        }
        let mut result: Vec<Installed> = by_model
            .into_iter()
            .filter(|e| !e.variants.is_empty())
            .collect();
        for entry in &mut result {
            sort_by(&mut entry.variants, |a, b| compare_variants(host, a, b))?;
        }
        sort_by(&mut result, |a, b| {
            match host.compare(&a.vendor, &b.vendor)? {
                Ordering::Equal => host.compare(&a.model, &b.model),
                order => Ok(order),
            }
        })?;
        Ok(result)
    }

    /// `normalizeCustomPresets`: the valid presets, duplicates refused.
    fn normalize_presets<H: LibraryHost>(
        &self,
        presets: &[CustomPreset],
        path: &[u16],
        issues: &mut Vec<Issue>,
        host: &mut H,
    ) -> Result<Vec<CustomPreset>, H::Error> {
        let mut accepted: Vec<CustomPreset> = Vec::new();
        let mut seen = BTreeSet::new();
        for (index, preset) in presets.iter().enumerate() {
            let at = u(path).s(&format!("[{index}]")).0;
            let identity = (preset.vendor.clone(), preset.kind, preset.name.clone());
            if seen.contains(&identity) {
                issues.push(issue(
                    IssueCode::DuplicatePresetName,
                    at,
                    s("Duplicate custom preset ").q(&preset.name).s(".").0,
                ));
                continue;
            }
            if let Some(valid) =
                self.validate_record(preset.clone(), &accepted, &at, issues, host)?
            {
                seen.insert(identity);
                accepted.push(valid);
            }
        }
        Ok(accepted)
    }

    /// `buildRecord`: a draft as a stamped record over its base.
    fn build_record<H: LibraryHost>(
        &self,
        draft: &Draft,
        replacing: Option<usize>,
        issues: &mut Vec<Issue>,
        host: &mut H,
    ) -> Result<Option<CustomPreset>, H::Error> {
        let now = host.now();
        let or_default = |value: &Option<Vec<u16>>, default: &str| {
            let t = trimmed(value.as_deref().unwrap_or(&key(default)));
            if t.is_empty() { key(default) } else { t }
        };
        let vendor = or_default(&draft.vendor, CUSTOM_VENDOR);
        let peers: Vec<CustomPreset> = self
            .state
            .custom_presets
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != replacing)
            .map(|(_, p)| p.clone())
            .collect();
        let base_vendor = match self.find_base(draft.kind, &draft.inherits, &peers) {
            None => vendor.clone(),
            Some(Base::Node(node)) => node.vendor.clone(),
            Some(Base::Custom(record)) => record.vendor.clone(),
        };
        let note = draft.note.as_deref().map(trimmed).filter(|n| !n.is_empty());
        let record = CustomPreset {
            vendor,
            kind: draft.kind,
            name: trimmed(&draft.name),
            inherits: trimmed(&draft.inherits),
            overrides: draft.overrides.clone().unwrap_or_default(),
            provenance: Provenance {
                source: draft.source.unwrap_or(ProvenanceSource::UserDerived),
                license: or_default(&draft.license, DEFAULT_LICENSE),
                version: or_default(&draft.version, DEFAULT_VERSION),
                derived_from: Lineage {
                    vendor: base_vendor,
                    kind: draft.kind,
                    name: trimmed(&draft.inherits),
                },
                created_at: replacing
                    .map(|i| self.state.custom_presets[i].provenance.created_at.clone())
                    .unwrap_or_else(|| now.clone()),
                updated_at: now,
                note,
            },
        };
        self.validate_record(record, &peers, &key("$.customPresets"), issues, host)
    }

    /// `validateRecord`.
    fn validate_record<H: LibraryHost>(
        &self,
        record: CustomPreset,
        peers: &[CustomPreset],
        path: &[u16],
        issues: &mut Vec<Issue>,
        host: &mut H,
    ) -> Result<Option<CustomPreset>, H::Error> {
        let before = issues.len();
        let kind = record.kind.as_str();
        let name = trimmed(&record.name);
        let at = |field: &str| u(path).s(field).0;
        if name.is_empty() {
            issues.push(issue(
                IssueCode::InvalidName,
                at(".name"),
                key("A custom preset needs a name."),
            ));
        } else if name.len() > MAX_NAME_UNITS {
            issues.push(issue(
                IssueCode::InvalidName,
                at(".name"),
                key(&format!(
                    "Preset names are limited to {MAX_NAME_UNITS} characters."
                )),
            ));
        } else if self
            .system_graph
            .list(Some(record.kind))
            .any(|n| n.name == name)
        {
            issues.push(issue(
                IssueCode::DuplicatePresetName,
                at(".name"),
                u(&json_stringify(&Value::String(name.clone())))
                    .s(&format!(
                        " is already a system {kind} preset. Choose a different name."
                    ))
                    .0,
            ));
        } else if peers
            .iter()
            .any(|p| p.kind == record.kind && p.name == name && p.vendor == record.vendor)
        {
            issues.push(issue(
                IssueCode::DuplicatePresetName,
                at(".name"),
                u(&json_stringify(&Value::String(name.clone())))
                    .s(&format!(" is already a custom {kind} preset."))
                    .0,
            ));
        }
        match self.find_base(record.kind, &record.inherits, peers) {
            None => issues.push(issue(
                IssueCode::UnknownBasePreset,
                at(".inherits"),
                s(&format!("No {kind} preset named "))
                    .q(&record.inherits)
                    .s(" to inherit from.")
                    .0,
            )),
            Some(Base::Node(node)) if !node.is_visible => issues.push(issue(
                IssueCode::BaseNotInstantiable,
                at(".inherits"),
                u(&json_stringify(&Value::String(record.inherits.clone())))
                    .s(" is a non-instantiable template; derive from a selectable preset.")
                    .0,
            )),
            Some(Base::Custom(_)) if would_cycle(&record, peers) => issues.push(issue(
                IssueCode::InvalidState,
                at(".inherits"),
                key("A custom preset may not inherit from itself."),
            )),
            _ => {}
        }
        self.validate_overrides(&record.overrides, record.kind, path, issues);
        validate_provenance(&record.provenance, path, issues, host)?;
        if issues.len() != before {
            return Ok(None);
        }
        Ok(Some(CustomPreset {
            name,
            inherits: trimmed(&record.inherits),
            ..record
        }))
    }
    /// `findBase`: a system preset of the kind, else an earlier custom one.
    fn find_base<'a>(
        &'a self,
        kind: Kind,
        name: &[u16],
        peers: &'a [CustomPreset],
    ) -> Option<Base<'a>> {
        let name = trim_utf16(name);
        if name.is_empty() {
            return None;
        }
        if let Some(node) = self.system_graph.list(Some(kind)).find(|n| n.name == name) {
            return Some(Base::Node(node));
        }
        peers
            .iter()
            .find(|p| p.kind == kind && p.name == name)
            .map(Base::Custom)
    }
    /// `validateOverrides`: no library-owned keys, only keys a system preset
    /// of the kind defines, and bounded JSON.
    fn validate_overrides(
        &self,
        overrides: &JsonObject,
        kind: Kind,
        path: &[u16],
        issues: &mut Vec<Issue>,
    ) {
        let permitted = &self.allowed[&kind];
        for name in js_keys(overrides) {
            let value = &overrides[name];
            let at = u(path).s(".overrides.").u(name).0;
            if RESERVED_KEYS.iter().any(|k| key(k) == *name) {
                issues.push(issue(
                    IssueCode::ReservedKey,
                    at,
                    u(name)
                        .s(" is owned by the preset library and cannot be overridden.")
                        .0,
                ));
                continue;
            }
            if !permitted.contains(name) {
                issues.push(issue(
                    IssueCode::UnknownPresetKey,
                    at,
                    s(&format!("No system {} preset defines ", kind.as_str()))
                        .q(name)
                        .s(&format!(
                            "; a {} preset holding it would never be read.",
                            kind.as_str()
                        ))
                        .0,
                ));
                continue;
            }
            validate_json(value, &at, issues, 0);
        }
    }
}

fn unknown_preset(kind: Kind, name: &[u16]) -> Issue {
    issue(
        IssueCode::UnknownPreset,
        key("$.customPresets"),
        s(&format!("No custom {} preset named ", kind.as_str()))
            .q(name)
            .s(".")
            .0,
    )
}
/// `validateJsonValue`: at most eight levels deep.
fn validate_json(value: &Value, path: &[u16], issues: &mut Vec<Issue>, depth: usize) {
    if depth > 8 {
        issues.push(issue(
            IssueCode::InvalidValue,
            path.to_vec(),
            key("Value is nested too deeply."),
        ));
        return;
    }
    match value {
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                validate_json(item, &u(path).s(&format!("[{i}]")).0, issues, depth + 1);
            }
        }
        Value::Object(fields) => {
            for k in js_keys(fields) {
                validate_json(&fields[k], &u(path).s(".").u(k).0, issues, depth + 1);
            }
        }
        // Canonical numbers are finite.
        _ => {}
    }
}
/// `validateProvenance`.
fn validate_provenance<H: LibraryHost>(
    p: &Provenance,
    path: &[u16],
    issues: &mut Vec<Issue>,
    host: &mut H,
) -> Result<(), H::Error> {
    for (name, value) in [("license", &p.license), ("version", &p.version)] {
        if trim_utf16(value).is_empty() {
            issues.push(issue(
                IssueCode::InvalidProvenance,
                u(path).s(".provenance.").s(name).0,
                key(&format!("A custom preset must declare a {name}.")),
            ));
        }
    }
    for (name, value) in [("createdAt", &p.created_at), ("updatedAt", &p.updated_at)] {
        if !host.timestamp(value)? {
            issues.push(issue(
                IssueCode::InvalidProvenance,
                u(path).s(".provenance.").s(name).0,
                key(&format!("{name} must be an ISO-8601 timestamp.")),
            ));
        }
    }
    if trim_utf16(&p.derived_from.name).is_empty() {
        issues.push(issue(
            IssueCode::InvalidProvenance,
            u(path).s(".provenance.derivedFrom").0,
            key("Provenance must name the preset it derives from."),
        ));
    }
    Ok(())
}
/// `wouldCycle`: following custom bases returns to this preset.
fn would_cycle(record: &CustomPreset, peers: &[CustomPreset]) -> bool {
    let mut seen = BTreeSet::from([record.name.clone()]);
    let mut cursor = record.inherits.clone();
    for _ in 0..64 {
        if !seen.insert(cursor.clone()) {
            return true;
        }
        match peers
            .iter()
            .find(|p| p.kind == record.kind && p.name == cursor)
        {
            Some(next) => cursor = next.inherits.clone(),
            None => return false,
        }
    }
    true
}

/// What the browser store hands `create` for stored text it cannot parse: a
/// schema this build refuses, so the library starts empty and says why.
pub fn unreadable_state() -> Value {
    object([("schemaVersion", Value::Number(-1.0))])
}

/// `String(value)`, where an absent member is `undefined`.
fn js_string(value: Option<&Value>) -> Vec<u16> {
    match value {
        None => key("undefined"),
        Some(v) => value_to_string(v),
    }
}
/// `JSON.stringify(value)`, where an absent member prints `undefined`.
fn json_or_undefined(value: Option<&Value>) -> Vec<u16> {
    value.map_or_else(|| key("undefined"), json_stringify)
}
fn text(value: &str) -> Value {
    Value::String(key(value))
}
fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(fields.into_iter().map(|(k, v)| (key(k), v)).collect())
}
fn kind_of(value: Option<&Value>) -> Option<Kind> {
    let Some(Value::String(t)) = value else {
        return None;
    };
    Kind::ALL.into_iter().find(|k| key(k.as_str()) == *t)
}

/// `parseLibraryState`: persisted or bundled state; unreadable entries are
/// reported and skipped, a wrong shape refuses the whole state.
fn parse_state<H: LibraryHost>(
    input: &Value,
    issues: &mut Vec<Issue>,
    host: &mut H,
) -> Result<Option<LibraryState>, H::Error> {
    let Value::Object(fields) = input else {
        issues.push(issue(
            IssueCode::InvalidState,
            key("$"),
            key("Stored preset library must be an object."),
        ));
        return Ok(None);
    };
    if !matches!(get(fields, "schemaVersion"), Some(Value::Number(v)) if *v == SCHEMA_VERSION) {
        issues.push(issue(
            IssueCode::UnsupportedSchema,
            key("$.schemaVersion"),
            s("Stored preset library uses schema version ")
                .u(&js_string(get(fields, "schemaVersion")))
                .s(&format!(
                    "; this build reads {}.",
                    number_to_string(SCHEMA_VERSION)
                ))
                .0,
        ));
        return Ok(None);
    }
    let mut installed = Vec::new();
    match get(fields, "installed") {
        None => {}
        Some(Value::Array(entries)) => {
            for (index, entry) in entries.iter().enumerate() {
                let at = key(&format!("$.installed[{index}]"));
                let Value::Object(entry) = entry else {
                    issues.push(issue(
                        IssueCode::InvalidState,
                        at,
                        key("Installed entry must be an object."),
                    ));
                    continue;
                };
                let variants = match get(entry, "variants") {
                    Some(Value::Array(items)) => Some(
                        items
                            .iter()
                            .filter_map(|v| match v {
                                Value::String(t) => Some(t.clone()),
                                _ => None,
                            })
                            .collect(),
                    ),
                    _ => None,
                };
                match (
                    optional_string(get(entry, "vendor")),
                    optional_string(get(entry, "model")),
                    variants,
                ) {
                    (Some(vendor), Some(model), Some(variants)) => installed.push(Installed {
                        vendor,
                        model,
                        variants,
                    }),
                    _ => issues.push(issue(
                        IssueCode::InvalidState,
                        at,
                        key("Installed entry needs vendor, model, and string variants."),
                    )),
                }
            }
        }
        Some(_) => {
            issues.push(issue(
                IssueCode::InvalidState,
                key("$.installed"),
                key("installed must be an array."),
            ));
            return Ok(None);
        }
    }
    let mut custom_presets = Vec::new();
    match get(fields, "customPresets") {
        None => {}
        Some(Value::Array(entries)) => {
            for (index, entry) in entries.iter().enumerate() {
                let at = key(&format!("$.customPresets[{index}]"));
                let Value::Object(entry) = entry else {
                    issues.push(issue(
                        IssueCode::InvalidState,
                        at,
                        key("Custom preset must be an object."),
                    ));
                    continue;
                };
                let vendor =
                    optional_string(get(entry, "vendor")).unwrap_or_else(|| key(CUSTOM_VENDOR));
                let Some(kind) = kind_of(get(entry, "kind")) else {
                    issues.push(issue(
                        IssueCode::InvalidState,
                        u(&at).s(".kind").0,
                        s("Unknown preset kind ")
                            .u(&json_or_undefined(get(entry, "kind")))
                            .s(".")
                            .0,
                    ));
                    continue;
                };
                let (Some(name), Some(inherits)) = (
                    optional_string(get(entry, "name")),
                    optional_string(get(entry, "inherits")),
                ) else {
                    issues.push(issue(
                        IssueCode::InvalidState,
                        at,
                        key("Custom preset needs a name and an inherits base."),
                    ));
                    continue;
                };
                let overrides = match get(entry, "overrides") {
                    None => JsonObject::new(),
                    Some(Value::Object(o)) => o.clone(),
                    Some(_) => {
                        issues.push(issue(
                            IssueCode::InvalidState,
                            u(&at).s(".overrides").0,
                            key("Overrides must be an object."),
                        ));
                        continue;
                    }
                };
                let Some(provenance) = parse_provenance(
                    get(entry, "provenance"),
                    kind,
                    &vendor,
                    &inherits,
                    &at,
                    issues,
                    host,
                )?
                else {
                    continue;
                };
                custom_presets.push(CustomPreset {
                    vendor,
                    kind,
                    name,
                    inherits,
                    overrides,
                    provenance,
                });
            }
        }
        Some(_) => {
            issues.push(issue(
                IssueCode::InvalidState,
                key("$.customPresets"),
                key("customPresets must be an array."),
            ));
            return Ok(None);
        }
    }
    Ok(Some(LibraryState {
        catalog_fingerprint: optional_string(get(fields, "catalogFingerprint"))
            .map(|t| String::from_utf16_lossy(&t))
            .unwrap_or_default(),
        installed,
        custom_presets,
    }))
}
/// `parseProvenance`: missing lineage falls back to the record's own.
#[allow(clippy::too_many_arguments)]
fn parse_provenance<H: LibraryHost>(
    input: Option<&Value>,
    kind: Kind,
    vendor: &[u16],
    inherits: &[u16],
    path: &[u16],
    issues: &mut Vec<Issue>,
    host: &mut H,
) -> Result<Option<Provenance>, H::Error> {
    let Some(Value::Object(fields)) = input else {
        issues.push(issue(
            IssueCode::InvalidProvenance,
            u(path).s(".provenance").0,
            key("Custom preset must carry provenance metadata."),
        ));
        return Ok(None);
    };
    let lineage = match get(fields, "derivedFrom") {
        Some(Value::Object(l)) => Some(l),
        _ => None,
    };
    let source = if matches!(get(fields, "source"), Some(Value::String(t)) if *t == key("imported"))
    {
        ProvenanceSource::Imported
    } else {
        ProvenanceSource::UserDerived
    };
    let provenance = Provenance {
        source,
        license: optional_string(get(fields, "license")).unwrap_or_default(),
        version: optional_string(get(fields, "version")).unwrap_or_default(),
        derived_from: Lineage {
            vendor: lineage
                .and_then(|l| optional_string(get(l, "vendor")))
                .unwrap_or_else(|| vendor.to_vec()),
            kind,
            name: lineage
                .and_then(|l| optional_string(get(l, "name")))
                .unwrap_or_else(|| inherits.to_vec()),
        },
        created_at: optional_string(get(fields, "createdAt")).unwrap_or_default(),
        updated_at: optional_string(get(fields, "updatedAt")).unwrap_or_default(),
        note: optional_string(get(fields, "note")),
    };
    let before = issues.len();
    validate_provenance(&provenance, path, issues, host)?;
    Ok((issues.len() == before).then_some(provenance))
}

fn units_value(units: &[u16]) -> Value {
    Value::String(units.to_vec())
}
fn provenance_value(p: &Provenance) -> Value {
    let mut fields = JsonObject::new();
    fields.insert(key("source"), text(p.source.as_str()));
    fields.insert(key("license"), units_value(&p.license));
    fields.insert(key("version"), units_value(&p.version));
    fields.insert(
        key("derivedFrom"),
        object([
            ("vendor", units_value(&p.derived_from.vendor)),
            ("kind", text(p.derived_from.kind.as_str())),
            ("name", units_value(&p.derived_from.name)),
        ]),
    );
    fields.insert(key("createdAt"), units_value(&p.created_at));
    fields.insert(key("updatedAt"), units_value(&p.updated_at));
    if let Some(note) = &p.note {
        fields.insert(key("note"), units_value(note));
    }
    Value::Object(fields)
}
/// The state's JSON members (`schemaVersion`, fingerprint, installed, presets).
fn state_fields(state: &LibraryState) -> JsonObject {
    let mut fields = JsonObject::new();
    fields.insert(key("schemaVersion"), Value::Number(SCHEMA_VERSION));
    fields.insert(key("catalogFingerprint"), text(&state.catalog_fingerprint));
    fields.insert(
        key("installed"),
        Value::Array(
            state
                .installed
                .iter()
                .map(|e| {
                    object([
                        ("vendor", units_value(&e.vendor)),
                        ("model", units_value(&e.model)),
                        (
                            "variants",
                            Value::Array(e.variants.iter().map(|v| units_value(v)).collect()),
                        ),
                    ])
                })
                .collect(),
        ),
    );
    fields.insert(
        key("customPresets"),
        Value::Array(
            state
                .custom_presets
                .iter()
                .map(|p| {
                    object([
                        ("vendor", units_value(&p.vendor)),
                        ("kind", text(p.kind.as_str())),
                        ("name", units_value(&p.name)),
                        ("inherits", units_value(&p.inherits)),
                        ("overrides", Value::Object(p.overrides.clone())),
                        ("provenance", provenance_value(&p.provenance)),
                    ])
                })
                .collect(),
        ),
    );
    fields
}
/// `customPresetPayload`: the overrides under the record's identity.
fn custom_payload(preset: &CustomPreset) -> Value {
    let mut fields = preset.overrides.clone();
    fields.insert(key("type"), text(preset.kind.as_str()));
    fields.insert(key("name"), units_value(&preset.name));
    fields.insert(key("inherits"), units_value(&preset.inherits));
    fields.insert(key("from"), text("user"));
    fields.insert(key("instantiation"), text("true"));
    Value::Object(fields)
}
type ModelKey = (Vec<u16>, Vec<u16>);
/// `modelKeys`: each system machine model, in first-seen order.
fn model_keys(graph: &PresetGraph) -> Vec<(ModelKey, Lineage)> {
    let mut models: Vec<(ModelKey, Lineage)> = Vec::new();
    for node in graph.list(Some(Kind::Machine)) {
        if !node.is_system {
            continue;
        }
        let Some(model) = model_of(node) else {
            continue;
        };
        let k = (node.vendor.clone(), model.clone());
        if !models.iter().any(|(m, _)| *m == k) {
            models.push((
                k,
                Lineage {
                    vendor: node.vendor.clone(),
                    kind: Kind::Machine,
                    name: model,
                },
            ));
        }
    }
    models
}
fn variant_keys(graph: &PresetGraph) -> BTreeSet<(Vec<u16>, Vec<u16>, Vec<u16>)> {
    graph
        .list(Some(Kind::Machine))
        .filter(|n| n.is_system)
        .filter_map(|n| Some((n.vendor.clone(), model_of(n)?, variant_of(n)?)))
        .collect()
}

/// `coerceOverrideValue`: typed text in the shape the inherited value uses.
pub fn coerce_override_value(inherited: Option<&Value>, text: &[u16]) -> Value {
    let trimmed = trim_utf16(text);
    match inherited {
        Some(Value::Array(items)) => {
            let numeric = matches!(items.first(), Some(Value::Number(_)));
            Value::Array(
                trimmed
                    .split(|u| *u == u16::from(b','))
                    .map(trim_utf16)
                    .filter(|p| !p.is_empty())
                    .map(|p| {
                        if numeric {
                            number_or_text(p)
                        } else {
                            Value::String(p.to_vec())
                        }
                    })
                    .collect(),
            )
        }
        Some(Value::Number(_)) => number_or_text(trimmed),
        Some(Value::Bool(_)) => {
            Value::Bool(trimmed == key("true").as_slice() || trimmed == key("1").as_slice())
        }
        _ => Value::String(trimmed.to_vec()),
    }
}
/// A number only when `String(parseFloat(text)) === text`.
fn number_or_text(text: &[u16]) -> Value {
    let parsed = parse_float(&String::from_utf16_lossy(text));
    if parsed.is_finite() && key(&number_to_string(parsed)) == text {
        Value::Number(parsed)
    } else {
        Value::String(text.to_vec())
    }
}
/// `formatOverrideValue`: how an inherited value is presented for editing.
pub fn format_override_value(value: Option<&Value>) -> Vec<u16> {
    match value {
        None | Some(Value::Null) | Some(Value::Object(_)) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut out = Vec::new();
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.extend(key(", "));
                }
                out.extend(format_override_value(Some(item)));
            }
            out
        }
        Some(other) => value_to_string(other),
    }
}
