//! Live profile preflight (`web/src/workspace/ProfilePreflightConstraints.ts`
//! and `AuthoredSlicingTarget.ts`). Only constraints with one exact meaning in
//! the resolved target are derived. A missing required fact fails closed as a
//! blocking diagnostic; a missing optional fact is an omission, never a guess.
use super::preflight::{
    self, BuildVolume, Code, Constraints, Error, Issue, Limits, Preflight, PrinterCapability,
    ToolConstraints, ascii, object, string,
};
use crate::{
    assets::AssetSnapshot,
    ids::PlateId,
    js_math::convert::{
        json_stringify, number_to_string, trim_utf16, utf16_number, value_to_string,
    },
    model::{ConfigMap, ProjectState, Text},
    selection::SelectionRef,
    validation::{Severity, ValidatedProject},
};
use orcaxr_contracts::canonical::Value;
use std::collections::{BTreeMap, BTreeSet};

/// A flattened engine configuration: each value is its engine wire string.
pub type WireConfig = BTreeMap<Vec<u16>, Vec<u16>>;

/// The parts of a `SlicerProfile` the derivation reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Profile {
    pub machine_preset_id: Option<Text>,
    pub process_preset_id: Option<Text>,
    pub filament_preset_id: Option<Text>,
    pub config: WireConfig,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// A catalog selection: every profile must resolve an exact preset.
    Catalog,
    /// An imported project slicing as authored: its own configuration attests.
    AuthoredProject,
}
/// `LiveProfilePreflightTarget`.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub primary: Option<Profile>,
    /// Indexed by canonical physical tool ID.
    pub filaments: Vec<Option<Profile>>,
    pub tool_count: f64,
    pub source: Source,
}

names!(
    /// `LiveProfileConstraintDiagnosticCode`.
    DiagnosticCode {
        MissingExactPrinterProfile => "missing-exact-printer-profile",
        InvalidToolCount => "invalid-tool-count",
        AmbiguousPrintableArea => "ambiguous-printable-area",
        AmbiguousPrintableHeight => "ambiguous-printable-height",
        AmbiguousNozzleMap => "ambiguous-nozzle-map",
        MissingExactFilamentProfile => "missing-exact-filament-profile",
    }
);
names!(
    /// `LiveProfileConstraintOmissionCode`.
    OmissionCode {
        MaterialNotDeclared => "material-not-declared",
        TemperatureLowerBoundNotDeclared => "temperature-lower-bound-not-declared",
        TemperatureUpperBoundNotDeclared => "temperature-upper-bound-not-declared",
        TemperatureRangeInvalid => "temperature-range-invalid",
    }
);
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    pub message: String,
    pub help: &'static str,
    pub path: Option<String>,
    pub tool_id: Option<usize>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Omission {
    pub code: OmissionCode,
    pub message: String,
    pub path: String,
    pub tool_id: usize,
}
/// `LiveProfileConstraintDerivation`.
#[derive(Debug, Clone, PartialEq)]
pub struct Derivation {
    pub constraints: Constraints,
    /// Missing target facts that make a live slice unsafe to submit.
    pub blocking: Vec<Diagnostic>,
    /// Optional constraints absent from the profile; never guessed.
    pub omissions: Vec<Omission>,
}

