//! `readSvgShapes` (`svgShapes.ts`): an SVG document's filled shapes resolved
//! to closed contours in millimetres, y up and centred on the origin, with
//! everything it could not cut reported by element and reason.
//!
//! A line-for-line port of the browser's hand-written reader, not an XML or
//! CSS engine: the regular expressions it scans with are reproduced as the
//! scans they amount to, including their leftmost-match and backtracking
//! outcomes, so odd input reads exactly as it does in the browser. `\s` and
//! `trim` are ECMAScript's whitespace, case-insensitive matching is ASCII (no
//! `u` flag), `Number` is `convert::number` and the trigonometry is V8's.
//! Byte offsets stand in for the browser's UTF-16 offsets: every delimiter is
//! ASCII, so the two find the same places.
use crate::js_math::{self, convert};
use std::collections::HashMap;
use std::f64::consts::PI;

pub type P2 = [f64; 2];

/// Segments per curve. Fine enough that a 50 mm arc has no visible facets.
const CURVE_SEGMENTS: f64 = 16.0;

/// The CSS pixel at 96 per inch, in millimetres.
const PX: f64 = 25.4 / 96.0;

/// Group nesting a drawing may use; deeper is refused, not recursed.
pub const MAX_NESTING: usize = 256;

/// CSS absolute units, in millimetres per unit, plus the 96dpi pixel.
fn unit_mm(unit: &str) -> Option<f64> {
    Some(match unit {
        "px" => PX,
        "pt" => 25.4 / 72.0,
        "pc" => 25.4 / 6.0,
        "mm" => 1.0,
        "cm" => 10.0,
        "in" => 25.4,
        "q" => 0.25,
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    NeedsFont,
    RasterImage,
    ExternalReference,
    PaintEffect,
    StrokeOnly,
    UnsupportedUnit,
    UnsupportedCommand,
    EmptyShape,
    /// A CSS rule whose selector is more than this parser reads.
    CssSelector,
}

/// One thing the drawing asked for that a solid part cannot express.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsupported {
    pub element: String,
    pub reason: Reason,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct Shapes {
    /// Closed contours in millimetres, y up, centred on the drawing's origin.
    pub contours: Vec<Vec<P2>>,
    /// Everything the drawing contains that could not become geometry.
    pub unsupported: Vec<Unsupported>,
    /// Width and height of the resolved geometry, in millimetres.
    pub size_mm: P2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidSvg,
    NoGeometry,
}

/// `SvgError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub message: String,
    pub code: ErrorCode,
}

fn invalid(message: impl Into<String>) -> Error {
    Error {
        message: message.into(),
        code: ErrorCode::InvalidSvg,
    }
}

/// 2D affine transform as SVG orders it: [a c e; b d f].
type Matrix = [f64; 6];

const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn multiply(left: &Matrix, right: &Matrix) -> Matrix {
    [
        left[0] * right[0] + left[2] * right[1],
        left[1] * right[0] + left[3] * right[1],
        left[0] * right[2] + left[2] * right[3],
        left[1] * right[2] + left[3] * right[3],
        left[0] * right[4] + left[2] * right[5] + left[4],
        left[1] * right[4] + left[3] * right[5] + left[5],
    ]
}

fn apply(matrix: &Matrix, x: f64, y: f64) -> P2 {
    [
        matrix[0] * x + matrix[2] * y + matrix[4],
        matrix[1] * x + matrix[3] * y + matrix[5],
    ]
}

/// Read an SVG document into contours.
///
/// `target_width_mm` scales the whole drawing to that width, preserving
/// aspect; without it the document's own physical size is used, falling back
/// to the 96dpi pixel convention when it declares none.
pub fn read(source: &str, target_width_mm: Option<f64>) -> Result<Shapes, Error> {
    let mut unsupported = Vec::new();
    let Some(root) = find_root(source) else {
        return Err(invalid("That file has no <svg> element"));
    };

    let view_box = parse_view_box(root.attribute("viewbox"));
    let declared_width = parse_length(root.attribute("width"), &mut unsupported, "svg");
    let declared_height = parse_length(root.attribute("height"), &mut unsupported, "svg");

    // User units become millimetres through the viewBox when there is one,
    // and through the 96dpi pixel convention when there is not.
    let user_width = match view_box {
        Some(v) => v[2],
        None => declared_width.unwrap_or(0.0) / PX,
    };
    let user_height = match view_box {
        Some(v) => v[3],
        None => declared_height.unwrap_or(0.0) / PX,
    };
    let width_mm = declared_width.unwrap_or(user_width * PX);
    let height_mm = declared_height.unwrap_or(user_height * PX);
    let scale_x = if user_width > 0.0 {
        width_mm / user_width
    } else {
        PX
    };
    let scale_y = if user_height > 0.0 {
        height_mm / user_height
    } else {
        PX
    };

    // SVG's y axis points down and a printed part's points up, so the
    // document transform flips it and moves the viewBox origin to 0,0.
    let document: Matrix = [
        scale_x,
        0.0,
        0.0,
        -scale_y,
        -(match view_box {
            Some(v) => v[0],
            None => 0.0,
        }) * scale_x,
        (match view_box {
            Some(v) => v[1] + v[3],
            None => user_height,
        }) * scale_y,
    ];

    let mut contours: Vec<Vec<P2>> = Vec::new();
    let stylesheet = read_stylesheet(source, &mut unsupported);
    let mut reader = Reader {
        source,
        stylesheet: &stylesheet,
        contours: &mut contours,
        unsupported: &mut unsupported,
    };
    reader.collect(&root, &document, &Presentation::default(), 0)?;

    if contours.is_empty() {
        return Err(Error {
            message: match unsupported.first() {
                Some(first) => format!(
                    "This SVG has nothing that can become a solid part: {}",
                    first.detail
                ),
                None => "This SVG has no shapes to emboss".to_owned(),
            },
            code: ErrorCode::NoGeometry,
        });
    }

    let mut bounds = bounds_of(&contours);
    if let Some(target) = target_width_mm {
        if !target.is_finite() || target <= 0.0 {
            return Err(invalid("The requested SVG width must be greater than zero"));
        }
        let current = bounds.max_x - bounds.min_x;
        if current > 0.0 {
            let factor = target / current;
            for contour in &mut contours {
                for point in contour.iter_mut() {
                    *point = [point[0] * factor, point[1] * factor];
                }
            }
            bounds = bounds_of(&contours);
        }
    }

    // Centre on the origin so the part lands where the operator placed it.
    let centre_x = (bounds.min_x + bounds.max_x) / 2.0;
    let centre_y = (bounds.min_y + bounds.max_y) / 2.0;
    for contour in &mut contours {
        for point in contour.iter_mut() {
            *point = [point[0] - centre_x, point[1] - centre_y];
        }
    }
    Ok(Shapes {
        contours,
        unsupported,
        size_mm: [bounds.max_x - bounds.min_x, bounds.max_y - bounds.min_y],
    })
}

struct Element {
    name: String,
    attributes: HashMap<String, String>,
    end: usize,
    self_closing: bool,
}
impl Element {
    fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes.get(name).map(String::as_str)
    }
}

