#!/usr/bin/env node
/**
 * Extract the per-scope override rules from the pinned Snapmaker OrcaSlicer
 * commit (P6.5).
 *
 * A setting is not editable at every scope, and the scopes do not layer in the
 * order an outsider would guess. Both facts live in the engine source, not in
 * any document, so they are read from the exact pinned blobs rather than
 * transcribed — a transcription drifts silently, and the failure mode is a
 * project whose generated config no longer matches what the engine would
 * produce.
 *
 * Four rules, each from one authoritative site:
 *
 *   plate       Tab.cpp `plate_keys`
 *   object      Tab.cpp `TabPrintObject` — PrintObjectConfig + PrintRegionConfig
 *   part        Tab.cpp `TabPrintPart`   — PrintRegionConfig
 *   layerRange  Tab.cpp `TabPrintLayer`  — layer_height + PrintRegionConfig
 *
 * All but the plate are intersected with `Preset::print_options()`, because
 * `TabPrintModel`'s constructor does exactly that and a key outside the print
 * preset has nowhere to be stored.
 *
 * The layering order comes from `region_config_from_model_volume` in
 * PrintObject.cpp, which applies object, then part, then the height range. The
 * height range therefore wins over the part — the opposite of what the visual
 * nesting suggests — and that is asserted here rather than left to a reader.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PinnedSource, UPSTREAM_COMMIT } from "../parity/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "../..");
export const OUTPUT_PATH = resolve(
  REPOSITORY_ROOT,
  "web/src/settings/generated/settingScopes.ts",
);

const PRINT_CONFIG_HPP = "src/libslic3r/PrintConfig.hpp";
const PRESET_CPP = "src/libslic3r/Preset.cpp";
const TAB_CPP = "src/slic3r/GUI/Tab.cpp";
const PRINT_OBJECT_CPP = "src/libslic3r/PrintObject.cpp";

/** Strip comments so a commented-out key never reaches a scope list. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function matchingParenthesis(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Unbalanced parentheses from offset ${openIndex}`);
}

/** Keys declared by one `PRINT_CONFIG_CLASS_DEFINE(Name, ((Type, key))...)`. */
export function extractConfigClassKeys(source, className) {
  const anchor = new RegExp(
    `PRINT_CONFIG_CLASS_DEFINE\\(\\s*${className}\\s*,`,
  );
  const match = anchor.exec(source);
  if (!match)
    throw new Error(`Missing PRINT_CONFIG_CLASS_DEFINE(${className})`);
  const open = source.lastIndexOf("(", match.index + match[0].length - 1);
  const body = stripComments(
    source.slice(open + 1, matchingParenthesis(source, open)),
  );
  const keys = [
    ...body.matchAll(/\(\(\s*ConfigOption[\w<>:,\s]*?,\s*(\w+)\s*\)\)/g),
  ].map((entry) => entry[1]);
  if (keys.length === 0) throw new Error(`${className} yielded no keys`);
  return keys;
}

/** One `Preset::*_options()` vector — the set that preset kind can store. */
export function extractPresetOptions(source, vector) {
  const match = new RegExp(
    `${vector}\\s*(?:=\\s*)?\\{([\\s\\S]*?)\\n\\s*\\}\\s*;`,
  ).exec(source);
  if (!match) throw new Error(`Missing ${vector}`);
  const keys = [...stripComments(match[1]).matchAll(/"([a-z0-9_]+)"/g)].map(
    (entry) => entry[1],
  );
  if (keys.length === 0) throw new Error(`${vector} is empty`);
  return keys;
}

/**
 * Everything `Metadata/project_settings.config` may hold.
 *
 * A saved project carries the merged FFF configuration, not the print preset
 * alone — `nozzle_temperature` and `printable_area` live there too. The SLA
 * vectors are excluded because the pinned fork ships no SLA path and a key
 * offered at project scope that the engine never instantiates would be a
 * control that does nothing.
 */
const PROJECT_OPTION_VECTORS = [
  "s_Preset_print_options",
  "s_Preset_filament_options",
  "s_Preset_machine_limits_options",
  "s_Preset_printer_options",
];