const AUTHORED_HELP: &str = "This project was imported with its own printer and filament configuration. Re-open it with complete embedded settings, or select a catalog printer, process, and filament to slice against instead.";
const PROFILE_HELP: &str = "Choose a complete catalog-backed printer, process, and filament combination before slicing. No target value is inferred from the scene or a display label.";
const AREA_HELP: &str = "Choose a printer profile with an explicit rectangular printable_area; arbitrary bed polygons are not approximated.";
const HEIGHT_HELP: &str = "Choose a printer profile with an explicit printable_height; a fallback height is not safe for slicing.";
const NOZZLE_HELP: &str = "Select a profile whose nozzle_diameter count matches its tools or specifies one uniform nozzle size.";

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn get<'a>(config: &'a WireConfig, key: &str) -> Option<&'a [u16]> {
    config.get(&units(key)).map(Vec::as_slice)
}
fn safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
}
fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// `deriveLiveProfilePreflightConstraints`. A target declaring more tools
/// than `max_tools` is refused instead of allocated.
pub fn derive(target: &Target, max_tools: usize) -> Result<Derivation, Error> {
    let mut blocking = Vec::new();
    let mut omissions = Vec::new();
    let primary = target.primary.as_ref();
    let authored = target.source == Source::AuthoredProject;
    let diagnostic = |code, message: &str, help, path: Option<&str>, tool_id| Diagnostic {
        code,
        message: message.to_owned(),
        help,
        path: path.map(str::to_owned),
        tool_id,
    };
    if !authored && !exact_identity(primary) {
        blocking.push(diagnostic(
            DiagnosticCode::MissingExactPrinterProfile,
            "The live printer, process, and primary filament selection is not bound to exact catalog presets.",
            PROFILE_HELP,
            None,
            None,
        ));
    }
    if authored && primary.is_none() {
        blocking.push(diagnostic(
            DiagnosticCode::MissingExactPrinterProfile,
            "The imported project does not carry an embedded printer configuration to slice against.",
            AUTHORED_HELP,
            None,
            None,
        ));
    }
    let valid_count = safe_integer(target.tool_count) && target.tool_count >= 1.0;
    if !valid_count {
        blocking.push(diagnostic(
            DiagnosticCode::InvalidToolCount,
            "The live slicing target does not declare a positive physical tool count.",
            PROFILE_HELP,
            Some("printer.toolCount"),
            None,
        ));
    }
    let build_volume = primary.and_then(|p| build_volume(&p.config));
    if let Some(primary) = primary
        && build_volume.is_none()
    {
        if rectangular_area(get(&primary.config, "printable_area")).is_none() {
            blocking.push(diagnostic(
                DiagnosticCode::AmbiguousPrintableArea,
                "The selected printer profile does not declare one axis-aligned rectangular printable area.",
                AREA_HELP,
                Some("config.printable_area"),
                None,
            ));
        }
        if positive_scalar(get(&primary.config, "printable_height")).is_none() {
            blocking.push(diagnostic(
                DiagnosticCode::AmbiguousPrintableHeight,
                "The selected printer profile does not declare one positive printable height.",
                HEIGHT_HELP,
                Some("config.printable_height"),
                None,
            ));
        }
    }
    let tool_count = if valid_count {
        if target.tool_count > max_tools as f64 {
            return Err(Error::Limits);
        }
        target.tool_count as usize
    } else {
        0
    };
    let nozzles = primary.and_then(|p| nozzle_map(&p.config, tool_count));
    if primary.is_some() && tool_count > 0 && nozzles.is_none() {
        blocking.push(diagnostic(
            DiagnosticCode::AmbiguousNozzleMap,
            &format!(
                "The selected printer profile cannot map its nozzle diameters exactly to {tool_count} physical tool{}.",
                plural(tool_count)
            ),
            NOZZLE_HELP,
            Some("config.nozzle_diameter"),
            None,
        ));
    }

    let mut tools = vec![None; tool_count];
    for (tool_id, slot) in tools.iter_mut().enumerate() {
        let tool = tool_id + 1;
        let nozzle = nozzles.as_ref().map(|n| n[tool_id]);
        let filament = target.filaments.get(tool_id).and_then(Option::as_ref);
        // An authored project's embedded filament configuration is its own
        // authority; a catalog target must resolve an exact compatible preset.
        let usable = filament.filter(|f| {
            authored || (exact_identity(Some(f)) && same_machine_and_process(primary, f))
        });
        let Some(filament) = usable else {
            let message = if authored {
                format!(
                    "Physical tool {tool} has no embedded filament configuration in the imported project."
                )
            } else {
                format!("Physical tool {tool} is not bound to an exact compatible filament preset.")
            };
            blocking.push(Diagnostic {
                code: DiagnosticCode::MissingExactFilamentProfile,
                message,
                help: if authored {
                    AUTHORED_HELP
                } else {
                    PROFILE_HELP
                },
                path: Some(format!("filaments.physical[{tool_id}].presetId")),
                tool_id: Some(tool_id),
            });
            if let Some(nozzle) = nozzle {
                *slot = Some(ToolConstraints {
                    nozzle_diameter_mm: Some(nozzle),
                    ..Default::default()
                });
            }
            continue;
        };
        let omit = |omissions: &mut Vec<Omission>, code, message: String, key: &str| {
            omissions.push(Omission {
                code,
                message,
                path: format!("filaments.physical[{tool_id}].config.{key}"),
                tool_id,
            });
        };
        let mut constraint = ToolConstraints {
            nozzle_diameter_mm: nozzle,
            ..Default::default()
        };
        match non_empty_scalar(get(&filament.config, "filament_type")) {
            Some(material) => constraint.supported_materials = Some(vec![Text::new(material)]),
            None => omit(
                &mut omissions,
                OmissionCode::MaterialNotDeclared,
                format!("Filament tool {tool} does not declare one unambiguous filament_type."),
                "filament_type",
            ),
        }
        let lower = finite_scalar(get(&filament.config, "nozzle_temperature_range_low"));
        let upper = finite_scalar(get(&filament.config, "nozzle_temperature_range_high"));
        if lower.is_none() {
            omit(
                &mut omissions,
                OmissionCode::TemperatureLowerBoundNotDeclared,
                format!(
                    "Filament tool {tool} does not declare one nozzle temperature lower bound."
                ),
                "nozzle_temperature_range_low",
            );
        }
        if upper.is_none() {
            omit(
                &mut omissions,
                OmissionCode::TemperatureUpperBoundNotDeclared,
                format!(
                    "Filament tool {tool} does not declare one nozzle temperature upper bound."
                ),
                "nozzle_temperature_range_high",
            );
        }
        if let (Some(lo), Some(hi)) = (lower, upper)
            && hi < lo
        {
            omit(
                &mut omissions,
                OmissionCode::TemperatureRangeInvalid,
                format!("Filament tool {tool} declares a descending nozzle temperature range."),
                "nozzle_temperature_range_low",
            );
        } else {
            constraint.min_hotend_temperature_c = lower;
            constraint.max_hotend_temperature_c = upper;
        }
        *slot = Some(constraint);
    }
    Ok(Derivation {
        constraints: Constraints {
            build_volume,
            tools,
            // The resolved target's own tool count is the only FullSpectrum
            // capability authority; the authoring UI never implies it.
            printer: (tool_count > 0).then_some(PrinterCapability {
                physical_tool_count: tool_count as f64,
                max_total_filaments: None,
            }),
            ..Default::default()
        },
        blocking,
        omissions,
    })
}

