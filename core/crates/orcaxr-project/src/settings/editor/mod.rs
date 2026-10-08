//! The settings editor (`web/src/settings/editor`): which engine options a
//! surface may edit and how they are listed (`fields.ts`), the draft every
//! surface edits through (`SettingsDraftEditor.ts`), keyboard-free stepping
//! (`stepper.ts`, `scopedStepper.ts`) and the reviewed Full Spectrum rules
//! (`fullSpectrumSemantics.ts`). Presentation and literal GUI placements are
//! generated from the browser's pinned schema with the storage table.
//!
//! The browser sorts fields with `localeCompare(…, 'en')` and searches text
//! folded by `normalize('NFKD')` and `toLocaleLowerCase('en-US')`. Both are
//! host policies: a [`Collation`] and a [`SearchFolding`].
mod draft;
pub mod exchange;
mod fields;
mod full_spectrum;
mod generated;
mod stepper;

pub use draft::*;
pub use fields::*;
pub use full_spectrum::*;
pub use generated::{
    GROUPS, PLACEMENTS, PRESENTATION, PROJECT_CONFIG_WRITE_KEYS, SPECIAL_WIDGET_KEYS, TABS,
};
pub use stepper::*;

use std::fmt;

/// `SettingsEditorMode`, in rank order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Mode {
    Simple,
    Advanced,
    Develop,
}
impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Simple => "simple",
            Self::Advanced => "advanced",
            Self::Develop => "develop",
        }
    }
}
/// A definition's technology applicability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Technology {
    Unknown,
    Any,
    Fff,
    Sla,
}
impl Technology {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Any => "any",
            Self::Fff => "fff",
            Self::Sla => "sla",
        }
    }
}
/// `SettingsTechnology`: the technology a surface edits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Requested {
    Fff,
    Sla,
    Any,
}
/// `EngineGuiSurface`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Process,
    Filament,
    Printer,
    Object,
    Plate,
}
impl Surface {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Process => "process",
            Self::Filament => "filament",
            Self::Printer => "printer",
            Self::Object => "object",
            Self::Plate => "plate",
        }
    }
}

/// A definition's presentation and applicability, by definition position.
#[derive(Debug)]
pub struct Presentation {
    pub label: Option<&'static str>,
    pub full_label: Option<&'static str>,
    pub category: Option<&'static str>,
    pub tooltip: Option<&'static str>,
    pub unit: Option<&'static str>,
    pub mode: Mode,
    pub technology: Technology,
    pub readonly: bool,
    pub gui_type: &'static str,
    pub aliases: &'static [&'static str],
    /// Extended or U1 enum domains, which the generic editor cannot offer.
    pub conditional_enum: bool,
    /// The generated default as canonical JSON.
    pub default: Option<&'static str>,
    /// Literal GUI placements binding this definition, as `PLACEMENTS` indices.
    pub placements: &'static [usize],
}
#[derive(Debug)]
pub struct Tab {
    pub id: &'static str,
    pub label: &'static str,
    pub order: u32,
    pub surface: Surface,
}
#[derive(Debug)]
pub struct Group {
    pub id: &'static str,
    pub label: &'static str,
    pub order: u32,
    pub surface: Surface,
    pub tab: usize,
}
#[derive(Debug)]
pub struct Placement {
    pub id: &'static str,
    pub order: u32,
    pub surface: Surface,
    pub tab: usize,
    pub group: usize,
}

/// `normalize('NFKD').toLocaleLowerCase('en-US')`, as the host performs it.
pub trait SearchFolding {
    type Error;
    fn fold(&mut self, text: &[u16]) -> Result<Vec<u16>, Self::Error>;
}
/// Exact for ASCII, where both steps reduce to lowercasing letters; other
/// text is refused, so a host with non-ASCII text passes its own folding.
#[derive(Debug, Clone, Copy, Default)]
pub struct AsciiFolding;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NonAsciiSearch;
impl fmt::Display for NonAsciiSearch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("non_ascii_search")
    }
}
impl SearchFolding for AsciiFolding {
    type Error = NonAsciiSearch;
    fn fold(&mut self, text: &[u16]) -> Result<Vec<u16>, NonAsciiSearch> {
        text.iter()
            .map(|&u| match u {
                0x41..=0x5a => Ok(u + 0x20),
                0..=0x7f => Ok(u),
                _ => Err(NonAsciiSearch),
            })
            .collect()
    }
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