/** `plate_keys` — the only settings a plate may override. */
export function extractPlateKeys(source) {
  const match =
    /std::vector<std::string>\s+plate_keys\s*=\s*\{([\s\S]*?)\}\s*;/.exec(
      source,
    );
  if (!match) throw new Error("Missing plate_keys in Tab.cpp");
  const keys = [...stripComments(match[1]).matchAll(/"([a-z0-9_]+)"/g)].map(
    (entry) => entry[1],
  );
  if (keys.length === 0) throw new Error("plate_keys is empty");
  return keys;
}

/**
 * The class-key expression a model tab passes to `TabPrintModel`.
 *
 * Returned as the literal source text so a change upstream — a scope gaining
 * or losing a config class — fails the recognizer below instead of being
 * absorbed as if nothing happened.
 */
export function extractModelTabExpression(source, tabClass) {
  const anchor = new RegExp(
    `${tabClass}::${tabClass}\\s*\\([^)]*\\)\\s*:\\s*\\n?\\s*TabPrintModel\\(parent,`,
  );
  const match = anchor.exec(source);
  if (!match) throw new Error(`Missing ${tabClass} constructor`);
  const open = source.lastIndexOf("(", match.index + match[0].length - 1);
  return stripComments(
    source.slice(open + 1, matchingParenthesis(source, open)),
  )
    .replace(/^\s*parent\s*,/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MODEL_TAB_RULES = {
  object: {
    tabClass: "TabPrintObject",
    expression:
      "concat(PrintObjectConfig().keys(), PrintRegionConfig().keys())",
    classes: ["PrintObjectConfig", "PrintRegionConfig"],
    extra: [],
  },
  part: {
    tabClass: "TabPrintPart",
    expression: "PrintRegionConfig().keys()",
    classes: ["PrintRegionConfig"],
    extra: [],
  },
  layerRange: {
    tabClass: "TabPrintLayer",
    expression: "concat({ layer_height }, PrintRegionConfig().keys())",
    classes: ["PrintRegionConfig"],
    // `static std::string layer_height = "layer_height";` in Tab.cpp.
    extra: ["layer_height"],
  },
};

/**
 * Confirm the height range still layers on top of the part.
 *
 * `region_config_from_model_volume` applies the object config, then the
 * volume's, then the layer range's. Getting this backwards produces a project
 * that slices differently from Orca in exactly the cases a user set up
 * deliberately, so the order is checked against the source rather than trusted.
 */
export function verifyLayeringOrder(source) {
  const start = source.indexOf(
    "PrintRegionConfig region_config_from_model_volume(",
  );
  if (start === -1) throw new Error("Missing region_config_from_model_volume");
  const body = stripComments(source.slice(start, source.indexOf("\n}", start)));
  // The applications in source order *are* the precedence, so read the call
  // sequence rather than searching for each argument independently — the
  // parameter list mentions `layer_range_config` before any of them.
  const applied = [];
  for (const match of body.matchAll(/apply_to_print_region_config\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const call = body.slice(open + 1, matchingParenthesis(body, open));
    applied.push(call.slice(call.indexOf(",") + 1).replace(/\s+/g, ""));
  }
  const expected = [
    "volume.get_object()->config.get()",
    "volume.config.get()",
    "volume.material()->config.get()",
    "*layer_range_config",
  ];
  if (applied.join("|") !== expected.join("|")) {
    throw new Error(
      "Upstream changed how region config layers.\n" +
        `  expected: ${expected.join(" -> ")}\n` +
        `  found:    ${applied.join(" -> ")}\n` +
        "resolveScopedConfig must be updated to match before regenerating.",
    );
  }
  return ["object", "part", "layerRange"];
}

function sortedUnique(keys) {
  return [...new Set(keys)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

export function buildScopeTable({ allowFetch = true, sourceOverrides } = {}) {
  const snapshot = new PinnedSource({
    allowFetch,
    ...(sourceOverrides ? { overrides: sourceOverrides } : {}),
  });
  const printConfig = snapshot.read(PRINT_CONFIG_HPP);
  const preset = snapshot.read(PRESET_CPP);
  const tab = snapshot.read(TAB_CPP);
  const printObject = snapshot.read(PRINT_OBJECT_CPP);

  const printOptions = extractPresetOptions(preset, "s_Preset_print_options");
  const printOptionSet = new Set(printOptions);
  const projectOptions = PROJECT_OPTION_VECTORS.flatMap((vector) =>
    extractPresetOptions(preset, vector),
  );
  const classKeys = new Map(
    ["PrintObjectConfig", "PrintRegionConfig"].map((name) => [
      name,
      extractConfigClassKeys(printConfig, name),
    ]),
  );

  const scopes = {
    project: sortedUnique(projectOptions),
    plate: sortedUnique(extractPlateKeys(tab)),
  };

  for (const [scope, rule] of Object.entries(MODEL_TAB_RULES)) {
    const actual = extractModelTabExpression(tab, rule.tabClass);
    if (actual !== rule.expression) {
      throw new Error(
        `${rule.tabClass} now builds its key set from \`${actual}\`, not ` +
          `\`${rule.expression}\`. Update MODEL_TAB_RULES deliberately — a scope ` +
          "silently gaining or losing keys changes what a saved project may contain.",
      );
    }
    const keys = [
      ...rule.extra,
      ...rule.classes.flatMap((name) => classKeys.get(name)),
    ];
    // `TabPrintModel` intersects with the print preset's own option list.
    scopes[scope] = sortedUnique(keys.filter((key) => printOptionSet.has(key)));
  }

  return {
    order: ["project", "plate", ...verifyLayeringOrder(printObject)],
    scopes,
    source: {
      commit: UPSTREAM_COMMIT,
      files: [PRINT_CONFIG_HPP, PRESET_CPP, TAB_CPP, PRINT_OBJECT_CPP].map(
        (path) => snapshot.sourceRecord(path),
      ),
    },
  };
}

/** `layerRange` -> `LAYER_RANGE_KEYS`, so the generated file reads normally. */
function constantName(scope) {
  return `${scope.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_KEYS`;
}

function literal(keys) {
  return keys.map((key) => `  '${key}',`).join("\n");
}

export function renderScopeModule(table) {
  const digest = createHash("sha256")
    .update(JSON.stringify(table))
    .digest("hex");
  return `// Generated by tools/settings-schema/generate-scopes.mjs — do not edit.
//
// Which settings each scope may override, and the order the scopes layer in,
// read from the pinned Snapmaker OrcaSlicer commit rather than transcribed.
//
// commit ${table.source.commit}
${table.source.files.map((file) => `// ${file.path} ${file.blob}`).join("\n")}
// table sha256 ${digest}

/** Lowest precedence first; a later scope overrides an earlier one. */
export const SETTING_SCOPE_ORDER = [
${table.order.map((scope) => `  '${scope}',`).join("\n")}
] as const;

export type SettingScope = (typeof SETTING_SCOPE_ORDER)[number];

${table.order
  .map(
    (scope) => `const ${constantName(scope)} = [
${literal(table.scopes[scope])}
] as const;`,
  )
  .join("\n\n")}

export const SETTING_SCOPE_KEYS: Readonly<Record<SettingScope, readonly string[]>> = Object.freeze({
${table.order
  .map(
    (scope) =>
      `  ${scope}: Object.freeze(${constantName(scope)}) as readonly string[],`,
  )
  .join("\n")}
});

export const SETTING_SCOPE_SOURCE = Object.freeze({
  commit: '${table.source.commit}',
  digest: '${digest}',
  files: Object.freeze([
${table.source.files
  .map(
    (file) =>
      `    Object.freeze({ path: '${file.path}', blob: '${file.blob}' }),`,
  )
  .join("\n")}
  ]),
});
`;
}

export function expectedModuleText(options = {}) {
  return renderScopeModule(buildScopeTable(options));
}

function main() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== "--check" && arg !== "--no-fetch") {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  const expected = expectedModuleText({ allowFetch: !args.has("--no-fetch") });
  if (args.has("--check")) {
    if (!existsSync(OUTPUT_PATH)) {
      throw new Error(`Generated scope table is missing: ${OUTPUT_PATH}`);
    }
    if (readFileSync(OUTPUT_PATH, "utf8") !== expected) {
      throw new Error(
        `${OUTPUT_PATH} is stale. Run: npm --prefix web run settings:scopes`,
      );
    }
    console.log("Setting scope table matches the pinned engine source.");
    return;
  }
  writeFileSync(OUTPUT_PATH, expected);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main();
}