fn exact_identity(profile: Option<&Profile>) -> bool {
    profile.is_some_and(|p| {
        [
            &p.machine_preset_id,
            &p.process_preset_id,
            &p.filament_preset_id,
        ]
        .iter()
        .all(|id| {
            id.as_ref()
                .is_some_and(|t| !trim_utf16(t.units()).is_empty())
        })
    })
}
fn same_machine_and_process(primary: Option<&Profile>, filament: &Profile) -> bool {
    let present = |id: &Option<Text>| id.as_ref().is_some_and(|t| !t.units().is_empty());
    primary.is_some_and(|p| {
        present(&p.machine_preset_id)
            && present(&p.process_preset_id)
            && p.machine_preset_id == filament.machine_preset_id
            && p.process_preset_id == filament.process_preset_id
    })
}

fn split_list(value: &[u16]) -> impl Iterator<Item = &[u16]> {
    value.split(|u| *u == u16::from(b';') || *u == u16::from(b','))
}
/// `parseNonEmptyScalar`: one trimmed value without list separators.
fn non_empty_scalar(value: Option<&[u16]>) -> Option<&[u16]> {
    let value = value?;
    let trimmed = trim_utf16(value);
    (!trimmed.is_empty() && split_list(value).count() == 1).then_some(trimmed)
}
fn finite_scalar(value: Option<&[u16]>) -> Option<f64> {
    let n = utf16_number(non_empty_scalar(value)?);
    n.is_finite().then_some(n)
}
fn positive_scalar(value: Option<&[u16]>) -> Option<f64> {
    finite_scalar(value).filter(|n| *n > 0.0)
}
/// `parsePositiveList`: every `;`/`,` entry a positive finite number.
fn positive_list(value: Option<&[u16]>) -> Option<Vec<f64>> {
    let value = value?;
    if trim_utf16(value).is_empty() {
        return None;
    }
    split_list(value)
        .map(|entry| {
            let entry = trim_utf16(entry);
            let n = utf16_number(entry);
            (!entry.is_empty() && n.is_finite() && n > 0.0).then_some(n)
        })
        .collect()
}
/// `parseNozzleMap`: one diameter per tool, or one uniform diameter.
fn nozzle_map(config: &WireConfig, tool_count: usize) -> Option<Vec<f64>> {
    if tool_count < 1 {
        return None;
    }
    let nozzles = positive_list(get(config, "nozzle_diameter"))?;
    match nozzles.len() {
        n if n == tool_count => Some(nozzles),
        1 => Some(vec![nozzles[0]; tool_count]),
        _ => None,
    }
}
fn build_volume(config: &WireConfig) -> Option<BuildVolume> {
    let area = rectangular_area(get(config, "printable_area"))?;
    let height = positive_scalar(get(config, "printable_height"))?;
    Some(BuildVolume {
        min_z_mm: Some(0.0),
        max_z_mm: height,
        ..area
    })
}
/// `parsePoint`: `<x>x<y>` with ASCII decimal coordinates.
fn point(value: &[u16]) -> Option<[f64; 2]> {
    let text = String::from_utf16(trim_utf16(value)).ok()?;
    let (x, y) = text.split_once('x')?;
    let decimal = |s: &str| {
        let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
        let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
        let ascii = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
        let valid = ascii(whole)
            && ascii(fraction)
            && (!whole.is_empty() || (!fraction.is_empty() && digits.contains('.')));
        valid.then(|| number(s)).filter(|n| n.is_finite())
    };
    Some([decimal(x)?, decimal(y)?])
}
fn number(text: &str) -> f64 {
    crate::js_math::convert::number(text)
}
/// `parseRectangularArea`: exactly four distinct axis-aligned corners in
/// boundary order (a closing repeat of the first is dropped).
fn rectangular_area(value: Option<&[u16]>) -> Option<BuildVolume> {
    let value = value?;
    if trim_utf16(value).is_empty() {
        return None;
    }
    let mut points = value
        .split(|u| *u == u16::from(b','))
        .map(point)
        .collect::<Option<Vec<_>>>()?;
    // `===` treats -0 and 0 as equal; so does f64 `==`.
    if points.len() > 1 && points[0] == points[points.len() - 1] {
        points.pop();
    }
    if points.len() != 4 {
        return None;
    }
    // `${x}:${y}` keys print -0 as 0, exactly like an f64 comparison.
    let key = |[x, y]: [f64; 2]| (number_to_string(x), number_to_string(y));
    let unique: BTreeSet<_> = points.iter().copied().map(key).collect();
    if unique.len() != 4 {
        return None;
    }
    // A Set keeps the first of 0 and -0 (SameValueZero).
    let distinct = |axis: usize| {
        let mut values: Vec<f64> = Vec::new();
        for p in &points {
            if !values.contains(&p[axis]) {
                values.push(p[axis]);
            }
        }
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        values
    };
    let (xs, ys) = (distinct(0), distinct(1));
    if xs.len() != 2 || ys.len() != 2 || xs[1] <= xs[0] || ys[1] <= ys[0] {
        return None;
    }
    if !xs
        .iter()
        .all(|x| ys.iter().all(|y| unique.contains(&key([*x, *y]))))
    {
        return None;
    }
    for (index, current) in points.iter().enumerate() {
        let next = points[(index + 1) % points.len()];
        if (current[0] == next[0]) == (current[1] == next[1]) {
            return None;
        }
    }
    Some(BuildVolume {
        min_x_mm: xs[0],
        max_x_mm: xs[1],
        min_y_mm: ys[0],
        max_y_mm: ys[1],
        min_z_mm: None,
        max_z_mm: 0.0,
    })
}

