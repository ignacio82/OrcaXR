//! `fields.ts`: whether the generic editor supports a definition, and the
//! field list a surface renders, filtered, searched and ordered as the
//! browser does.
use super::{
    GROUPS, Mode, PLACEMENTS, PRESENTATION, PROJECT_CONFIG_WRITE_KEYS, Requested,
    SPECIAL_WIDGET_KEYS, SearchFolding, Surface, TABS, Technology,
    full_spectrum::is_reviewed_project_override, units,
};
use crate::{
    js_math::convert::is_space,
    settings::{
        SettingScope,
        options::{
            DEFINITIONS, Definition, OptionValue, contract_issue, enum_choices, option_value,
            validate_setting_value,
        },
        presets::Collation,
    },
};
use std::{cmp::Ordering, collections::HashMap};

/// The position of the definition with this field ID.
pub fn field_index(id: &str) -> Option<usize> {
    DEFINITIONS.iter().position(|d| d.id == id)
}
/// The generated default, when the schema provides one.
pub fn default_value(index: usize) -> Option<OptionValue> {
    let json = PRESENTATION[index].default?;
    let value = orcaxr_contracts::canonical::parse(json).expect("generated defaults are JSON");
    Some(option_value(&value).expect("generated defaults are option values"))
}
/// `catalog.has(key)`.
pub fn has_key(key: &[u16]) -> bool {
    DEFINITIONS
        .iter()
        .any(|d| d.key.encode_utf16().eq(key.iter().copied()))
}

/// `SettingsFieldSupport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Support {
    Implemented,
    Unavailable(String),
}

/// `assessFieldSupport`: what keeps the generic editor from a definition.
pub fn assess_support(index: usize, surface: Option<Surface>) -> Support {
    let d = &DEFINITIONS[index];
    let p = &PRESENTATION[index];
    let unavailable = |reason: String| Support::Unavailable(reason);
    if DEFINITIONS.iter().filter(|o| o.key == d.key).count() != 1 {
        return unavailable("ambiguous-key-owners".into());
    }
    if SPECIAL_WIDGET_KEYS.contains(&d.key) {
        return unavailable("custom-tab-widget".into());
    }
    if p.technology == Technology::Unknown {
        return unavailable("unknown-technology-applicability".into());
    }
    if p.readonly {
        return unavailable("readonly".into());
    }
    if p.gui_type != "undefined" {
        return unavailable(format!("special-widget:{}", p.gui_type));
    }
    if p.conditional_enum {
        return unavailable("conditional-enum-domain".into());
    }
    let reviewed = surface == Some(Surface::Process)
        && (PROJECT_CONFIG_WRITE_KEYS.contains(&d.key) || is_reviewed_project_override(d.key));
    if p.placements.is_empty() && !reviewed {
        return unavailable("no-literal-gui-placement".into());
    }
    if let Some(surface) = surface
        && !reviewed
        && !p
            .placements
            .iter()
            .any(|&i| PLACEMENTS[i].surface == surface)
    {
        return unavailable(format!("gui-surface-unavailable:{}", surface.as_str()));
    }
    if let Some(issue) = contract_issue(d) {
        return unavailable(issue.into());
    }
    if let Some(default) = default_value(index) {
        let issues = validate_setting_value(d, &default);
        if let Some(first) = issues.first() {
            return unavailable(format!("invalid-generated-default:{}", first.code));
        }
    }
    Support::Implemented
}

/// A field's applicability to the requested technology.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applicability {
    Applicable,
    NotApplicable,
    Unknown,
}
impl Applicability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applicable => "applicable",
            Self::NotApplicable => "not-applicable",
            Self::Unknown => "unknown",
        }
    }
}
/// Where a search token matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchField {
    Key,
    Label,
    FullLabel,
    Category,
    Page,
    Group,
    Surface,
    Tooltip,
    Owner,
    Alias,
    Enum,
}
impl MatchField {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Key => "key",
            Self::Label => "label",
            Self::FullLabel => "fullLabel",
            Self::Category => "category",
            Self::Page => "page",
            Self::Group => "group",
            Self::Surface => "surface",
            Self::Tooltip => "tooltip",
            Self::Owner => "owner",
            Self::Alias => "alias",
            Self::Enum => "enum",
        }
    }
}
/// `SettingsSearchMatch`: `start` indexes the folded text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchMatch {
    pub field: MatchField,
    pub start: usize,
    pub length: usize,
    pub text: Vec<u16>,
}

