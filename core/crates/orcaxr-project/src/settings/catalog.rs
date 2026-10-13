//! The flattened slicing profile catalog (`web/src/slicer/ProfileLoader.ts`):
//! every visible compatible machine/process/filament combination of a preset
//! graph, with its engine wire configuration. Profiles share their presets'
//! flattened configurations instead of storing one merged copy each.
use super::presets::{
    Assessment, BuildError, Collation, Issue, Kind, PresetGraph, PresetNode, Selection,
    SelectionRequest, Status,
};
use crate::{
    js_math::convert::{json_stringify, trim_utf16, value_to_string},
    slicing::profile::{WireConfig, collection_delimiter},
};
use orcaxr_contracts::canonical::Value;
use std::sync::Arc;

/// Preset metadata that never reaches the engine (`profileKeys.ts`), sorted.
pub const META_KEYS: &[&str] = &[
    "compatible_printers",
    "compatible_printers_condition",
    "compatible_prints",
    "compatible_prints_condition",
    "default_filament_profile",
    "default_print_profile",
    "filament_id",
    "from",
    "inherits",
    "instantiation",
    "is_custom_defined",
    "model_id",
    "name",
    "printer_notes",
    "printer_settings_id",
    "setting_id",
    "type",
    "version",
];
/// The engine keys a flattened profile may carry (`profileKeys.ts`), sorted.
/// Keys outside it can reach options whose enum tables only exist with a full
/// preset bundle loaded, which crashes the engine.
pub const SAFE_KEYS: &[&str] = &[
    "0",
    "1",
    "48x48/PNG, 300x300/PNG",
    "Auto For Flush",
    "ECC_{nozzle_diameter[0]}_{...}.gcode",
    "Manual",
    "Textured PEI Plate",
    "accel_to_decel_enable",
    "accel_to_decel_factor",
    "additional_cooling_fan_speed",
    "auxiliary_fan",
    "bed_exclude_area",
    "before_layer_change_gcode",
    "bottom_shell_layers",
    "bottom_shell_thickness",
    "bottom_surface_pattern",
    "bridge_acceleration",
    "bridge_density",
    "bridge_flow",
    "bridge_speed",
    "change_filament_gcode",
    "close_fan_the_first_x_layers",
    "cool_plate_temp",
    "cool_plate_temp_initial_layer",
    "curr_bed_type",
    "default_acceleration",
    "default_bed_type",
    "default_jerk",
    "default_nozzle_volume_type",
    "deretraction_speed",
    "detect_overhang_wall",
    "dithering_local_z_direct_multicolor",
    "dithering_local_z_infill",
    "dithering_local_z_mode",
    "dithering_local_z_whole_objects",
    "dithering_step_painted_zones_only",
    "dithering_z_step_size",
    "elefant_foot_compensation",
    "elegoolink",
    "enable_arc_fitting",
    "enable_infill_filament_override",
    "enable_pressure_advance",
    "enable_prime_tower",
    "enable_support",
    "eng_plate_temp",
    "eng_plate_temp_initial_layer",
    "extruder_colour",
    "extruder_offset",
    "extruder_type",
    "fan_cooling_layer_time",
    "fan_max_speed",
    "fan_min_speed",
    "fan_speedup_time",
    "filament_colour",
    "filament_cooling_final_speed",
    "filament_cooling_initial_speed",
    "filament_cooling_moves",
    "filament_density",
    "filament_diameter",
    "filament_end_gcode",
    "filament_flow_ratio",
    "filament_is_high_temperature",
    "filament_loading_speed",
    "filament_loading_speed_start",
    "filament_map",
    "filament_map_mode",
    "filament_max_volumetric_speed",
    "filament_minimal_purge_on_wipe_tower",
    "filament_multitool_ramming",
    "filament_multitool_ramming_flow",
    "filament_multitool_ramming_volume",
    "filament_start_gcode",
    "filament_toolchange_delay",
    "filament_type",
    "filament_unloading_speed",
    "filament_unloading_speed_start",
    "filename_format",
    "filter_out_gap_fill",
    "first_layer_height",
    "flush_multiplier",
    "flush_volumes_matrix",
    "framework",
    "gap_fill_target",
    "gap_infill_speed",
    "gcode_flavor",
    "host_type",
    "hot_plate_temp",
    "hot_plate_temp_initial_layer",
    "infill_direction",
    "infill_filament_use_base_first_layers",
    "infill_filament_use_base_last_layers",
    "infill_jerk",
    "infill_wall_overlap",
    "initial_layer_acceleration",
    "initial_layer_infill_speed",
    "initial_layer_jerk",
    "initial_layer_line_width",
    "initial_layer_print_height",
    "initial_layer_speed",
    "inner_wall_acceleration",
    "inner_wall_jerk",
    "inner_wall_line_width",
    "inner_wall_speed",
    "internal_bridge_flow",
    "internal_bridge_speed",
    "internal_solid_infill_line_width",
    "internal_solid_infill_pattern",
    "internal_solid_infill_speed",
    "layer_change_gcode",
    "layer_height",
    "line_width",
    "local_z_wipe_tower_purge_lines",
    "machine_end_gcode",
    "machine_load_filament_time",
    "machine_max_acceleration_e",
    "machine_max_acceleration_extruding",
    "machine_max_acceleration_retracting",
    "machine_max_acceleration_travel",
    "machine_max_acceleration_x",
    "machine_max_acceleration_y",
    "machine_max_acceleration_z",
    "machine_max_jerk_e",
    "machine_max_jerk_x",
    "machine_max_jerk_y",
    "machine_max_jerk_z",
    "machine_max_speed_e",
    "machine_max_speed_x",
    "machine_max_speed_y",
    "machine_max_speed_z",
    "machine_pause_gcode",
    "machine_start_gcode",
    "machine_unload_filament_time",
    "manual_filament_change",
    "min_width_top_surface",
    "mixed_color_layer_height_a",
    "mixed_color_layer_height_b",
    "mixed_filament_advanced_dithering",
    "mixed_filament_component_bias_enabled",
    "mixed_filament_definitions",
    "mixed_filament_gradient_mode",
    "mixed_filament_height_lower_bound",
    "mixed_filament_height_upper_bound",
    "mixed_filament_pointillism_line_gap",
    "mixed_filament_pointillism_pixel_size",
    "mixed_filament_region_collapse",
    "mixed_filament_surface_indentation",
    "no override",
    "nozzle_diameter",
    "nozzle_temperature",
    "nozzle_temperature_initial_layer",
    "nozzle_temperature_range_high",
    "nozzle_temperature_range_low",
    "nozzle_type",
    "nozzle_volume_type",
    "only_one_wall_top",
    "ooze_prevention",
    "outer_wall_acceleration",
    "outer_wall_jerk",
    "outer_wall_line_width",
    "outer_wall_speed",
    "overhang_1_4_speed",
    "overhang_2_4_speed",
    "overhang_3_4_speed",
    "overhang_4_4_speed",
    "overhang_fan_speed",
    "overhang_fan_threshold",
    "precise_outer_wall",
    "precise_z_height",
    "preheat_time",
    "pressure_advance",
    "prime_tower_brim_chamfer",
    "prime_tower_brim_chamfer_max_width",
    "prime_tower_brim_width",
    "prime_tower_enable_framework",
    "prime_tower_width",
    "prime_volume",
    "printable_area",
    "printable_height",
    "printer_model",
    "printer_variant",
    "purge_in_prime_tower",
    "reduce_crossing_wall",
    "reduce_fan_stop_start_freq",
    "reduce_infill_retraction",
    "requires_top_cover",
    "resolution",
    "retract_lift_above",
    "retract_lift_below",
    "retract_when_changing_layer",
    "retraction_length",
    "retraction_minimum_travel",
    "retraction_speed",
    "scan_first_layer",
    "seam_gap",
    "seam_position",
    "single_extruder_multi_material",
    "skirt_distance",
    "slow_down_layer_time",
    "slow_down_min_speed",
    "slowdown_for_curled_perimeters",
    "small_perimeter_speed",
    "small_perimeter_threshold",
    "sparse_infill_acceleration",
    "sparse_infill_density",
    "sparse_infill_line_width",
    "sparse_infill_pattern",
    "sparse_infill_speed",
    "standby_temperature_delta",
    "support_bottom_z_distance",
    "support_interface_bottom_layers",
    "support_interface_spacing",
    "support_interface_speed",
    "support_interface_top_layers",
    "support_line_width",
    "support_object_xy_distance",
    "support_remaining_areas_after_wave_overhangs",
    "support_speed",
    "support_threshold_angle",
    "support_top_z_distance",
    "support_type",
    "temperature_vitrification",
    "template_custom_gcode",
    "textured_plate_temp",
    "textured_plate_temp_initial_layer",
    "thumbnails",
    "thumbnails_format",
    "top_shell_layers",
    "top_shell_thickness",
    "top_surface_acceleration",
    "top_surface_jerk",
    "top_surface_line_width",
    "top_surface_pattern",
    "top_surface_speed",
    "travel_acceleration",
    "travel_jerk",
    "travel_speed",
    "wall_generator",
    "wall_loops",
    "wave_overhang_aux_fan_speed",
    "wave_overhang_corner_angle_threshold",
    "wave_overhang_corner_taper_distance",
    "wave_overhang_corner_taper_enable",
    "wave_overhang_debug_gcode",
    "wave_overhang_end_retract_length",
    "wave_overhang_fan_speed",
    "wave_overhang_floor_aux_fan_speed",
    "wave_overhang_floor_fan_speed",
    "wave_overhang_floor_hilbert_density",
    "wave_overhang_floor_hilbert_layers",
    "wave_overhang_floor_layers",
    "wave_overhang_floor_perimeter_speed",
    "wave_overhang_floor_print_speed",
    "wave_overhang_floor_speed_ramp",
    "wave_overhang_floor_use_hilbert",
    "wave_overhang_flow_mm3_per_mm",
    "wave_overhang_line_spacing",
    "wave_overhang_line_spacing_corner",
    "wave_overhang_max_iterations",
    "wave_overhang_min_angle",
    "wave_overhang_min_layer_time",
    "wave_overhang_min_length",
    "wave_overhang_min_new_area",
    "wave_overhang_min_wave_time",
    "wave_overhang_minimum_width",
    "wave_overhang_nozzle_temp",
    "wave_overhang_outer_perimeters",
    "wave_overhang_pattern",
    "wave_overhang_perimeter_overlap",
    "wave_overhang_perimeter_speed",
    "wave_overhang_print_speed",
    "wave_overhang_seam_mode",
    "wave_overhang_spacing_mode",
    "wave_overhang_travel_speed",
    "wave_overhangs",
    "wave_overhangs_instead_of_bridges",
    "wipe",
    "wipe_distance",
    "wipe_speed",
    "wipe_tower_cone_angle",
    "wipe_tower_extra_rib_length",
    "wipe_tower_extra_spacing",
    "wipe_tower_filament",
    "wipe_tower_no_sparse_layers",
    "wipe_tower_wall_type",
    "wipe_tower_x",
    "wipe_tower_y",
    "z_hop",
];