/// `LiveProfileSlicePreflight.evaluate`: blocking profile diagnostics join the
/// canonical result as `missing-profile-attestation` errors.
pub fn attest(canonical: Preflight, derivation: &Derivation, state: &ProjectState) -> Preflight {
    if derivation.blocking.is_empty() {
        return canonical;
    }
    let mut issues = canonical.issues;
    for diagnostic in &derivation.blocking {
        let filament = diagnostic.tool_id.and_then(|tool| {
            state
                .filaments
                .physical
                .iter()
                .find(|f| f.tool_id.get() == tool as f64)
        });
        let entity = filament.map_or(SelectionRef::Project, |f| {
            SelectionRef::Filament(f.id.clone().into())
        });
        let detail = match diagnostic.tool_id {
            None => diagnostic.code.as_str().to_owned(),
            Some(tool) => format!("{}-tool-{tool}", diagnostic.code.as_str()),
        };
        issues.push(Issue {
            id: Text::from_utf8(&format!(
                "slice-preflight:missing-profile-attestation:{detail}"
            )),
            code: Code::MissingProfileAttestation,
            detail: Some(Text::from_utf8(&detail)),
            severity: Severity::Error,
            message: Text::from_utf8(&diagnostic.message),
            help: diagnostic.help,
            path: diagnostic.path.as_deref().map(Text::from_utf8),
            entities: vec![entity],
            actions: vec![],
        });
    }
    preflight::sort_issues(&mut issues);
    let blocking_count = issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .count();
    Preflight {
        can_slice: blocking_count == 0,
        blocking_count,
        issues,
        ..canonical
    }
}