/// `SettingsFieldProjection`.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub index: usize,
    pub label: Vec<u16>,
    pub full_label: Option<Vec<u16>>,
    pub category: Vec<u16>,
    /// `PLACEMENTS` indices, in schema order.
    pub locations: &'static [usize],
    pub primary: Option<usize>,
    pub tooltip: Option<Vec<u16>>,
    pub unit: Option<Vec<u16>>,
    pub mode: Mode,
    pub technology: Technology,
    pub applicability: Applicability,
    pub support: Support,
    pub matches: Vec<SearchMatch>,
}
impl Field {
    pub fn definition(&self) -> &'static Definition {
        &DEFINITIONS[self.index]
    }
    /// `groupLabel`: where upstream puts the field, else its category.
    pub fn group_label(&self) -> Vec<u16> {
        let fallback = || {
            if self.category.is_empty() {
                units("Other")
            } else {
                self.category.clone()
            }
        };
        let Some(primary) = self.primary else {
            return fallback();
        };
        let placement = &PLACEMENTS[primary];
        for label in [GROUPS[placement.group].label, TABS[placement.tab].label] {
            if !label.is_empty() {
                return units(label);
            }
        }
        fallback()
    }
}

/// `SettingsFieldQuery`.
#[derive(Debug, Clone, PartialEq)]
pub struct Query {
    pub mode: Mode,
    pub technology: Requested,
    pub surface: Option<Surface>,
    pub scope: Option<SettingScope>,
    pub search: Vec<u16>,
    pub include_non_applicable: bool,
    pub include_unknown_applicability: bool,
    /// Defaults to true, as the browser's `includeUnavailable !== false`.
    pub include_unavailable: bool,
}
impl Query {
    pub fn new(mode: Mode, technology: Requested) -> Self {
        Self {
            mode,
            technology,
            surface: None,
            scope: None,
            search: Vec::new(),
            include_non_applicable: false,
            include_unknown_applicability: false,
            include_unavailable: true,
        }
    }
}

/// `projectSettingsField`: one field, unsearched.
pub fn project_field(index: usize, technology: Requested, surface: Option<Surface>) -> Field {
    let d = &DEFINITIONS[index];
    let p = &PRESENTATION[index];
    let primary = surface
        .and_then(|s| {
            p.placements
                .iter()
                .copied()
                .find(|&i| PLACEMENTS[i].surface == s)
        })
        .or_else(|| p.placements.first().copied());
    Field {
        index,
        label: units(p.label.unwrap_or(d.key)),
        full_label: p.full_label.filter(|l| !l.is_empty()).map(units),
        category: units(p.category.unwrap_or("Uncategorized")),
        locations: p.placements,
        primary,
        tooltip: p.tooltip.filter(|t| !t.is_empty()).map(units),
        unit: p.unit.filter(|u| !u.is_empty()).map(units),
        mode: p.mode,
        technology: p.technology,
        applicability: match (p.technology, technology) {
            (Technology::Unknown, _) => Applicability::Unknown,
            (Technology::Any, _) | (_, Requested::Any) => Applicability::Applicable,
            (Technology::Fff, Requested::Fff) | (Technology::Sla, Requested::Sla) => {
                Applicability::Applicable
            }
            _ => Applicability::NotApplicable,
        },
        support: assess_support(index, surface),
        matches: Vec::new(),
    }
}