fn listed(list: &[&str], key: &[u16]) -> bool {
    String::from_utf16(key).is_ok_and(|k| list.binary_search(&k.as_str()).is_ok())
}

/// `flatten`: a preset's effective configuration as engine wire strings,
/// restricted to the safe engine keys. `null` is the empty string.
pub fn flatten(node: &PresetNode) -> WireConfig {
    node.effective
        .iter()
        .filter(|(key, _)| !listed(META_KEYS, key) && listed(SAFE_KEYS, key))
        .map(|(key, value)| {
            let wire = match value {
                Value::Null => Vec::new(),
                Value::Array(items) => {
                    let mut out = Vec::new();
                    for (i, item) in items.iter().enumerate() {
                        if i > 0 {
                            out.push(collection_delimiter(key));
                        }
                        out.extend(value_to_string(item));
                    }
                    out
                }
                Value::Object(_) => json_stringify(value),
                other => value_to_string(other),
            };
            (key.clone(), wire)
        })
        .collect()
}

/// `SlicerProfile`. Its configuration is the machine, process and filament
/// flattenings overlaid in that order.
#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub id: Vec<u16>,
    pub display_name: Vec<u16>,
    pub machine_name: Vec<u16>,
    pub process_name: Vec<u16>,
    /// The filament preset name before its `@` qualifier.
    pub filament_name: Vec<u16>,
    pub filament_preset_name: Vec<u16>,
    pub filament_vendor: Option<Vec<u16>>,
    pub machine_preset_id: String,
    pub process_preset_id: String,
    pub filament_preset_id: String,
    parts: [Arc<WireConfig>; 3],
}
impl Profile {
    /// One key of [`Self::config`], without merging the whole configuration.
    pub fn config_value(&self, key: &str) -> Option<&[u16]> {
        let key: Vec<u16> = key.encode_utf16().collect();
        self.parts
            .iter()
            .rev()
            .find_map(|part| part.get(&key))
            .map(Vec::as_slice)
    }
    /// The machine, process and filament flattenings, in that order.
    pub fn parts(&self) -> &[Arc<WireConfig>; 3] {
        &self.parts
    }
    /// `{ ...machine, ...process, ...filament }`.
    pub fn config(&self) -> WireConfig {
        let mut merged = WireConfig::new();
        for part in &self.parts {
            merged.extend(part.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
        merged
    }
}

names!(DiagnosticCode {
    ProfileCorpusPinnedOverlay => "profile-corpus-pinned-overlay",
    InvalidPresetGraph => "invalid-preset-graph",
    NoCompatibleProcess => "no-compatible-process",
    NoCompatibleFilament => "no-compatible-filament",
    UnresolvedCompatibility => "unresolved-compatibility",
});
/// `ProfileCatalogDiagnostic`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: DiagnosticCode,
    /// `warning` for the provenance note, otherwise `error`.
    pub error: bool,
    pub message: Vec<u16>,
    pub machine_name: Option<Vec<u16>>,
    pub process_name: Option<Vec<u16>>,
    pub preset_id: Option<String>,
}

/// `ProfileCatalogLoadError`: the graph diagnostics of a refused catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError<E> {
    Invalid(Vec<Diagnostic>),
    Collation(E),
}