/// Derive constraints from `target`, preflight with them and attest the
/// result: the complete live preflight of one plate.
pub fn preflight_target(
    project: &ValidatedProject,
    assets: &AssetSnapshot,
    plate_id: &PlateId,
    target: &Target,
    limits: Limits,
    max_tools: usize,
    cancelled: impl FnMut() -> bool,
) -> Result<(Preflight, Derivation), Error> {
    let derivation = derive(target, max_tools)?;
    let canonical = preflight::preflight(
        project,
        assets,
        plate_id,
        &derivation.constraints,
        limits,
        cancelled,
    )?;
    Ok((attest(canonical, &derivation, project.state()), derivation))
}

/// `authoredProjectPreflightTarget`: an imported project's own printer and
/// filament configuration (`settingsBaseConfig ?? config`), as engine wire
/// strings, attests its target. No catalog preset is consulted.
pub fn authored_target(state: &ProjectState, max_tools: usize) -> Result<Target, Error> {
    let project = engine_wire_config(state.settings_base_config.as_ref().unwrap_or(&state.config));
    let tool_count = state.printer.tool_count.get();
    // `Array.from({ length })` applies ToLength.
    let length = if tool_count.is_nan() || tool_count <= 0.0 {
        0.0
    } else {
        tool_count.floor()
    };
    if length > max_tools as f64 {
        return Err(Error::Limits);
    }
    // A Map keyed by tool ID keeps the last filament for a repeated tool.
    let mut by_tool = BTreeMap::new();
    for filament in state.filaments.physical.iter() {
        let tool = filament.tool_id.get();
        if tool >= 0.0 && tool.fract() == 0.0 && tool < length {
            by_tool.insert(tool as usize, filament);
        }
    }
    let filaments = (0..length as usize)
        .map(|tool| {
            let filament = by_tool.get(&tool)?;
            let mut config = project_filament_config(&project, tool);
            config.extend(engine_wire_config(&filament.config));
            let filament_type = units("filament_type");
            if !filament.material.units().is_empty() && !config.contains_key(&filament_type) {
                config.insert(filament_type, filament.material.units().to_vec());
            }
            Some(Profile {
                config,
                ..Default::default()
            })
        })
        .collect();
    Ok(Target {
        primary: Some(Profile {
            config: project,
            ..Default::default()
        }),
        filaments,
        tool_count,
        source: Source::AuthoredProject,
    })
}

/// `projectFilamentConfig`: this tool's entry of the project's filament
/// vectors, when the project declares them.
fn project_filament_config(config: &WireConfig, tool: usize) -> WireConfig {
    let mut per_tool = WireConfig::new();
    for key in [
        "filament_type",
        "nozzle_temperature_range_low",
        "nozzle_temperature_range_high",
    ] {
        let Some(value) = get(config, key) else {
            continue;
        };
        let separator = [b';', b',']
            .into_iter()
            .map(u16::from)
            .find(|s| value.contains(s));
        let parts: Vec<&[u16]> = match separator {
            Some(s) => value.split(|u| *u == s).collect(),
            None => vec![value],
        };
        let entry = if parts.len() == 1 {
            Some(parts[0])
        } else {
            parts.get(tool).copied()
        };
        if let Some(entry) = entry.filter(|e| !e.is_empty()) {
            per_tool.insert(units(key), trim_utf16(entry).to_vec());
        }
    }
    per_tool
}