/// Elements that describe paint rather than a shape this can extrude.
fn unsupported_element(name: &str) -> Option<(Reason, &'static str)> {
    use Reason::*;
    Some(match name {
        "text" => (
            NeedsFont,
            "<text> needs a font; add it with the text emboss tool instead",
        ),
        "tspan" => (
            NeedsFont,
            "<tspan> needs a font; add it with the text emboss tool instead",
        ),
        "textpath" => (NeedsFont, "<textPath> needs a font and a layout engine"),
        "image" => (
            RasterImage,
            "<image> is a raster picture with no outline to cut",
        ),
        "use" => (
            ExternalReference,
            "<use> repeats another element by reference, which is not resolved",
        ),
        "clippath" => (
            PaintEffect,
            "<clipPath> trims paint, which does not translate to a solid",
        ),
        "mask" => (
            PaintEffect,
            "<mask> blends paint, which does not translate to a solid",
        ),
        "filter" => (PaintEffect, "<filter> is a pixel effect with no geometry"),
        "pattern" => (PaintEffect, "<pattern> is a paint server, not an outline"),
        "lineargradient" => (
            PaintEffect,
            "<linearGradient> is a paint server, not an outline",
        ),
        "radialgradient" => (
            PaintEffect,
            "<radialGradient> is a paint server, not an outline",
        ),
        "marker" => (PaintEffect, "<marker> decorates a stroke, which is not cut"),
        _ => return None,
    })
}

/// Elements that draw a shape, the only ones a stroke can leave without area.
fn is_shape(name: &str) -> bool {
    matches!(
        name,
        "path" | "rect" | "circle" | "ellipse" | "polygon" | "polyline" | "line"
    )
}

// ---------------------------------------------------------------------------
// Stylesheets: `fill` and `stroke` from simple element, class and id rules.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum SelectorKind {
    Element,
    Class,
    Id,
}

/// One simple selector of one rule, with what CSS orders it by.
struct SheetRule {
    kind: SelectorKind,
    key: String,
    /// Element, class and id selectors weigh 0, 1 and 2.
    specificity: u8,
    /// The rule's place in the document; a later rule of equal weight wins.
    order: usize,
    declarations: StyleRule,
}

#[derive(Default)]
struct Stylesheet {
    rules: Vec<SheetRule>,
    /// Rules by selector, so an element looks up the rules naming it rather
    /// than testing every rule (the browser's filter is elements × rules).
    by_selector: HashMap<(SelectorKind, String), Vec<usize>>,
}

/// Presentation a child inherits from its ancestors.
#[derive(Clone, Default)]
struct Presentation {
    fill: Option<String>,
    stroke: Option<String>,
}
impl Presentation {
    fn over(&mut self, layer: &Presentation) {
        if layer.fill.is_some() {
            self.fill.clone_from(&layer.fill);
        }
        if layer.stroke.is_some() {
            self.stroke.clone_from(&layer.stroke);
        }
    }
}

/// One rule's declarations, kept in their two precedence tiers.
#[derive(Clone, Default)]
struct StyleRule {
    normal: Presentation,
    important: Presentation,
}

/// `str::find` from `from`, as an absolute offset.
fn find_from(haystack: &str, from: usize, needle: &str) -> Option<usize> {
    haystack
        .get(from..)
        .and_then(|rest| rest.find(needle))
        .map(|at| from + at)
}

/// ASCII case-insensitive `find`.
fn find_ascii_ci(haystack: &str, from: usize, needle: &str) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let needle = needle.as_bytes();
    (from..=bytes.len().checked_sub(needle.len())?)
        .find(|&at| bytes[at..at + needle.len()].eq_ignore_ascii_case(needle))
}