/// Folded text, once per query.
struct Folded<'a, F> {
    folding: &'a mut F,
    cache: HashMap<Vec<u16>, Vec<u16>>,
}
impl<F: SearchFolding> Folded<'_, F> {
    fn fold(&mut self, text: &[u16]) -> Result<&[u16], F::Error> {
        if !self.cache.contains_key(text) {
            let folded = self.folding.fold(text)?;
            self.cache.insert(text.to_vec(), folded);
        }
        Ok(&self.cache[text])
    }
}
fn index_of(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}
/// `collectMatches`, with which tokens matched.
fn collect_matches<F: SearchFolding>(
    field: &Field,
    tokens: &[Vec<u16>],
    folded: &mut Folded<'_, F>,
) -> Result<(Vec<SearchMatch>, Vec<bool>), F::Error> {
    let d = field.definition();
    let p = &PRESENTATION[field.index];
    let mut sources: Vec<(MatchField, Vec<u16>)> = vec![
        (MatchField::Key, units(d.key)),
        (MatchField::Label, field.label.clone()),
    ];
    if let Some(full) = &field.full_label {
        sources.push((MatchField::FullLabel, full.clone()));
    }
    sources.push((MatchField::Category, field.category.clone()));
    if let Some(primary) = field.primary {
        let placement = &PLACEMENTS[primary];
        sources.push((MatchField::Page, units(TABS[placement.tab].label)));
        sources.push((MatchField::Group, units(GROUPS[placement.group].label)));
        sources.push((MatchField::Surface, units(placement.surface.as_str())));
    }
    if let Some(tooltip) = &field.tooltip {
        sources.push((MatchField::Tooltip, tooltip.clone()));
    }
    sources.push((MatchField::Owner, units(d.owner)));
    sources.extend(p.aliases.iter().map(|a| (MatchField::Alias, units(a))));
    for (serialized, label) in enum_choices(d) {
        sources.push((MatchField::Enum, units(serialized)));
        sources.push((MatchField::Enum, units(label)));
    }
    let mut matches = Vec::new();
    let mut matched = vec![false; tokens.len()];
    for (kind, text) in sources {
        let normalized = folded.fold(&text)?;
        for (t, token) in tokens.iter().enumerate() {
            if let Some(start) = index_of(normalized, token) {
                matched[t] = true;
                matches.push(SearchMatch {
                    field: kind,
                    start,
                    length: token.len(),
                    text: text.clone(),
                });
            }
        }
    }
    Ok((matches, matched))
}
/// `tokenize`: folded, split on JavaScript white space, first occurrences.
fn tokenize<F: SearchFolding>(
    search: &[u16],
    folded: &mut Folded<'_, F>,
) -> Result<Vec<Vec<u16>>, F::Error> {
    if search.is_empty() {
        return Ok(Vec::new());
    }
    let normalized = folded.fold(search)?.to_vec();
    let mut tokens: Vec<Vec<u16>> = Vec::new();
    let space = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(is_space);
    for token in normalized.split(space).filter(|t| !t.is_empty()) {
        if !tokens.iter().any(|t| t == token) {
            tokens.push(token.to_vec());
        }
    }
    Ok(tokens)
}

/// `compareFields`: GUI order first, then text under the host collation.
fn compare_fields<C: Collation>(
    left: &Field,
    right: &Field,
    collation: &mut C,
) -> Result<Ordering, C::Error> {
    match (left.primary, right.primary) {
        (Some(l), Some(r)) => {
            let (l, r) = (&PLACEMENTS[l], &PLACEMENTS[r]);
            let order = TABS[l.tab]
                .order
                .cmp(&TABS[r.tab].order)
                .then(GROUPS[l.group].order.cmp(&GROUPS[r.group].order))
                .then(l.order.cmp(&r.order));
            if order != Ordering::Equal {
                return Ok(order);
            }
        }
        (Some(_), None) => return Ok(Ordering::Less),
        (None, Some(_)) => return Ok(Ordering::Greater),
        (None, None) => {}
    }
    let (a, b) = (left.definition(), right.definition());
    let pairs: [(Vec<u16>, Vec<u16>); 5] = [
        (left.category.clone(), right.category.clone()),
        (left.label.clone(), right.label.clone()),
        (units(a.key), units(b.key)),
        (units(a.owner), units(b.owner)),
        (units(a.id), units(b.id)),
    ];
    for (l, r) in pairs {
        match collation.compare(&l, &r)? {
            Ordering::Equal => {}
            order => return Ok(order),
        }
    }
    Ok(Ordering::Equal)
}

/// `projectSettingsFields`.
pub fn query_fields<E, C, F>(
    query: &Query,
    collation: &mut C,
    folding: &mut F,
) -> Result<Vec<Field>, E>
where
    C: Collation<Error = E>,
    F: SearchFolding<Error = E>,
{
    let mut folded = Folded {
        folding,
        cache: HashMap::new(),
    };
    let tokens = tokenize(&query.search, &mut folded)?;
    let mut fields = Vec::new();
    for (index, d) in DEFINITIONS.iter().enumerate() {
        // Scope first: a key the engine never reads here does nothing.
        if query.scope.is_some_and(|s| !s.allows(&units(d.key))) {
            continue;
        }
        let mut field = project_field(index, query.technology, query.surface);
        if field.mode > query.mode {
            continue;
        }
        let shown = match field.applicability {
            Applicability::Applicable => true,
            Applicability::Unknown => query.include_unknown_applicability,
            Applicability::NotApplicable => query.include_non_applicable,
        };
        if !shown || (!query.include_unavailable && field.support != Support::Implemented) {
            continue;
        }
        if !tokens.is_empty() {
            let (matches, matched) = collect_matches(&field, &tokens, &mut folded)?;
            if !matched.iter().all(|m| *m) {
                continue;
            }
            field.matches = matches;
        }
        fields.push(field);
    }
    let mut failure = None;
    fields.sort_by(|a, b| {
        if failure.is_some() {
            return Ordering::Equal;
        }
        compare_fields(a, b, collation).unwrap_or_else(|e| {
            failure = Some(e);
            Ordering::Equal
        })
    });
    failure.map_or(Ok(fields), Err)
}