/// PrintConfig string vectors (`coStrings`) join with `;`; every other vector
/// joins with `,` (`configSerialization.ts`, pinned to the engine schema).
pub const STRING_VECTOR_KEYS: &[&str] = &[
    "adaptive_pressure_advance_model",
    "compatible_machine_expression_group",
    "compatible_printers",
    "compatible_prints",
    "compatible_process_expression_group",
    "default_filament_colour",
    "default_filament_profile",
    "different_settings_to_system",
    "extruder_colour",
    "filament_colour",
    "filament_end_gcode",
    "filament_ids",
    "filament_notes",
    "filament_ramming_parameters",
    "filament_settings_id",
    "filament_start_gcode",
    "filament_type",
    "filament_vendor",
    "inherits_group",
    "post_process",
    "preset_names",
    "print_compatible_printers",
    "small_area_infill_flow_compensation_model",
    "thumb0",
    "thumb1",
    "upward_compatible_machine",
];
/// `printConfigCollectionDelimiter`.
pub fn collection_delimiter(key: &[u16]) -> u16 {
    let string_vector = STRING_VECTOR_KEYS
        .iter()
        .any(|k| k.encode_utf16().eq(key.iter().copied()));
    u16::from(if string_vector { b';' } else { b',' })
}

/// `engineWireConfig`: canonical values as engine wire strings. `null` is
/// absent, arrays join with the option's delimiter, objects are JSON.
pub fn engine_wire_config(config: &ConfigMap) -> WireConfig {
    let Value::Object(fields) = config.value() else {
        return WireConfig::new();
    };
    fields
        .iter()
        .filter_map(|(key, value)| {
            let wire = match value {
                Value::Null => return None,
                Value::Array(items) => {
                    let mut out = Vec::new();
                    for (index, item) in items.iter().enumerate() {
                        if index > 0 {
                            out.push(collection_delimiter(key));
                        }
                        out.extend(value_to_string(item));
                    }
                    out
                }
                Value::Object(_) => json_stringify(value),
                other => value_to_string(other),
            };
            Some((key.clone(), wire))
        })
        .collect()
}

fn text_value(text: &str) -> Value {
    Value::String(units(text))
}
impl Profile {
    fn to_value(&self) -> Value {
        let id = |id: &Option<Text>| id.as_ref().map(|t| string(t.units()));
        object([
            ("machinePresetId", id(&self.machine_preset_id)),
            ("processPresetId", id(&self.process_preset_id)),
            ("filamentPresetId", id(&self.filament_preset_id)),
            (
                "config",
                Some(Value::Object(
                    self.config
                        .iter()
                        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                        .collect(),
                )),
            ),
        ])
    }
}
impl Target {
    /// The fields of a `LiveProfilePreflightTarget` the derivation reads.
    pub fn to_value(&self) -> Value {
        let profile = |p: &Option<Profile>| p.as_ref().map_or(Value::Null, Profile::to_value);
        object([
            (
                "source",
                Some(text_value(match self.source {
                    Source::Catalog => "catalog",
                    Source::AuthoredProject => "authored-project",
                })),
            ),
            ("toolCount", Some(Value::Number(self.tool_count))),
            ("primary", Some(profile(&self.primary))),
            (
                "filaments",
                Some(Value::Array(self.filaments.iter().map(profile).collect())),
            ),
        ])
    }
}
impl Derivation {
    /// `LiveProfileConstraintDerivation` as canonical JSON.
    pub fn to_value(&self) -> Value {
        let tool = |t: Option<usize>| t.map(|t| Value::Number(t as f64));
        object([
            ("constraints", Some(self.constraints.to_value())),
            (
                "blockingDiagnostics",
                Some(Value::Array(
                    self.blocking
                        .iter()
                        .map(|d| {
                            object([
                                ("code", Some(ascii(d.code.as_str()))),
                                ("message", Some(text_value(&d.message))),
                                ("help", Some(ascii(d.help))),
                                ("path", d.path.as_deref().map(text_value)),
                                ("toolId", tool(d.tool_id)),
                            ])
                        })
                        .collect(),
                )),
            ),
            (
                "omissions",
                Some(Value::Array(
                    self.omissions
                        .iter()
                        .map(|o| {
                            object([
                                ("code", Some(ascii(o.code.as_str()))),
                                ("message", Some(text_value(&o.message))),
                                ("path", Some(text_value(&o.path))),
                                ("toolId", tool(Some(o.tool_id))),
                            ])
                        })
                        .collect(),
                )),
            ),
        ])
    }
}