/// Whether the byte at `at` starts a `\w` character (non-ASCII never does).
fn word_at(text: &str, at: usize) -> bool {
    text.as_bytes()
        .get(at)
        .is_some_and(|&b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The offset after the ECMAScript whitespace starting at `at`.
fn skip_space(text: &str, at: usize) -> usize {
    at + text[at..]
        .char_indices()
        .find(|&(_, c)| !convert::is_space(c))
        .map_or(text.len() - at, |(offset, _)| offset)
}

fn read_stylesheet(source: &str, unsupported: &mut Vec<Unsupported>) -> Stylesheet {
    let mut rules: Vec<SheetRule> = Vec::new();
    // `/<style\b[^>]*>([\s\S]*?)<\/style>/gi`. Once a block has no `>` or no
    // `</style>` after it, no later one can either.
    let mut cursor = 0;
    while let Some(at) = find_ascii_ci(source, cursor, "<style") {
        if word_at(source, at + 6) {
            cursor = at + 1;
            continue;
        }
        let Some(open) = find_from(source, at + 6, ">") else {
            break;
        };
        let Some(close) = find_ascii_ci(source, open + 1, "</style>") else {
            break;
        };
        cursor = close + "</style>".len();
        // Comments first: a rule inside `/* … */` is not a rule, and reading
        // one would apply a setting the document deliberately disabled.
        let css = strip_at_rules(&strip_comments(&source[open + 1..close]), unsupported);
        for (selectors, body) in css_rules(&css) {
            let declarations = declarations_of(body);
            let stated_fill =
                declarations.important.fill.is_some() || declarations.normal.fill.is_some();
            let stated_stroke =
                declarations.important.stroke.is_some() || declarations.normal.stroke.is_some();
            if !stated_fill && !stated_stroke {
                continue;
            }
            for selector in selectors.split(',').map(convert::trim) {
                let (kind, key) = if simple_name(selector) {
                    (SelectorKind::Element, selector.to_ascii_lowercase())
                } else if let Some(class) = selector.strip_prefix('.')
                    && word_run(class)
                {
                    (SelectorKind::Class, class.to_owned())
                } else if let Some(id) = selector.strip_prefix('#')
                    && word_run(id)
                {
                    (SelectorKind::Id, id.to_owned())
                } else {
                    if !selector.is_empty() {
                        unsupported.push(Unsupported {
                            element: "style".to_owned(),
                            reason: Reason::CssSelector,
                            detail: format!(
                                "The rule \"{selector}\" is more than a simple element, class or id selector; its fill and stroke are not applied"
                            ),
                        });
                    }
                    continue;
                };
                rules.push(SheetRule {
                    kind,
                    key,
                    specificity: match kind {
                        SelectorKind::Element => 0,
                        SelectorKind::Class => 1,
                        SelectorKind::Id => 2,
                    },
                    order: rules.len(),
                    declarations: declarations.clone(),
                });
            }
        }
    }
    let mut by_selector: HashMap<(SelectorKind, String), Vec<usize>> = HashMap::new();
    for (index, rule) in rules.iter().enumerate() {
        by_selector
            .entry((rule.kind, rule.key.clone()))
            .or_default()
            .push(index);
    }
    Stylesheet { rules, by_selector }
}

/// `^[a-zA-Z][\w-]*$`.
fn simple_name(selector: &str) -> bool {
    let mut bytes = selector.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
/// `^[\w-]+$`.
fn word_run(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `css.replace(/\/\*[\s\S]*?\*\//g, '')`.
fn strip_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut cursor = 0;
    while let Some(open) = find_from(css, cursor, "/*") {
        let Some(close) = find_from(css, open + 2, "*/") else {
            break;
        };
        out.push_str(&css[cursor..open]);
        cursor = close + 2;
    }
    out.push_str(&css[cursor..]);
    out
}

/// Remove at-rule blocks before any rule inside them is read: a print-only
/// `@media` declaration is not the geometry's. The block is dropped and
/// reported.
fn strip_at_rules(css: &str, unsupported: &mut Vec<Unsupported>) -> String {
    let mut out = String::new();
    let mut index = 0;
    // `indexOf('{', at)` and `indexOf(';', at)`, remembered: `at` only grows,
    // so a found position stays the answer until `at` passes it, and a miss
    // stays a miss. The browser's rescans are quadratic on `@a;@a;…`.
    let mut braces = NextOf::new(css, b'{');
    let mut semicolons = NextOf::new(css, b';');
    while index < css.len() {
        let Some(at) = find_from(css, index, "@") else {
            out.push_str(&css[index..]);
            break;
        };
        out.push_str(&css[index..at]);
        let name_length = css[at + 1..]
            .bytes()
            .take_while(|&b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            .count();
        let name = if name_length == 0 {
            "rule"
        } else {
            &css[at + 1..at + 1 + name_length]
        };
        let brace = braces.from(at);
        let semicolon = semicolons.from(at);
        if brace.is_none() || semicolon.is_some_and(|s| brace.is_some_and(|b| s < b)) {
            // A statement at-rule such as `@import url(…);` — it ends at the
            // semicolon and carries no declarations of its own.
            unsupported.push(Unsupported {
                element: "style".to_owned(),
                reason: Reason::CssSelector,
                detail: format!(
                    "The \"@{name}\" rule is not read; any fill or stroke it brings in is not applied"
                ),
            });
            index = semicolon.map_or(css.len(), |s| s + 1);
            continue;
        }
        // A block at-rule: skip to its matching close brace so nothing inside
        // is mistaken for a top-level rule.
        let brace = brace.expect("checked above");
        let mut depth = 0i64;
        let mut cursor = brace;
        let bytes = css.as_bytes();
        while cursor < bytes.len() {
            if bytes[cursor] == b'{' {
                depth += 1;
            } else if bytes[cursor] == b'}' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            cursor += 1;
        }
        unsupported.push(Unsupported {
            element: "style".to_owned(),
            reason: Reason::CssSelector,
            detail: format!(
                "The \"@{name}\" block is conditional, so its fill and stroke are not applied"
            ),
        });
        index = cursor + 1;
    }
    out
}

/// The next offset of one byte at or after a growing offset.
struct NextOf<'a> {
    bytes: &'a [u8],
    byte: u8,
    found: Option<Option<usize>>,
}
impl<'a> NextOf<'a> {
    fn new(text: &'a str, byte: u8) -> Self {
        Self {
            bytes: text.as_bytes(),
            byte,
            found: None,
        }
    }
    fn from(&mut self, at: usize) -> Option<usize> {
        match self.found {
            Some(None) => return None,
            Some(Some(found)) if found >= at => return Some(found),
            _ => {}
        }
        let found = self.bytes[at.min(self.bytes.len())..]
            .iter()
            .position(|&b| b == self.byte)
            .map(|offset| at + offset);
        self.found = Some(found);
        found
    }
}

/// `css.matchAll(/([^{}]+)\{([^{}]*)\}/g)`: a run of non-braces opened by
/// `{` and closed by `}` with no brace between. A run that fails fails from
/// every offset inside it, so the scan resumes after the brace ending it.
fn css_rules(css: &str) -> Vec<(&str, &str)> {
    let bytes = css.as_bytes();
    let brace = |from: usize| {
        bytes[from..]
            .iter()
            .position(|&b| b == b'{' || b == b'}')
            .map(|at| from + at)
    };
    let mut rules = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'{' || bytes[at] == b'}' {
            at += 1;
            continue;
        }
        let Some(open) = brace(at) else { break };
        if bytes[open] == b'{'
            && let Some(close) = brace(open + 1)
            && bytes[close] == b'}'
        {
            rules.push((&css[at..open], &css[open + 1..close]));
            at = close + 1;
            continue;
        }
        at = open + 1;
    }
    rules
}

/// `fill` and `stroke` from a declaration block, with `!important` split off
/// and the last declaration of each winning within its tier, as in CSS.
fn declarations_of(body: &str) -> StyleRule {
    let mut rule = StyleRule::default();
    for property in ["fill", "stroke"] {
        // `(?:^|;)\s*<property>\s*:\s*([^;]+)`, global: a declaration starts
        // the block or follows a semicolon and runs to the next one.
        let mut at = 0;
        while at <= body.len() {
            let mut matched = None;
            if at == 0 {
                matched = declaration_at(body, 0, property);
            }
            if matched.is_none() && body.as_bytes().get(at) == Some(&b';') {
                matched = declaration_at(body, at + 1, property);
            }
            let Some((raw, end)) = matched else {
                at += 1;
                continue;
            };
            at = end;
            let raw = convert::trim(raw);
            let (flagged, value) = match strip_important(raw) {
                Some(value) => (true, convert::trim(value)),
                None => (false, raw),
            };
            if value.is_empty() {
                continue;
            }
            let tier = if flagged {
                &mut rule.important
            } else {
                &mut rule.normal
            };
            let slot = if property == "fill" {
                &mut tier.fill
            } else {
                &mut tier.stroke
            };
            *slot = Some(value.to_owned());
        }
    }
    rule
}

/// `\s*<property>\s*:\s*([^;]+)` at `at`: the value and where it ends.
fn declaration_at<'a>(body: &'a str, at: usize, property: &str) -> Option<(&'a str, usize)> {
    let name = skip_space(body, at);
    let after = name + property.len();
    if !body
        .get(name..after)
        .is_some_and(|text| text.eq_ignore_ascii_case(property))
    {
        return None;
    }
    let colon = skip_space(body, after);
    if body.as_bytes().get(colon) != Some(&b':') {
        return None;
    }
    let start = colon + 1;
    let end = find_from(body, start, ";").unwrap_or(body.len());
    // `\s*([^;]+)` needs one character before the semicolon or the end.
    (end > start).then(|| (&body[start..end], end))
}

/// `value.replace(/!\s*important\s*$/i, '')` on a trimmed value, when it
/// matches.
fn strip_important(raw: &str) -> Option<&str> {
    let keyword = raw.len().checked_sub("important".len())?;
    if !raw
        .get(keyword..)
        .is_some_and(|tail| tail.eq_ignore_ascii_case("important"))
    {
        return None;
    }
    let before = raw[..keyword].trim_end_matches(convert::is_space);
    before.strip_suffix('!')
}

/// One element's effective `fill` and `stroke`, in SVG's cascade order:
/// inherited, presentation attribute, ordinary rule, inline style, then
/// anything marked important — rule first, inline last.
fn resolve_presentation(
    inherited: &Presentation,
    element: &Element,
    stylesheet: &Stylesheet,
) -> Presentation {
    let mut resolved = inherited.clone();
    resolved.over(&Presentation {
        fill: element.attribute("fill").map(str::to_owned),
        stroke: element.attribute("stroke").map(str::to_owned),
    });
    let inline = declarations_of(element.attribute("style").unwrap_or(""));
    let sheet = stylesheet_presentation(stylesheet, element);
    resolved.over(&sheet.normal);
    resolved.over(&inline.normal);
    resolved.over(&sheet.important);
    resolved.over(&inline.important);
    resolved
}

fn stylesheet_presentation(stylesheet: &Stylesheet, element: &Element) -> StyleRule {
    if stylesheet.rules.is_empty() {
        return StyleRule::default();
    }
    // A class listed twice is one class, as the browser's `Set` keeps it.
    let mut classes: Vec<&str> = element
        .attribute("class")
        .unwrap_or("")
        .split(convert::is_space)
        .filter(|class| !class.is_empty())
        .collect();
    classes.sort_unstable();
    classes.dedup();
    let selectors = std::iter::once((SelectorKind::Element, element.name.to_lowercase()))
        .chain(
            classes
                .into_iter()
                .map(|class| (SelectorKind::Class, class.to_owned())),
        )
        .chain(
            element
                .attribute("id")
                .map(|id| (SelectorKind::Id, id.to_owned())),
        );
    let mut matching: Vec<&SheetRule> = selectors
        .filter_map(|selector| stylesheet.by_selector.get(&selector))
        .flatten()
        .map(|&index| &stylesheet.rules[index])
        .collect();
    // Applied lightest first, then in document order: a later rule of equal
    // weight wins, whatever order the element lists its classes in.
    matching.sort_by_key(|rule| (rule.specificity, rule.order));
    let mut resolved = StyleRule::default();
    for rule in matching {
        resolved.normal.over(&rule.declarations.normal);
        resolved.important.over(&rule.declarations.important);
    }
    resolved
}

/// `fill="none"` with a stroke draws a line, which has no area to extrude.
fn is_stroke_only(presentation: &Presentation) -> bool {
    presentation
        .fill
        .as_deref()
        .is_some_and(|fill| fill.to_lowercase() == "none")
        && presentation
            .stroke
            .as_deref()
            .is_some_and(|stroke| stroke.to_lowercase() != "none")
}

// ---------------------------------------------------------------------------
// Elements and shapes.
// ---------------------------------------------------------------------------

struct Reader<'a> {
    source: &'a str,
    stylesheet: &'a Stylesheet,
    contours: &'a mut Vec<Vec<P2>>,
    unsupported: &'a mut Vec<Unsupported>,
}