/// A validated preset graph and its compiled profiles.
#[derive(Debug, Clone, PartialEq)]
pub struct ProfileCatalog {
    graph: PresetGraph,
    profiles: Vec<Profile>,
    diagnostics: Vec<Diagnostic>,
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn concat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
/// `name.split('@')[0].trim()`.
fn short(name: &[u16]) -> Vec<u16> {
    let head = name.split(|u| *u == u16::from(b'@')).next().unwrap_or(&[]);
    trim_utf16(head).to_vec()
}
/// `filamentVendorOf`: the declared `filament_vendor`, trimmed.
fn filament_vendor(node: &PresetNode) -> Option<Vec<u16>> {
    let declared = node.effective.get(&units("filament_vendor"));
    let first = match declared {
        Some(Value::Array(items)) => items.first(),
        other => other,
    };
    match first {
        Some(Value::String(text)) => {
            let trimmed = trim_utf16(text);
            (!trimmed.is_empty()).then(|| trimmed.to_vec())
        }
        _ => None,
    }
}
fn error(code: DiagnosticCode, message: Vec<u16>) -> Diagnostic {
    Diagnostic {
        code,
        error: true,
        message,
        machine_name: None,
        process_name: None,
        preset_id: None,
    }
}
fn graph_diagnostics(issues: &[Issue]) -> Vec<Diagnostic> {
    issues
        .iter()
        .map(|i| {
            error(
                DiagnosticCode::InvalidPresetGraph,
                concat(&[&i.path, &units(": "), &i.message]),
            )
        })
        .collect()
}

impl ProfileCatalog {
    /// `ProfileCatalog.fromRaw`: build the graph, then compile every visible
    /// compatible combination. A refused graph exposes no partial catalog.
    pub fn build<C: Collation>(
        input: &Value,
        collation: &mut C,
    ) -> Result<Self, CatalogError<C::Error>> {
        let graph = match PresetGraph::build(input, collation) {
            Ok(graph) => graph,
            Err(BuildError::Collation(e)) => return Err(CatalogError::Collation(e)),
            Err(BuildError::Graph(issues)) => {
                return Err(CatalogError::Invalid(graph_diagnostics(&issues)));
            }
            Err(BuildError::MalformedUri) => {
                return Err(CatalogError::Invalid(vec![error(
                    DiagnosticCode::InvalidPresetGraph,
                    units("URI malformed"),
                )]));
            }
        };
        let (profiles, diagnostics) = compile(&graph);
        Ok(Self {
            graph,
            profiles,
            diagnostics,
        })
    }
    pub fn graph(&self) -> &PresetGraph {
        &self.graph
    }
    pub fn profiles(&self) -> &[Profile] {
        &self.profiles
    }
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }
    /// `reconcileSelection`: the pinned selection policy, or why it cannot run.
    pub fn reconcile(&self, request: &SelectionRequest) -> Result<Selection, &'static str> {
        self.graph.resolve_selection(request).map_err(|_| {
            "The selected printer preset is no longer available in the validated profile catalog."
        })
    }
}

