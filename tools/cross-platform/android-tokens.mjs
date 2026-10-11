// The Android app's design tokens, generated from the browser's: the flat
// shell's two themes (web/src/ui/tokens.ts `domThemes`), its shared spacing,
// families and motion (`tokens`), the role pairs it holds to WCAG AA
// (`domContrastPairs`), its type ramp as the stylesheet sets it (web/index.html)
// and the theme switch's icon (web/public/icons/material). Check mode by
// default; `--write` regenerates.
//
// tokens.ts is imported, never parsed, so nothing here has a second idea of the
// tokens. The type ramp has no token of its own in the browser — the DOM
// shell's text sizes are its stylesheet's — so each text role is read from the
// rule that sets it (top-level, or inside the one @media block named for it);
// a rule that moves or stops setting a size fails here instead of drifting.
//
// Outputs:
//   android/app/src/main/java/dev/orcaxr/nativeapp/theme/OrcaTokens.kt
//     both themes' colour roles, viewport wash and plate as ARGB; radii, spacing,
//     the text roles (sp = CSS px, as Chrome on Android draws them), the families
//     each CSS stack resolves to on Android, motion, and the contrast pairs;
//   android/app/src/main/res/values{,-night}/orca_colors.xml
//     the window's background before Compose draws, per system theme;
//   android/app/src/main/res/drawable/ic_theme_dark.xml
//     the browser's theme switch icon (its `dark_mode` Material symbol).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  CONTRAST_MINIMUM,
  domContrastPairs,
  domThemes,
  tokens,
} from "../../web/src/ui/tokens.ts";

const root = new URL("../../", import.meta.url);
const at = (relative) => new URL(relative, root);
const read = (relative) => readFileSync(at(relative), "utf8");

const arguments_ = process.argv.slice(2);
const write = arguments_.includes("--write");
const unknown = arguments_.filter((argument) => argument !== "--write");
if (unknown.length > 0)
  throw new Error(`Unknown arguments: ${unknown.join(", ")}`);

const GENERATOR = "tools/cross-platform/android-tokens.mjs";
const KOTLIN =
  "android/app/src/main/java/dev/orcaxr/nativeapp/theme/OrcaTokens.kt";
const RES = "android/app/src/main/res";
const ICON = "web/public/icons/material/dark_mode.svg";

const problems = [];
const problem = (message) => problems.push(message);

// ---- colours -------------------------------------------------------------

/** `#rrggbb` (opaque) as a Kotlin ARGB Long literal. */
function argb(hex, where) {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) {
    problem(`${where}: ${hex} is not an opaque #rrggbb colour`);
    return "0xFF000000";
  }
  return `0xFF${match[1].toUpperCase()}`;
}

const ROLES = Object.keys(domThemes.light.color);
for (const name of Object.keys(domThemes))
  if (
    JSON.stringify(Object.keys(domThemes[name].color)) !== JSON.stringify(ROLES)
  )
    problem(`domThemes.${name}.color does not have light's roles in order`);

