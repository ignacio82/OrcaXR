//! `fullSpectrumCompatibility.ts`: the material-category table and symmetric
//! compatibility matrix from Snapmaker Orca v2.3.4 `MixedColorMatchHelpers.cpp`
//! and `resources/profiles/Snapmaker/filament/filament_compatibility.json`.
use crate::{
    ids::PhysicalFilamentId,
    js_math::convert::trim_utf16,
    model::{PhysicalFilament, Text},
};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Pla,
    Abs,
    Asa,
    Petg,
    Tpu,
    Pet,
    Pa,
    Pc,
    Support,
}
impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pla => "PLA",
            Self::Abs => "ABS",
            Self::Asa => "ASA",
            Self::Petg => "PETG",
            Self::Tpu => "TPU",
            Self::Pet => "PET",
            Self::Pa => "PA",
            Self::Pc => "PC",
            Self::Support => "SUPPORT",
        }
    }
    fn partners(self) -> &'static [Category] {
        use Category::*;
        match self {
            Pla => &[Pc],
            Petg => &[Tpu, Pet, Abs, Asa, Pc],
            Tpu => &[Petg, Pet],
            Pet => &[Petg, Tpu, Abs, Asa, Pc],
            Abs => &[Petg, Pet, Asa, Pc, Pa],
            Asa => &[Petg, Pet, Abs, Pc, Pa],
            Pc => &[Pla, Petg, Pet, Abs, Asa, Pa],
            Pa => &[Abs, Asa, Pc],
            Support => &[],
        }
    }
}

/// `fullSpectrumMaterialCategory`: `material.trim().toUpperCase()` looked up in
/// the pinned table. The full Unicode upper-case mapping matters (`ſ` is `S`);
/// a lone surrogate survives it and can never name a table entry.
pub fn material_category(material: &[u16]) -> Option<Category> {
    let upper = String::from_utf16(trim_utf16(material))
        .ok()?
        .to_uppercase();
    Some(match upper.as_str() {
        "PLA" | "PLA-CF" => Category::Pla,
        "ABS" => Category::Abs,
        "ASA" => Category::Asa,
        "PETG" | "PETG-CF" | "PCTG" => Category::Petg,
        "TPU" => Category::Tpu,
        "PET" => Category::Pet,
        "PA" | "PA-CF" => Category::Pa,
        "PC" => Category::Pc,
        "BVOH" | "PVA" => Category::Support,
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allowed(Vec<Category>),
    Refused {
        reason: Text,
        first: PhysicalFilamentId,
        second: Option<PhysicalFilamentId>,
    },
}

/// `inspectFullSpectrumCompatibility`: the first missing or uncategorized
/// component, else the first incompatible pair in component order.
pub fn inspect(physical: &[Arc<PhysicalFilament>], components: &[PhysicalFilamentId]) -> Decision {
    let mut resolved: Vec<(&PhysicalFilamentId, Category)> = Vec::new();
    for (index, id) in components.iter().enumerate() {
        if components[..index].contains(id) {
            continue;
        }
        // A Map built from the array keeps the last filament with an ID.
        let Some(filament) = physical.iter().rev().find(|f| &f.id == id) else {
            return Decision::Refused {
                reason: units(&[
                    "Physical component ".encode_utf16().collect(),
                    id.as_utf16().to_vec(),
                    " is missing.".encode_utf16().collect(),
                ]),
                first: id.clone(),
                second: None,
            };
        };
        let Some(category) = material_category(filament.material.units()) else {
            let material = if filament.material.units().is_empty() {
                "(empty)".encode_utf16().collect()
            } else {
                filament.material.units().to_vec()
            };
            return Decision::Refused {
                reason: units(&[
                    "Material ".encode_utf16().collect(),
                    material,
                    " on ".encode_utf16().collect(),
                    filament.name.units().to_vec(),
                    " is not in the pinned compatibility table."
                        .encode_utf16()
                        .collect(),
                ]),
                first: id.clone(),
                second: None,
            };
        };
        resolved.push((id, category));
    }
    for (index, (left_id, left)) in resolved.iter().enumerate() {
        for (right_id, right) in &resolved[index + 1..] {
            if left == right || left.partners().contains(right) {
                continue;
            }
            return Decision::Refused {
                reason: Text::from_utf8(&format!(
                    "{} and {} cannot be mixed by the pinned Snapmaker compatibility matrix.",
                    left.as_str(),
                    right.as_str()
                )),
                first: (*left_id).clone(),
                second: Some((*right_id).clone()),
            };
        }
    }
    Decision::Allowed(resolved.into_iter().map(|(_, c)| c).collect())
}

fn units(parts: &[Vec<u16>]) -> Text {
    Text::new(parts.concat())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn category(text: &str) -> Option<&'static str> {
        material_category(&text.encode_utf16().collect::<Vec<_>>()).map(Category::as_str)
    }
    #[test]
    fn categories_follow_javascript_trim_and_upper_case() {
        assert_eq!(category(" pla-cf\u{feff}"), Some("PLA"));
        assert_eq!(category("pctg"), Some("PETG"));
        assert_eq!(category("aſa"), Some("ASA"));
        assert_eq!(category("bvoh"), Some("SUPPORT"));
        assert_eq!(category("PLA+"), None);
        assert_eq!(category(""), None);
        assert_eq!(material_category(&[0x50, 0xd800]), None);
        assert!(Category::Pc.partners().contains(&Category::Pla));
        assert!(Category::Support.partners().is_empty());
    }
}