fn compile(graph: &PresetGraph) -> (Vec<Profile>, Vec<Diagnostic>) {
    let mut profiles = Vec::new();
    let mut diagnostics = vec![Diagnostic {
        code: DiagnosticCode::ProfileCorpusPinnedOverlay,
        error: false,
        message: units(
            "Profile corpus uses exact same-path blobs from the pinned engine tree plus SHA-256-locked OrcaXR target-printer adaptations.",
        ),
        machine_name: None,
        process_name: None,
        preset_id: None,
    }];
    let unresolved = |what: &str,
                      candidate: &PresetNode,
                      machine: &PresetNode,
                      process: &PresetNode,
                      tail: &[u16]| {
        Diagnostic {
            code: DiagnosticCode::UnresolvedCompatibility,
            error: true,
            message: concat(&[
                &units(&format!("Compatibility for {what} ")),
                &candidate.name,
                tail,
                &units(
                    " depends on an engine expression that the browser catalog cannot evaluate.",
                ),
            ]),
            machine_name: Some(machine.name.clone()),
            process_name: Some(process.name.clone()),
            preset_id: Some(candidate.id.clone()),
        }
    };
    let compatible = |a: &Assessment| a.status == Status::Compatible;
    for machine in graph.selectable(Kind::Machine, None) {
        let mut processes = Vec::new();
        for process in graph.selectable(Kind::Process, None) {
            let assessment = graph.assess_printer(process, machine);
            if compatible(&assessment) {
                processes.push(process);
            } else if assessment.status == Status::Unresolved {
                diagnostics.push(unresolved(
                    "process",
                    process,
                    machine,
                    process,
                    &concat(&[&units(" on "), &machine.name]),
                ));
            }
        }
        if processes.is_empty() {
            diagnostics.push(Diagnostic {
                machine_name: Some(machine.name.clone()),
                ..error(
                    DiagnosticCode::NoCompatibleProcess,
                    concat(&[
                        &machine.name,
                        &units(" has no visible compatible process preset in the installed profile corpus."),
                    ]),
                )
            });
            continue;
        }
        let machine_config = Arc::new(flatten(machine));
        for process in processes {
            let mut filaments = Vec::new();
            for filament in graph.selectable(Kind::Filament, None) {
                let printer = graph.assess_printer(filament, machine);
                let print =
                    compatible(&printer).then(|| graph.assess_print(filament, process, machine));
                if compatible(&printer) && print.as_ref().is_some_and(compatible) {
                    filaments.push(filament);
                } else if printer.status == Status::Unresolved
                    || print
                        .as_ref()
                        .is_some_and(|p| p.status == Status::Unresolved)
                {
                    diagnostics.push(unresolved(
                        "filament",
                        filament,
                        machine,
                        process,
                        &concat(&[
                            &units(" with "),
                            &machine.name,
                            &units(" / "),
                            &process.name,
                        ]),
                    ));
                }
            }
            if filaments.is_empty() {
                diagnostics.push(Diagnostic {
                    machine_name: Some(machine.name.clone()),
                    process_name: Some(process.name.clone()),
                    ..error(
                        DiagnosticCode::NoCompatibleFilament,
                        concat(&[
                            &machine.name,
                            &units(" / "),
                            &process.name,
                            &units(" has no visible compatible filament preset in the installed profile corpus."),
                        ]),
                    )
                });
                continue;
            }
            let process_config = Arc::new(flatten(process));
            let process_short = short(&process.name);
            for filament in filaments {
                let filament_short = short(&filament.name);
                let separator = units(" \u{b7} ");
                profiles.push(Profile {
                    id: concat(&[
                        &machine.name,
                        &units("|"),
                        &process.name,
                        &units("|"),
                        &filament.name,
                    ]),
                    display_name: concat(&[
                        &machine.name,
                        &separator,
                        &process_short,
                        &separator,
                        &filament_short,
                    ]),
                    machine_name: machine.name.clone(),
                    process_name: process.name.clone(),
                    filament_name: filament_short,
                    filament_preset_name: filament.name.clone(),
                    filament_vendor: filament_vendor(filament),
                    machine_preset_id: machine.id.clone(),
                    process_preset_id: process.id.clone(),
                    filament_preset_id: filament.id.clone(),
                    parts: [
                        machine_config.clone(),
                        process_config.clone(),
                        Arc::new(flatten(filament)),
                    ],
                });
            }
        }
    }
    (profiles, deduplicate(diagnostics))
}
/// `deduplicateDiagnostics`: keyed by the `|`-joined code, machine, process
/// and preset; the first position keeps the last value.
fn deduplicate(diagnostics: Vec<Diagnostic>) -> Vec<Diagnostic> {
    let key = |d: &Diagnostic| {
        let bar = units("|");
        concat(&[
            &units(d.code.as_str()),
            &bar,
            d.machine_name.as_deref().unwrap_or(&[]),
            &bar,
            d.process_name.as_deref().unwrap_or(&[]),
            &bar,
            &units(d.preset_id.as_deref().unwrap_or("")),
        ])
    };
    let mut unique: Vec<(Vec<u16>, Diagnostic)> = Vec::new();
    for diagnostic in diagnostics {
        let k = key(&diagnostic);
        match unique.iter_mut().find(|(existing, _)| *existing == k) {
            Some((_, slot)) => *slot = diagnostic,
            None => unique.push((k, diagnostic)),
        }
    }
    unique.into_iter().map(|(_, d)| d).collect()
}