impl Reader<'_> {
    fn collect(
        &mut self,
        element: &Element,
        parent: &Matrix,
        inherited: &Presentation,
        depth: usize,
    ) -> Result<(), Error> {
        let matrix = multiply(
            parent,
            &parse_transform(
                element.attribute("transform"),
                self.unsupported,
                &element.name,
            ),
        );
        let here = resolve_presentation(inherited, element, self.stylesheet);
        for child in child_elements(self.source, element) {
            if let Some((reason, detail)) = unsupported_element(&child.name) {
                self.unsupported.push(Unsupported {
                    element: child.name.clone(),
                    reason,
                    detail: detail.to_owned(),
                });
                continue;
            }
            if child.name == "defs" {
                // Definitions are only drawn through <use>, which is reported.
                continue;
            }
            if matches!(child.name.as_str(), "g" | "svg" | "a" | "switch") {
                if depth + 1 > MAX_NESTING {
                    return Err(invalid(format!(
                        "This SVG nests its groups more than {MAX_NESTING} deep"
                    )));
                }
                self.collect(&child, &matrix, &here, depth + 1)?;
                continue;
            }
            let child_matrix = multiply(
                &matrix,
                &parse_transform(child.attribute("transform"), self.unsupported, &child.name),
            );
            // Checked before emptiness: an open stroked path yields no contour
            // at all, and reporting it as "empty" would hide why it vanished.
            if is_shape(&child.name)
                && is_stroke_only(&resolve_presentation(&here, &child, self.stylesheet))
            {
                self.unsupported.push(Unsupported {
                    element: child.name.clone(),
                    reason: Reason::StrokeOnly,
                    detail: format!(
                        "<{}> is stroked with no fill; only filled areas become solid",
                        child.name
                    ),
                });
                continue;
            }
            for contour in shape_contours(&child, self.unsupported) {
                let mapped: Vec<P2> = contour
                    .iter()
                    .map(|&[x, y]| apply(&child_matrix, x, y))
                    .collect();
                if mapped.len() >= 3 {
                    self.contours.push(mapped);
                }
            }
        }
        Ok(())
    }
}