/** `linear-gradient(180deg, #top 0%, #bottom 100%)`: the viewport wash, top then bottom. */
function wash(gradient, where) {
  const match =
    /^linear-gradient\(180deg, (#[0-9a-fA-F]{6}) 0%, (#[0-9a-fA-F]{6}) 100%\)$/.exec(
      gradient,
    );
  if (!match) {
    problem(
      `${where}: ${gradient} is not a two-stop vertical wash this generator draws`,
    );
    return ["#000000", "#000000"];
  }
  return [match[1], match[2]];
}

// ---- the stylesheet's type ramp --------------------------------------------

/**
 * The rules of web/index.html's stylesheet, by their condition and selector
 * list: `"<selectors>"` for a top-level rule, `"@media <query> <selectors>"`
 * for one inside a media block (whitespace collapsed, selectors joined by
 * ", "). Declarations merge in source order, as the cascade merges equal
 * selectors. @keyframes and other at-rules are left out.
 */
function stylesheetRules() {
  const html = read("web/index.html");
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (!style) throw new Error("web/index.html has no <style> block");
  const css = style[1].replace(/\/\*[\s\S]*?\*\//g, "");
  const normal = (text) => text.trim().replace(/\s+/g, " ");
  const rules = new Map();
  // The open blocks: each a media query, a selector list, or null for one left out.
  const open = [];
  let start = 0;
  for (let index = 0; index < css.length; index++) {
    const character = css[index];
    if (character === "{") {
      const prelude = normal(css.slice(start, index));
      const inside = open.at(-1);
      if (open.length === 0)
        open.push(
          prelude.startsWith("@media ")
            ? { media: prelude }
            : prelude.startsWith("@")
              ? null
              : { selector: prelude },
        );
      else if (open.length === 1 && inside?.media)
        open.push({ media: inside.media, selector: prelude });
      else open.push(null);
      start = index + 1;
    } else if (character === "}") {
      const block = open.pop();
      if (block === undefined)
        throw new Error("web/index.html's stylesheet is unbalanced");
      if (block?.selector !== undefined) {
        const selectors = block.selector
          .split(",")
          .map((part) => part.trim())
          .join(", ");
        const key = block.media ? `${block.media} ${selectors}` : selectors;
        const declarations = rules.get(key) ?? new Map();
        for (const declaration of css.slice(start, index).split(";")) {
          const colon = declaration.indexOf(":");
          if (colon < 0) continue;
          declarations.set(
            declaration.slice(0, colon).trim(),
            declaration.slice(colon + 1).trim(),
          );
        }
        rules.set(key, declarations);
      }
      start = index + 1;
    }
  }
  if (open.length !== 0)
    throw new Error("web/index.html's stylesheet is unbalanced");
  return rules;
}

/**
 * The shell's text roles, each the stylesheet rule that sets it, and the
 * Material roles the app draws in it. Every Material role takes the browser
 * role of the same purpose: page titles, card headings (the sidebar's Printer,
 * Process, Objects bands), section headings (the inspector's Move/Rotate/Scale),
 * body text, field notes and status lines, buttons, the workspace tabs (the
 * app's bar and rail), field labels, units and code.
 */
const TEXT_ROLES = [
  {
    name: "pageTitle",
    selector: ".page-title",
    doc: "Page titles (the Device and Project pages).",
  },
  {
    name: "cardHeading",
    selector: ".card-head > h2",
    doc: "A sidebar card's heading band (Printer, Filament, Process, Objects).",
  },
  {
    name: "sectionHeading",
    selector: ".insp-section > summary",
    doc: "An inspector section's heading (Move, Rotate, Scale).",
  },
  {
    name: "body",
    selector: "html, body",
    doc: "Body text: the shell's 13 px.",
  },
  {
    name: "note",
    selector: ".field-note",
    doc: "Field notes and status lines.",
  },
  { name: "button", selector: ".action-btn", doc: "A button's label." },
  {
    // The app's bar and rail exist only below 600 dp and 840 dp: the browser's
    // narrow-window tab strip is the one they stand for.
    name: "tab",
    selector: ".view-tab",
    media: "@media (max-width: 768px)",
    doc: "A workspace tab's label (Prepare, Preview, Device, Project) in a narrow window.",
  },
  {
    name: "fieldLabel",
    selector: ".field-row > .field-label",
    doc: "A field's label.",
  },
  { name: "unit", selector: ".field-unit", doc: "A value's unit." },
  { name: "code", selector: "code", doc: "Code and G-code text." },
];

function textRole(rules, { name, selector, media }) {
  const base = rules.get(selector);
  const narrow = media ? rules.get(`${media} ${selector}`) : undefined;
  if (!base || (media && !narrow)) {
    problem(
      `web/index.html has no rule '${media ? `${media} ` : ""}${selector}' for ${name}`,
    );
    return { size: 13, weight: 400, lineHeight: null, mono: false };
  }
  // The media rule wins where it applies, as the cascade has it.
  const rule = new Map([...base, ...(narrow ?? [])]);
  const size = /^(\d+(?:\.\d+)?)px$/.exec(rule.get("font-size") ?? "");
  if (!size)
    problem(
      `'${selector}' sets no font-size in px (${rule.get("font-size") ?? "none"})`,
    );
  const sizePx = size ? Number(size[1]) : 13;
  const weightText = rule.get("font-weight") ?? "400";
  const weight =
    weightText === "normal"
      ? 400
      : weightText === "bold"
        ? 700
        : Number(weightText);
  if (!Number.isInteger(weight) || weight < 100 || weight > 900)
    problem(`'${selector}' has an unsupported font-weight ${weightText}`);
  const lineText = rule.get("line-height");
  let lineHeight = null;
  if (lineText !== undefined) {
    const px = /^(\d+(?:\.\d+)?)px$/.exec(lineText);
    if (px) lineHeight = Number(px[1]);
    else if (/^\d+(?:\.\d+)?$/.test(lineText))
      lineHeight = Math.round(Number(lineText) * sizePx * 1000) / 1000;
    else if (lineText !== "normal")
      problem(`'${selector}' has an unsupported line-height ${lineText}`);
  }
  const family = rule.get("font-family");
  const mono = family !== undefined && family.includes("--oxr-font-mono");
  if (
    family !== undefined &&
    !mono &&
    !family.includes("--oxr-font-sans") &&
    family !== "inherit"
  )
    problem(`'${selector}' sets a family no token names: ${family}`);
  return { size: sizePx, weight, lineHeight, mono };
}

// ---- families --------------------------------------------------------------

/** The families Android ships, by the CSS names a stack can give them. */
const ANDROID_FAMILIES = new Map([
  ["roboto", "SANS"],
  ["sans-serif", "SANS"],
  ["system-ui", "SANS"],
  ["ui-sans-serif", "SANS"],
  ["ui-monospace", "MONO"],
  ["monospace", "MONO"],
  ["serif", "SERIF"],
  ["ui-serif", "SERIF"],
]);

/** The first family of a CSS stack that Android has: what Chrome on Android draws it in. */
function family(stack, where) {
  for (const entry of stack.split(",")) {
    const name = entry
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .toLowerCase();
    const found = ANDROID_FAMILIES.get(name);
    if (found) return found;
  }
  problem(`${where}: no family of '${stack}' ships with Android`);
  return "SANS";
}

// ---- motion ----------------------------------------------------------------

function millis(duration, where) {
  const match = /^(\d+(?:\.\d+)?)(m?s)$/.exec(duration);
  if (!match) {
    problem(`${where}: ${duration} is not a CSS duration`);
    return 0;
  }
  return Math.round(Number(match[1]) * (match[2] === "s" ? 1000 : 1));
}

function bezier(easing) {
  const match =
    /^cubic-bezier\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)$/.exec(
      easing,
    );
  if (!match) {
    problem(`tokens.motion.ease: ${easing} is not a cubic-bezier()`);
    return [0, 0, 1, 1];
  }
  return match.slice(1).map(Number);
}

// ---- the icon --------------------------------------------------------------

/** A single-path Material symbol (viewBox `0 -960 960 960`) as a vector drawable. */
function vectorDrawable(path) {
  const svg = read(path);
  const viewBox = /viewBox="0 -960 960 960"/.test(svg);
  const paths = [...svg.matchAll(/<path d="([^"]+)"\/>/g)];
  if (!viewBox || paths.length !== 1) {
    problem(`${path} is not a single-path Material symbol on the 960 grid`);
    return "";
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by ${GENERATOR} from ${path}. Do not edit. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="960"
    android:viewportHeight="960"
    android:autoMirrored="false">
    <group android:translateY="960">
        <path
            android:fillColor="#FF000000"
            android:pathData="${paths[0][1]}" />
    </group>
</vector>
`;
}

// ---- Kotlin ----------------------------------------------------------------

const float = (value) => {
  const text = String(value);
  return `${text.includes(".") ? text : `${text}.0`}f`;
};

function palette(name) {
  const theme = domThemes[name];
  const colours = ROLES.map(
    (role) =>
      `            ${role} = ${argb(theme.color[role], `domThemes.${name}.color.${role}`)},`,
  ).join("\n");
  const [top, bottom] = wash(
    theme.gradient.viewport,
    `domThemes.${name}.gradient.viewport`,
  );
  const plate = theme.plate;
  return `    val ${name} = OrcaThemeTokens(
        color = OrcaPalette(
${colours}
        ),
        viewportTop = ${argb(top, `${name} viewport`)},
        viewportBottom = ${argb(bottom, `${name} viewport`)},
        plate = OrcaPlate(
            fill = ${argb(plate.fill, `${name}.plate.fill`)},
            gridMajor = ${argb(plate.gridMajor, `${name}.plate.gridMajor`)},
            gridMinor = ${argb(plate.gridMinor, `${name}.plate.gridMinor`)},
            origin = ${argb(plate.origin, `${name}.plate.origin`)},
        ),
    )`;
}

function renderKotlin() {
  const rules = stylesheetRules();
  const roles = TEXT_ROLES.map((role) => ({
    ...role,
    value: textRole(rules, role),
  }));
  const radius = domThemes.light.radius;
  if (JSON.stringify(radius) !== JSON.stringify(domThemes.dark.radius))
    problem("The two DOM themes' radii differ");
  const [x1, y1, x2, y2] = bezier(tokens.motion.ease);
  const fields = ROLES.map((role) => `    val ${role}: Long,`).join("\n");
  const lookup = ROLES.map((role) => `        "${role}" -> ${role}`).join("\n");
  const typeFields = roles
    .map(
      (role) => `    /** ${role.doc} */\n    val ${role.name}: OrcaTextRole,`,
    )
    .join("\n");
  const typeValues = roles
    .map(({ name, value }) => {
      const line = value.lineHeight === null ? "null" : float(value.lineHeight);
      return `        ${name} = OrcaTextRole(${float(value.size)}, ${value.weight}, ${line}${value.mono ? ", mono = true" : ""}),`;
    })
    .join("\n");
  const pairs = domContrastPairs
    .map(
      (pair) =>
        `        OrcaContrastPair("${pair.fg}", "${pair.bg}", OrcaContrastUse.${pair.use.toUpperCase()}),`,
    )
    .join("\n");
  return `// Generated by ${GENERATOR} from web/src/ui/tokens.ts and web/index.html. Do not edit.
package dev.orcaxr.nativeapp.theme

/** One theme's colour roles (\`ColorTable\`, web/src/ui/tokens.ts) as opaque ARGB. */
data class OrcaPalette(
${fields}
) {
    /** The role named [name], as tokens.ts names it. */
    fun role(name: String): Long = when (name) {
${lookup}
        else -> throw IllegalArgumentException("No colour role \${name}")
    }
}

/** The build plate as the browser's window dresses it (\`DomTheme.plate\`). */
data class OrcaPlate(val fill: Long, val gridMajor: Long, val gridMinor: Long, val origin: Long)

/** One flat-shell theme: its colours, the viewport's vertical wash (top, bottom) and the plate. */
data class OrcaThemeTokens(
    val color: OrcaPalette,
    val viewportTop: Long,
    val viewportBottom: Long,
    val plate: OrcaPlate,
)

/** A text role: size in sp (the stylesheet's px), CSS weight, line height in sp (null: the font's own). */
data class OrcaTextRole(val sizeSp: Float, val weight: Int, val lineHeightSp: Float?, val mono: Boolean = false)

/** The browser's text roles, from its stylesheet. */
data class OrcaTypeRamp(
${typeFields}
)

/** The family a CSS stack resolves to on Android: the first in the stack the system ships. */
enum class OrcaFamily { SANS, MONO, SERIF }

/** What a contrast pair carries, with WCAG 2.2 AA's minimum for it (\`CONTRAST_MINIMUM\`). */
enum class OrcaContrastUse(val minimum: Double) { TEXT(${CONTRAST_MINIMUM.text}), UI(${CONTRAST_MINIMUM.ui}.0) }

/** A foreground role the browser draws on a background role (\`domContrastPairs\`). */
data class OrcaContrastPair(val fg: String, val bg: String, val use: OrcaContrastUse)

object OrcaTokens {
${palette("light")}

${palette("dark")}

    /** Corner radii in dp (the flat shell's, \`DOM_RADIUS\`). */
    const val RADIUS_SM = ${radius.sm}
    const val RADIUS_MD = ${radius.md}
    const val RADIUS_LG = ${radius.lg}

    /** Spacing in dp (\`tokens.space\`). */
    const val SPACE_XS = ${tokens.space.xs}
    const val SPACE_SM = ${tokens.space.sm}
    const val SPACE_MD = ${tokens.space.md}
    const val SPACE_LG = ${tokens.space.lg}
    const val SPACE_XL = ${tokens.space.xl}

    val type = OrcaTypeRamp(
${typeValues}
    )

    /** \`tokens.font.sans\` and \`tokens.font.mono\` on Android. */
    val sans = OrcaFamily.${family(tokens.font.sans, "tokens.font.sans")}
    val mono = OrcaFamily.${family(tokens.font.mono, "tokens.font.mono")}

    /** \`tokens.motion\`: durations in ms and the easing's cubic-bezier control points. */
    const val MOTION_FAST_MS = ${millis(tokens.motion.durFast, "tokens.motion.durFast")}
    const val MOTION_BASE_MS = ${millis(tokens.motion.durBase, "tokens.motion.durBase")}
    const val MOTION_SLOW_MS = ${millis(tokens.motion.durSlow, "tokens.motion.durSlow")}
    val ease = floatArrayOf(${[x1, y1, x2, y2].map(float).join(", ")})

    /** Every role pair the browser's flat shell draws, held to WCAG AA in both themes. */
    val contrastPairs = listOf(
${pairs}
    )
}
`;
}

function renderColours(name) {
  const theme = domThemes[name];
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by ${GENERATOR} from web/src/ui/tokens.ts. Do not edit.
     The window's background before Compose draws: the ${name} theme's window (bg). -->
<resources>
    <color name="orca_window">#${argb(theme.color.bg, `${name}.bg`).slice(2)}</color>
</resources>
`;
}

// ---- write or check --------------------------------------------------------

const outputs = new Map([
  [KOTLIN, renderKotlin()],
  [`${RES}/values/orca_colors.xml`, renderColours("light")],
  [`${RES}/values-night/orca_colors.xml`, renderColours("dark")],
  [`${RES}/drawable/ic_theme_dark.xml`, vectorDrawable(ICON)],
]);
if (problems.length > 0) {
  console.error(
    `Android tokens cannot follow the browser's:\n${problems.map((line) => `  ${line}`).join("\n")}`,
  );
  process.exit(1);
}
if (write) {
  for (const [path, content] of outputs) {
    mkdirSync(new URL(".", at(path)), { recursive: true });
    writeFileSync(at(path), content);
  }
} else {
  const stale = [...outputs]
    .filter(
      ([path, content]) => !existsSync(at(path)) || read(path) !== content,
    )
    .map(([path]) => path);
  if (stale.length > 0) {
    console.error(
      `Generated Android tokens are stale; run \`node --import ./web/node_modules/tsx/dist/loader.mjs ${GENERATOR} --write\`:\n${stale.map((line) => `  ${line}`).join("\n")}`,
    );
    process.exit(1);
  }
}
console.log(
  `Android tokens: ${ROLES.length} colour roles in ${Object.keys(domThemes).length} themes, ` +
    `${TEXT_ROLES.length} text roles, ${domContrastPairs.length} contrast pairs.`,
);