impl ProfileCatalog {
    /// `catalogPreflightTarget`: the exact profile of the selected machine,
    /// process and primary filament, then per physical tool the profile with
    /// that machine and process and the head's filament. An inexact or missing
    /// preset leaves its slot unbound for preflight to report. A target with
    /// more than `max_tools` tools is refused instead of allocated.
    pub fn preflight_target(
        &self,
        machine: &str,
        process: &str,
        filament: &str,
        heads: &[Option<String>],
        tool_count: f64,
        max_tools: usize,
    ) -> Result<crate::slicing::profile::Target, crate::slicing::preflight::Error> {
        use crate::slicing::profile::{Profile as TargetProfile, Source, Target};
        // `Array.from({ length })` applies ToLength.
        let length = if tool_count.is_nan() || tool_count <= 0.0 {
            0.0
        } else {
            tool_count.floor()
        };
        if length > max_tools as f64 {
            return Err(crate::slicing::preflight::Error::Limits);
        }
        let find = |filament: &str| {
            self.profiles.iter().find(|p| {
                p.machine_preset_id == machine
                    && p.process_preset_id == process
                    && p.filament_preset_id == filament
            })
        };
        let exact = (!machine.is_empty() && !process.is_empty() && !filament.is_empty())
            .then(|| find(filament))
            .flatten();
        let target = |p: &Profile| TargetProfile {
            machine_preset_id: Some(crate::model::Text::from_utf8(&p.machine_preset_id)),
            process_preset_id: Some(crate::model::Text::from_utf8(&p.process_preset_id)),
            filament_preset_id: Some(crate::model::Text::from_utf8(&p.filament_preset_id)),
            config: p.config(),
        };
        let filaments = (0..length as usize)
            .map(|tool| {
                let head = heads
                    .get(tool)
                    .cloned()
                    .flatten()
                    .filter(|h| !h.is_empty())?;
                exact?;
                find(&head).map(target)
            })
            .collect();
        Ok(Target {
            primary: exact.map(target),
            filaments,
            tool_count,
            source: Source::Catalog,
        })
    }
}
