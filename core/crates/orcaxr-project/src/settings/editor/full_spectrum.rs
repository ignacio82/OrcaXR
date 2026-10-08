//! `fullSpectrumSemantics.ts`: the Full Spectrum rules audited against the
//! pinned Snapmaker Orca source, kept apart from the generated table so an
//! engine update fails here until they are reviewed again.
use super::draft::ValueMap;
use super::units;
use crate::{js_math::convert::number_to_string, settings::options::OptionValue};

pub const SOURCE_COMMIT: &str = "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626";
pub const PROJECT_UI_SOURCE_BLOB: &str = "94ad6c3b2357c2f0bd2476265e83ea68babd6a9b";

pub const LOCAL_Z_MODE: &str = "dithering_local_z_mode";
pub const LOCAL_Z_WHOLE_OBJECTS: &str = "dithering_local_z_whole_objects";
pub const LOCAL_Z_INFILL: &str = "dithering_local_z_infill";
pub const LOCAL_Z_DIRECT_MULTICOLOR: &str = "dithering_local_z_direct_multicolor";
pub const HEIGHT_LOWER_BOUND: &str = "mixed_filament_height_lower_bound";
pub const HEIGHT_UPPER_BOUND: &str = "mixed_filament_height_upper_bound";
pub const DEFINITIONS_KEY: &str = "mixed_filament_definitions";

/// Keys whose enablement follows Local-Z mode.
pub const LOCAL_Z_DEPENDENT_KEYS: [&str; 3] = [
    LOCAL_Z_WHOLE_OBJECTS,
    LOCAL_Z_INFILL,
    LOCAL_Z_DIRECT_MULTICOLOR,
];
/// The narrow project-scope overlay proven by pinned `Plater.cpp`.
pub const PROJECT_OVERRIDE_KEYS: [&str; 3] = [
    HEIGHT_LOWER_BOUND,
    HEIGHT_UPPER_BOUND,
    LOCAL_Z_DIRECT_MULTICOLOR,
];

/// `isReviewedFullSpectrumProjectOverride`.
pub fn is_reviewed_project_override(key: &str) -> bool {
    PROJECT_OVERRIDE_KEYS.contains(&key)
}

/// `FullSpectrumSettingsTransactionExpansion`.
#[derive(Debug, Clone, PartialEq)]
pub struct Expansion {
    pub effective: ValueMap,
    /// Implicit child values, in `LOCAL_Z_DEPENDENT_KEYS` order.
    pub implicit: Vec<(&'static str, bool)>,
}
/// Local-Z mode must be a boolean before a transaction is expanded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModeNotBoolean;
impl ModeNotBoolean {
    pub fn message(&self) -> String {
        format!(
            "Effective {LOCAL_Z_MODE} must be boolean before FullSpectrum transaction expansion"
        )
    }
}

/// `expandFullSpectrumSettingsTransaction`: pinned `Tab.cpp:1531-1561`.
/// Enabling Local-Z turns infill subdivision on; disabling it clears every
/// child. Implicit values win over conflicting edits in the same event.
pub fn expand_transaction(
    changed: &[Vec<u16>],
    effective: &ValueMap,
) -> Result<Expansion, ModeNotBoolean> {
    let mut effective = effective.clone();
    let mode = units(LOCAL_Z_MODE);
    if !changed.contains(&mode) {
        return Ok(Expansion {
            effective,
            implicit: Vec::new(),
        });
    }
    let Some(OptionValue::Bool(enabled)) = effective.get(&mode) else {
        return Err(ModeNotBoolean);
    };
    let implicit: Vec<(&'static str, bool)> = if *enabled {
        vec![(LOCAL_Z_INFILL, true)]
    } else {
        LOCAL_Z_DEPENDENT_KEYS.iter().map(|k| (*k, false)).collect()
    };
    for (key, value) in &implicit {
        effective.insert(units(key), OptionValue::Bool(*value));
    }
    Ok(Expansion {
        effective,
        implicit,
    })
}

/// `FullSpectrumDependencyState`: the row stays visible; only its enabled
/// state follows Local-Z mode (`ConfigManipulation.cpp:776-781`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dependency {
    pub key: &'static str,
    pub enabled: bool,
}
impl Dependency {
    pub const CONTROLLER: &'static str = LOCAL_Z_MODE;
    pub const DISABLED_REASON: &'static str = "requires-dithering-local-z-mode";
}
/// `getFullSpectrumDependencyState`; unmanaged keys have no rule.
pub fn dependency(key: &[u16], effective: &ValueMap) -> Option<Dependency> {
    let key = LOCAL_Z_DEPENDENT_KEYS
        .into_iter()
        .find(|k| units(k) == key)?;
    Some(Dependency {
        key,
        enabled: effective.get(&units(LOCAL_Z_MODE)) == Some(&OptionValue::Bool(true)),
    })
}

/// `validateFullSpectrumCrossFields`: the upper height bound may not fall
/// below the lower (`PrintObject.cpp:3854-3862`).
pub fn cross_field_issue(effective: &ValueMap) -> Option<Vec<u16>> {
    let number = |key: &str| match effective.get(&units(key)) {
        Some(OptionValue::Number(n)) if n.is_finite() => Some(*n),
        _ => None,
    };
    let (lower, upper) = (number(HEIGHT_LOWER_BOUND)?, number(HEIGHT_UPPER_BOUND)?);
    (lower > upper).then(|| {
        units(&format!(
            "Local-Z upper height bound ({}) must be greater than or equal to lower height bound ({})",
            number_to_string(upper),
            number_to_string(lower)
        ))
    })
}
pub const CROSS_FIELD_CODE: &str = "full-spectrum-height-bounds-order";

/// `getFullSpectrumSpecialEditorRequirement`: the serialized recipes belong to
/// the structured recipe editor (`PrintConfig.cpp:4299-4305`).
pub fn requires_structured_editor(key: &[u16]) -> bool {
    key == units(DEFINITIONS_KEY).as_slice()
}
pub const STRUCTURED_EDITOR_ID: &str = "full-spectrum-recipes";
pub const STRUCTURED_EDITOR_REASON: &str = "structured-editor:full-spectrum-recipes";