fn shape_contours(element: &Element, unsupported: &mut Vec<Unsupported>) -> Vec<Vec<P2>> {
    let attribute = |name| element.attribute(name);
    match element.name.as_str() {
        "path" => parse_path_data(attribute("d").unwrap_or(""), unsupported),
        "rect" => rect_contours(element),
        "circle" => {
            let radius = number(attribute("r"));
            if radius <= 0.0 {
                return Vec::new();
            }
            vec![ellipse_points(
                number(attribute("cx")),
                number(attribute("cy")),
                radius,
                radius,
            )]
        }
        "ellipse" => {
            let rx = number(attribute("rx"));
            let ry = number(attribute("ry"));
            if rx <= 0.0 || ry <= 0.0 {
                return Vec::new();
            }
            vec![ellipse_points(
                number(attribute("cx")),
                number(attribute("cy")),
                rx,
                ry,
            )]
        }
        "polygon" | "polyline" => {
            let points = number_list(attribute("points").unwrap_or(""));
            let contour: Vec<P2> = points.chunks_exact(2).map(|p| [p[0], p[1]]).collect();
            if contour.len() >= 3 {
                vec![contour]
            } else {
                Vec::new()
            }
        }
        "line" => {
            unsupported.push(Unsupported {
                element: "line".to_owned(),
                reason: Reason::StrokeOnly,
                detail: "<line> has no area; only filled shapes become solid".to_owned(),
            });
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// `a || b` over optional attribute strings: an empty value is falsy.
fn either<'a>(first: Option<&'a str>, second: Option<&'a str>) -> Option<&'a str> {
    match first {
        Some(value) if !value.is_empty() => Some(value),
        _ => second,
    }
}

fn rect_contours(element: &Element) -> Vec<Vec<P2>> {
    let attribute = |name| element.attribute(name);
    let x = number(attribute("x"));
    let y = number(attribute("y"));
    let width = number(attribute("width"));
    let height = number(attribute("height"));
    if width <= 0.0 || height <= 0.0 {
        return Vec::new();
    }
    let rx = js_math::min(
        number(either(attribute("rx"), attribute("ry"))),
        width / 2.0,
    );
    let ry = js_math::min(
        number(either(attribute("ry"), attribute("rx"))),
        height / 2.0,
    );
    if rx <= 0.0 || ry <= 0.0 {
        return vec![vec![
            [x, y],
            [x + width, y],
            [x + width, y + height],
            [x, y + height],
        ]];
    }
    // Rounded corners, walked clockwise in SVG's own coordinate sense.
    let mut points = Vec::new();
    let mut corner = |cx: f64, cy: f64, from: f64, to: f64| {
        let mut step = 0.0;
        while step <= CURVE_SEGMENTS {
            let angle = from + ((to - from) * step) / CURVE_SEGMENTS;
            points.push([cx + js_math::cos(angle) * rx, cy + js_math::sin(angle) * ry]);
            step += 1.0;
        }
    };
    corner(x + width - rx, y + ry, -PI / 2.0, 0.0);
    corner(x + width - rx, y + height - ry, 0.0, PI / 2.0);
    corner(x + rx, y + height - ry, PI / 2.0, PI);
    corner(x + rx, y + ry, PI, (3.0 * PI) / 2.0);
    vec![points]
}

fn ellipse_points(cx: f64, cy: f64, rx: f64, ry: f64) -> Vec<P2> {
    let steps = CURVE_SEGMENTS * 4.0;
    let mut points = Vec::new();
    let mut step = 0.0;
    while step < steps {
        let angle = (step / steps) * PI * 2.0;
        points.push([cx + js_math::cos(angle) * rx, cy + js_math::sin(angle) * ry]);
        step += 1.0;
    }
    points
}

/// Parse a `d` attribute into closed contours, flattening every curve.
fn parse_path_data(data: &str, unsupported: &mut Vec<Unsupported>) -> Vec<Vec<P2>> {
    let mut contours = Vec::new();
    let mut current: Vec<P2> = Vec::new();
    let (mut x, mut y) = (0.0, 0.0);
    let (mut start_x, mut start_y) = (0.0, 0.0);
    let mut last_control: Option<P2> = None;
    // `lastCommand`, empty before the first command runs.
    let mut last_command: Option<u8> = None;

    for (command, values) in tokenize_path(data, unsupported) {
        let relative = command.is_ascii_lowercase();
        let upper = command.to_ascii_uppercase();
        // A repeated coordinate set after a move is an implicit line.
        let stride = match upper {
            b'M' | b'L' | b'T' => 2,
            b'H' | b'V' => 1,
            b'C' => 6,
            b'S' | b'Q' => 4,
            b'A' => 7,
            _ => 0,
        };
        // A trailing partial group is malformed; dropping it beats zeros.
        let groups: Vec<&[f64]> = if stride == 0 {
            vec![&[] as &[f64]]
        } else {
            values.chunks_exact(stride).collect()
        };
        let at = |base: f64, value: f64| if relative { base + value } else { value };
        for (index, group) in groups.into_iter().enumerate() {
            match upper {
                b'M' => {
                    x = at(x, group[0]);
                    y = at(y, group[1]);
                    // Only the first pair moves; the rest are implicit lines.
                    if index == 0 {
                        if current.len() >= 3 {
                            contours.push(std::mem::take(&mut current));
                        }
                        current.clear();
                        start_x = x;
                        start_y = y;
                        current.push([x, y]);
                    } else {
                        current.push([x, y]);
                    }
                }
                b'L' => {
                    x = at(x, group[0]);
                    y = at(y, group[1]);
                    current.push([x, y]);
                }
                b'H' => {
                    x = at(x, group[0]);
                    current.push([x, y]);
                }
                b'V' => {
                    y = at(y, group[0]);
                    current.push([x, y]);
                }
                b'C' => {
                    let c1 = [at(x, group[0]), at(y, group[1])];
                    let c2 = [at(x, group[2]), at(y, group[3])];
                    let to = [at(x, group[4]), at(y, group[5])];
                    append_cubic(&mut current, [x, y], c1, c2, to);
                    last_control = Some(c2);
                    [x, y] = to;
                }
                b'S' => {
                    let reflected = reflect([x, y], last_control, last_command, b"CS");
                    let c2 = [at(x, group[0]), at(y, group[1])];
                    let to = [at(x, group[2]), at(y, group[3])];
                    append_cubic(&mut current, [x, y], reflected, c2, to);
                    last_control = Some(c2);
                    [x, y] = to;
                }
                b'Q' => {
                    let control = [at(x, group[0]), at(y, group[1])];
                    let to = [at(x, group[2]), at(y, group[3])];
                    append_quadratic(&mut current, [x, y], control, to);
                    last_control = Some(control);
                    [x, y] = to;
                }
                b'T' => {
                    let control = reflect([x, y], last_control, last_command, b"QT");
                    let to = [at(x, group[0]), at(y, group[1])];
                    append_quadratic(&mut current, [x, y], control, to);
                    last_control = Some(control);
                    [x, y] = to;
                }
                b'A' => {
                    let to = [at(x, group[5]), at(y, group[6])];
                    append_arc(
                        &mut current,
                        [x, y],
                        group[0],
                        group[1],
                        group[2],
                        group[3] != 0.0,
                        group[4] != 0.0,
                        to,
                    );
                    [x, y] = to;
                }
                _ => {
                    if current.len() >= 3 {
                        contours.push(std::mem::take(&mut current));
                    }
                    current.clear();
                    x = start_x;
                    y = start_y;
                }
            }
            if !matches!(upper, b'C' | b'S' | b'Q' | b'T') {
                last_control = None;
            }
            last_command = Some(upper);
        }
    }
    if current.len() >= 3 {
        contours.push(current);
    }
    contours
}

/// A smooth command reflects the previous control point only when the
/// previous command was of the matching family; otherwise it starts flat.
/// (`family.includes('')` holds, so nothing before the first command bars it.)
fn reflect(point: P2, control: Option<P2>, last: Option<u8>, family: &[u8; 2]) -> P2 {
    match control {
        Some(control) if last.is_none_or(|command| family.contains(&command)) => {
            [2.0 * point[0] - control[0], 2.0 * point[1] - control[1]]
        }
        _ => point,
    }
}

fn append_cubic(out: &mut Vec<P2>, from: P2, c1: P2, c2: P2, to: P2) {
    let mut step = 1.0;
    while step <= CURVE_SEGMENTS {
        let t = step / CURVE_SEGMENTS;
        let u = 1.0 - t;
        let axis = |i: usize| {
            u * u * u * from[i]
                + 3.0 * u * u * t * c1[i]
                + 3.0 * u * t * t * c2[i]
                + t * t * t * to[i]
        };
        out.push([axis(0), axis(1)]);
        step += 1.0;
    }
}

fn append_quadratic(out: &mut Vec<P2>, from: P2, control: P2, to: P2) {
    let mut step = 1.0;
    while step <= CURVE_SEGMENTS {
        let t = step / CURVE_SEGMENTS;
        let u = 1.0 - t;
        let axis = |i: usize| u * u * from[i] + 2.0 * u * t * control[i] + t * t * to[i];
        out.push([axis(0), axis(1)]);
        step += 1.0;
    }
}

/// Endpoint-parameterized elliptical arc, per the SVG implementation notes.
#[allow(clippy::too_many_arguments)] // `appendArc`'s signature.
fn append_arc(
    out: &mut Vec<P2>,
    from: P2,
    rx_input: f64,
    ry_input: f64,
    rotation_deg: f64,
    large_arc: bool,
    sweep: bool,
    to: P2,
) {
    let mut rx = rx_input.abs();
    let mut ry = ry_input.abs();
    if rx == 0.0 || ry == 0.0 || (from[0] == to[0] && from[1] == to[1]) {
        out.push(to);
        return;
    }
    let phi = (rotation_deg * PI) / 180.0;
    let cos_phi = js_math::cos(phi);
    let sin_phi = js_math::sin(phi);
    let dx = (from[0] - to[0]) / 2.0;
    let dy = (from[1] - to[1]) / 2.0;
    let x1 = cos_phi * dx + sin_phi * dy;
    let y1 = -sin_phi * dx + cos_phi * dy;

    // Grow radii that cannot span the endpoints, exactly as the spec directs.
    let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if lambda > 1.0 {
        let factor = lambda.sqrt();
        rx *= factor;
        ry *= factor;
    }

    let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let ratio = js_math::max(0.0, numerator / denominator).sqrt()
        * if large_arc == sweep { -1.0 } else { 1.0 };
    let cx1 = (ratio * rx * y1) / ry;
    let cy1 = (-ratio * ry * x1) / rx;
    let cx = cos_phi * cx1 - sin_phi * cy1 + (from[0] + to[0]) / 2.0;
    let cy = sin_phi * cx1 + cos_phi * cy1 + (from[1] + to[1]) / 2.0;

    let angle = |ux: f64, uy: f64, vx: f64, vy: f64| {
        let dot = ux * vx + uy * vy;
        let length = js_math::hypot(&[ux, uy]) * js_math::hypot(&[vx, vy]);
        // `length || 1`: zero and NaN are falsy.
        let length = if length == 0.0 || length.is_nan() {
            1.0
        } else {
            length
        };
        let value = js_math::acos(js_math::min(1.0, js_math::max(-1.0, dot / length)));
        if ux * vy - uy * vx < 0.0 {
            -value
        } else {
            value
        }
    };
    let start = angle(1.0, 0.0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let mut sweep_angle = angle(
        (x1 - cx1) / rx,
        (y1 - cy1) / ry,
        (-x1 - cx1) / rx,
        (-y1 - cy1) / ry,
    );
    if !sweep && sweep_angle > 0.0 {
        sweep_angle -= PI * 2.0;
    }
    if sweep && sweep_angle < 0.0 {
        sweep_angle += PI * 2.0;
    }

    // A NaN step count draws nothing, as `step <= NaN` never holds.
    let steps = js_math::max(
        2.0,
        ((sweep_angle.abs() / (PI / 2.0)) * CURVE_SEGMENTS).ceil(),
    );
    let mut step = 1.0;
    while step <= steps {
        let theta = start + (sweep_angle * step) / steps;
        let px = js_math::cos(theta) * rx;
        let py = js_math::sin(theta) * ry;
        out.push([
            cos_phi * px - sin_phi * py + cx,
            sin_phi * px + cos_phi * py + cy,
        ]);
        step += 1.0;
    }
}

fn is_command(byte: u8) -> bool {
    matches!(
        byte.to_ascii_uppercase(),
        b'M' | b'L' | b'H' | b'V' | b'C' | b'S' | b'Q' | b'T' | b'A' | b'Z'
    )
}

/// `/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g`.
fn tokenize_path(data: &str, unsupported: &mut Vec<Unsupported>) -> Vec<(u8, Vec<f64>)> {
    let bytes = data.as_bytes();
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if !is_command(bytes[at]) {
            at += 1;
            continue;
        }
        let end = bytes[at + 1..]
            .iter()
            .position(|&b| is_command(b))
            .map_or(bytes.len(), |offset| at + 1 + offset);
        tokens.push((bytes[at], number_list(&data[at + 1..end])));
        at = end;
    }
    if tokens.is_empty() && !convert::trim(data).is_empty() {
        unsupported.push(Unsupported {
            element: "path".to_owned(),
            reason: Reason::UnsupportedCommand,
            detail: "A path had data this reader could not read as commands".to_owned(),
        });
    }
    tokens
}

/// `/([a-zA-Z]+)\s*\(([^)]*)\)/g` over a `transform`, composed left to right.
fn parse_transform(
    value: Option<&str>,
    unsupported: &mut Vec<Unsupported>,
    element: &str,
) -> Matrix {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return IDENTITY;
    };
    let bytes = value.as_bytes();
    let mut matrix = IDENTITY;
    let mut at = 0;
    while at < bytes.len() {
        if !bytes[at].is_ascii_alphabetic() {
            at += 1;
            continue;
        }
        let name_end = at
            + bytes[at..]
                .iter()
                .take_while(|b| b.is_ascii_alphabetic())
                .count();
        let open = skip_space(value, name_end);
        if bytes.get(open) != Some(&b'(') {
            at = name_end;
            continue;
        }
        // With no `)` left, no later transform can close either.
        let Some(close) = find_from(value, open + 1, ")") else {
            break;
        };
        let name = value[at..name_end].to_ascii_lowercase();
        let args = number_list(&value[open + 1..close]);
        at = close + 1;
        let arg = |index: usize, fallback: f64| args.get(index).copied().unwrap_or(fallback);
        match name.as_str() {
            "matrix" => {
                if let [a, b, c, d, e, f] = args[..] {
                    matrix = multiply(&matrix, &[a, b, c, d, e, f]);
                }
            }
            "translate" => {
                matrix = multiply(&matrix, &[1.0, 0.0, 0.0, 1.0, arg(0, 0.0), arg(1, 0.0)]);
            }
            "scale" => {
                let sx = arg(0, 1.0);
                matrix = multiply(&matrix, &[sx, 0.0, 0.0, arg(1, sx), 0.0, 0.0]);
            }
            "rotate" => {
                let radians = (arg(0, 0.0) * PI) / 180.0;
                let cos = js_math::cos(radians);
                let sin = js_math::sin(radians);
                let cx = arg(1, 0.0);
                let cy = arg(2, 0.0);
                matrix = multiply(&matrix, &[1.0, 0.0, 0.0, 1.0, cx, cy]);
                matrix = multiply(&matrix, &[cos, sin, -sin, cos, 0.0, 0.0]);
                matrix = multiply(&matrix, &[1.0, 0.0, 0.0, 1.0, -cx, -cy]);
            }
            "skewx" => {
                let skew = js_math::tan((arg(0, 0.0) * PI) / 180.0);
                matrix = multiply(&matrix, &[1.0, 0.0, skew, 1.0, 0.0, 0.0]);
            }
            "skewy" => {
                let skew = js_math::tan((arg(0, 0.0) * PI) / 180.0);
                matrix = multiply(&matrix, &[1.0, skew, 0.0, 1.0, 0.0, 0.0]);
            }
            _ => unsupported.push(Unsupported {
                element: element.to_owned(),
                reason: Reason::UnsupportedCommand,
                detail: format!("Transform \"{name}\" is not one this reader understands"),
            }),
        }
    }
    matrix
}

fn parse_view_box(value: Option<&str>) -> Option<[f64; 4]> {
    let parts = number_list(value.filter(|value| !value.is_empty())?);
    match parts[..] {
        [x, y, width, height] if width > 0.0 && height > 0.0 => Some([x, y, width, height]),
        _ => None,
    }
}

/// A length with an absolute unit, in millimetres. Percentages have no size.
/// `/^\s*([+-]?[\d.]+(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i`.
fn parse_length(
    value: Option<&str>,
    unsupported: &mut Vec<Unsupported>,
    element: &str,
) -> Option<f64> {
    let value = value.filter(|value| !value.is_empty())?;
    let bytes = value.as_bytes();
    let start = skip_space(value, 0);
    let mut end = start;
    if matches!(bytes.get(end), Some(b'+' | b'-')) {
        end += 1;
    }
    let body = bytes[end..]
        .iter()
        .take_while(|b| b.is_ascii_digit() || **b == b'.')
        .count();
    if body == 0 {
        return None;
    }
    end += body;
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let mut exponent = end + 1;
        if matches!(bytes.get(exponent), Some(b'+' | b'-')) {
            exponent += 1;
        }
        let digits = bytes[exponent.min(bytes.len())..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if digits > 0 {
            end = exponent + digits;
        }
    }
    let magnitude_text = &value[start..end];
    let unit_start = skip_space(value, end);
    let unit_end = unit_start
        + bytes[unit_start..]
            .iter()
            .take_while(|b| b.is_ascii_alphabetic() || **b == b'%')
            .count();
    if skip_space(value, unit_end) != value.len() {
        return None;
    }
    let magnitude = convert::number(magnitude_text);
    if !magnitude.is_finite() {
        return None;
    }
    let unit = value[unit_start..unit_end].to_ascii_lowercase();
    if unit.is_empty() {
        return Some(magnitude * PX);
    }
    let Some(factor) = unit_mm(&unit) else {
        unsupported.push(Unsupported {
            element: element.to_owned(),
            reason: Reason::UnsupportedUnit,
            detail: if unit == "%" {
                "A size in % depends on the page it is drawn into, so the viewBox was used instead"
                    .to_owned()
            } else {
                format!(
                    "Unit \"{unit}\" has no fixed physical size, so the viewBox was used instead"
                )
            },
        });
        return None;
    };
    Some(magnitude * factor)
}

/// `/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g`, each match through
/// `Number`, the non-finite dropped.
fn number_list(value: &str) -> Vec<f64> {
    let bytes = value.as_bytes();
    let digits = |from: usize| {
        bytes[from.min(bytes.len())..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let mut found = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let mut end = at;
        if matches!(bytes[end], b'+' | b'-') {
            end += 1;
        }
        let whole = digits(end);
        let fraction = if bytes.get(end + whole) == Some(&b'.') {
            digits(end + whole + 1)
        } else {
            0
        };
        if fraction > 0 {
            // `\d*\.\d+`.
            end += whole + 1 + fraction;
        } else if whole > 0 {
            // `\d+\.?`.
            end += whole;
            if bytes.get(end) == Some(&b'.') {
                end += 1;
            }
        } else {
            at += 1;
            continue;
        }
        if matches!(bytes.get(end), Some(b'e' | b'E')) {
            let mut exponent = end + 1;
            if matches!(bytes.get(exponent), Some(b'+' | b'-')) {
                exponent += 1;
            }
            let count = digits(exponent);
            if count > 0 {
                end = exponent + count;
            }
        }
        let parsed = convert::number(&value[at..end]);
        if parsed.is_finite() {
            found.push(parsed);
        }
        at = end;
    }
    found
}

/// `Number(value)`, with absent and non-finite read as zero.
fn number(value: Option<&str>) -> f64 {
    let parsed = value.map_or(f64::NAN, convert::number);
    if parsed.is_finite() { parsed } else { 0.0 }
}

struct Bounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

fn bounds_of(contours: &[Vec<P2>]) -> Bounds {
    let mut bounds = Bounds {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    for &[x, y] in contours.iter().flatten() {
        if x < bounds.min_x {
            bounds.min_x = x;
        }
        if x > bounds.max_x {
            bounds.max_x = x;
        }
        if y < bounds.min_y {
            bounds.min_y = y;
        }
        if y > bounds.max_y {
            bounds.max_y = y;
        }
    }
    bounds
}

// ---------------------------------------------------------------------------
// A small, strict XML reader. The browser's canonical layer has no DOM, and a
// real parser here would also hide exactly the things this must report.
// ---------------------------------------------------------------------------

/// `/<svg\b/i`, read as an element.
fn find_root(source: &str) -> Option<Element> {
    let mut cursor = 0;
    loop {
        let at = find_ascii_ci(source, cursor, "<svg")?;
        if !word_at(source, at + 4) {
            return read_element_at(source, at);
        }
        cursor = at + 1;
    }
}

fn read_element_at(source: &str, at: usize) -> Option<Element> {
    let close = find_from(source, at, ">")?;
    let raw = &source[at + 1..close];
    let self_closing = raw.trim_end_matches(convert::is_space).ends_with('/');
    let name_length = raw
        .char_indices()
        .find(|&(_, c)| convert::is_space(c) || c == '/' || c == '>')
        .map_or(raw.len(), |(offset, _)| offset);
    if name_length == 0 {
        return None;
    }
    // `toLowerCase().replace(/^.*:/, '')`: the prefix through the last colon.
    let lowered = raw[..name_length].to_lowercase();
    let name = match lowered.rfind(':') {
        Some(colon) => lowered[colon + 1..].to_owned(),
        None => lowered,
    };
    Some(Element {
        name,
        attributes: parse_attributes(&raw[name_length..]),
        end: close,
        self_closing,
    })
}

/// `/([^\s=/]+)\s*=\s*"([^"]*)"|([^\s=/]+)\s*=\s*'([^']*)'/g`; a later
/// spelling of a name wins.
fn parse_attributes(raw: &str) -> HashMap<String, String> {
    let named = |c: char| !convert::is_space(c) && c != '=' && c != '/';
    let mut attributes = HashMap::new();
    let mut at = 0;
    while at < raw.len() {
        let c = raw[at..].chars().next().expect("in bounds");
        if !named(c) {
            at += c.len_utf8();
            continue;
        }
        let name_end = raw[at..]
            .char_indices()
            .find(|&(_, c)| !named(c))
            .map_or(raw.len(), |(offset, _)| at + offset);
        // A name that fails fails from every offset inside it.
        let equals = skip_space(raw, name_end);
        if raw.as_bytes().get(equals) == Some(&b'=') {
            let open = skip_space(raw, equals + 1);
            if let Some(&quote) = raw.as_bytes().get(open)
                && (quote == b'"' || quote == b'\'')
                && let Some(close) = raw[open + 1..].find(quote as char)
            {
                let close = open + 1 + close;
                attributes.insert(
                    raw[at..name_end].to_lowercase(),
                    unescape_xml(&raw[open + 1..close]),
                );
                at = close + 1;
                continue;
            }
        }
        at = name_end;
    }
    attributes
}

/// Direct element children of `parent`, in document order.
fn child_elements(source: &str, parent: &Element) -> Vec<Element> {
    if parent.self_closing {
        return Vec::new();
    }
    // `source.indexOf('>', at) + 1 || source.length`.
    let past = |at: usize| find_from(source, at, ">").map_or(source.len(), |close| close + 1);
    let mut children = Vec::new();
    let mut depth = 0usize;
    let mut cursor = parent.end + 1;
    while cursor < source.len() {
        let Some(next) = find_from(source, cursor, "<") else {
            break;
        };
        let rest = &source[next..];
        if rest.starts_with("<!--") {
            cursor = find_from(source, next, "-->").map_or(source.len(), |end| end + 3);
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            cursor = find_from(source, next, "]]>").map_or(source.len(), |end| end + 3);
            continue;
        }
        if rest.starts_with("</") {
            if depth == 0 {
                break;
            }
            depth -= 1;
            cursor = past(next);
            continue;
        }
        if rest.starts_with("<?") || rest.starts_with("<!") {
            cursor = past(next);
            continue;
        }
        let Some(element) = read_element_at(source, next) else {
            break;
        };
        cursor = element.end + 1;
        let opens = !element.self_closing;
        if depth == 0 {
            children.push(element);
        }
        if opens {
            depth += 1;
        }
    }
    children
}

fn unescape_xml(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
