#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractEnum,
  findCalls,
  literalString,
  normalizedExpression,
  shortHash,
  sourceLine,
  symbolAt,
} from "./cpp-scan.mjs";
import {
  EXTRACTOR_VERSION,
  PinnedSource,
  REPOSITORY_ROOT,
  UPSTREAM_COMMIT,
  UPSTREAM_REPOSITORY,
} from "./source.mjs";

export const DISPOSITIONS_PATH = join(
  REPOSITORY_ROOT,
  "tools",
  "parity",
  "dispositions.yaml",
);
export const MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  "docs",
  "parity",
  "snapmaker-v2.3.4.json",
);

const PATHS = Object.freeze({
  config: "src/libslic3r/Config.hpp",
  printConfig: "src/libslic3r/PrintConfig.cpp",
  tab: "src/slic3r/GUI/Tab.cpp",
  preset: "src/libslic3r/Preset.hpp",
  gizmoHeader: "src/slic3r/GUI/Gizmos/GLGizmosManager.hpp",
  gizmoManager: "src/slic3r/GUI/Gizmos/GLGizmosManager.cpp",
  guiAppHeader: "src/slic3r/GUI/GUI_App.hpp",
  guiApp: "src/slic3r/GUI/GUI_App.cpp",
  gcodeViewer: "src/slic3r/GUI/GCodeViewer.hpp",
  extrusionRoles: "src/libslic3r/ExtrusionEntity.hpp",
  calibration: "src/libslic3r/calib.hpp",
  mainFrame: "src/slic3r/GUI/MainFrame.cpp",
  monitor: "src/slic3r/GUI/Monitor.cpp",
});

const MENU_PATHS = [
  "src/slic3r/GUI/MainFrame.cpp",
  "src/slic3r/GUI/GUI_Factories.cpp",
  "src/slic3r/GUI/GUI_AuxiliaryList.cpp",
  "src/slic3r/GUI/PresetComboBoxes.cpp",
];

const SEED_TASK_BY_FAMILY = Object.freeze({
  settingDefinitions: "P6.1",
  settingModes: "P6.1",
  settingTabs: "P6.2",
  settingGroups: "P6.2",
  settingPlacements: "P6.2",
  presetTypes: "P6.3",
  menuActions: "P11.2",
  gizmos: "P5.3",
  formatFilters: "P5.6",
  previewModes: "P7.4",
  previewFilters: "P7.4",
  calibrationFlows: "P8.1",
  devicePages: "P9.5",
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function readOverlay(path = DISPOSITIONS_PATH) {
  const raw = readFileSync(path, "utf8");
  try {
    // JSON is a strict subset of YAML 1.2. Keeping this file in that subset avoids an
    // unpinned parser dependency in the parity gate.
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid reviewed YAML/JSON overlay ${path}: ${error.message}`,
    );
  }
}

function slug(value) {
  return (
    String(value)
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_.:-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "unnamed"
  );
}

function stableId(prefix, ...parts) {
  const raw = parts.map((part) => String(part)).join("\u0000");
  return `${prefix}:${slug(parts.join(":"))}:${shortHash(raw)}`;
}

function ref(snapshot, path, source, line, symbol = null) {
  const resolvedSymbol =
    symbol ??
    symbolAt(
      source,
      source
        .split("\n")
        .slice(0, line - 1)
        .join("\n").length,
    );
  return {
    anchor: sourceLine(source, line),
    blob: snapshot.blob(path),
    line,
    path,
    symbol: resolvedSymbol,
  };
}

function item(family, id, label, sources, extra = {}) {
  return { family, id, label, ...extra, sources };
}

function countOccurrences(items, keyFn) {
  const counts = new Map();
  return items.map((entry) => {
    const key = keyFn(entry);
    const occurrence = (counts.get(key) ?? 0) + 1;
    counts.set(key, occurrence);
    return { ...entry, occurrence };
  });
}

function extractSettings(snapshot) {
  const path = PATHS.printConfig;
  const source = snapshot.read(path);
  const directCalls = findCalls(source, "this->add")
    .filter((call) => literalString(call.args[0]) !== null)
    .map((call) => ({ call, macro: false }));
  const macroCalls = findCalls(source, "new_def")
    .filter((call) => literalString(call.args[0]) !== null)
    .map((call) => ({ call, macro: true }));
  const registrations = [...directCalls, ...macroCalls].sort(
    (a, b) => a.call.start - b.call.start,
  );
  if (directCalls.length !== 744 || macroCalls.length !== 45) {
    throw new Error(
      `PrintConfig registration sanity check failed: expected 744 active literal add calls + ` +
        `45 new_def expansions, found ${directCalls.length} + ${macroCalls.length}`,
    );
  }

  const withContext = countOccurrences(
    registrations.map(({ call, macro }) => {
      const key = literalString(call.args[0]);
      const symbol = symbolAt(source, call.start);
      return { call, key, macro, symbol };
    }),
    ({ key, symbol }) => `${symbol}\u0000${key}`,
  );

  const definitions = withContext.map(
    ({ call, key, macro, symbol, occurrence }, index) => {
      const nextStart = registrations[index + 1]?.call.start ?? source.length;
      const block = source.slice(call.end, nextStart);
      const mode = macro
        ? "comSimple"
        : (block.match(/\bdef\s*->\s*mode\s*=\s*([A-Za-z_:][\w:]*)\s*;/)?.[1] ??
          "comSimple");
      const labelExpression = macro
        ? call.args[2]
        : (block.match(/\bdef\s*->\s*label\s*=\s*([^;]+);/)?.[1] ?? "");
      const categoryExpression =
        block.match(/\bdef\s*->\s*category\s*=\s*([^;]+);/)?.[1] ?? "";
      const id = stableId("setting-definition", symbol, key, occurrence);
      return item(
        "settingDefinitions",
        id,
        literalString(labelExpression) ?? key,
        [ref(snapshot, path, source, call.line, symbol)],
        {
          category: literalString(categoryExpression),
          key,
          macroExpanded: macro,
          mode,
          occurrence,
          optionType: normalizedExpression(call.args[1]),
          symbol,
        },
      );
    },
  );

  const configSource = snapshot.read(PATHS.config);
  const modeEnum = extractEnum(configSource, "ConfigOptionMode");
  const modes = modeEnum.values.map((value) =>
    item(
      "settingModes",
      stableId("setting-mode", value.name),
      value.name,
      [
        ref(
          snapshot,
          PATHS.config,
          configSource,
          value.line,
          "ConfigOptionMode",
        ),
      ],
      { name: value.name, valueExpression: value.valueExpression },
    ),
  );

  const keyCounts = new Map();
  for (const definition of definitions)
    keyCounts.set(definition.key, (keyCounts.get(definition.key) ?? 0) + 1);
  return {
    definitions,
    modes,
    summary: {
      duplicateKeys: [...keyCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([key, count]) => ({ count, key }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      registrationCount: definitions.length,
      registrationCountExplanation:
        "789 active literal registrations are extracted: 744 direct this->add calls plus 45 new_def macro invocations. " +
        "The plan audit's approximate 783 count is the number of literal this->add spellings before comment/macro handling, not the runtime registry size.",
      uniqueKeyCount: keyCounts.size,
    },
  };
}

function displayExpression(expression) {
  return (
    literalString(expression) ?? `<runtime:${normalizedExpression(expression)}>`
  );
}

function extractTabs(snapshot) {
  const path = PATHS.tab;
  const source = snapshot.read(path);
  const events = [
    ...findCalls(source, "add_options_page").map((call) => ({
      kind: "page",
      call,
    })),
    ...findCalls(source, "new_optgroup").map((call) => ({
      kind: "group",
      call,
    })),
    ...findCalls(source, "append_single_option_line").map((call) => ({
      kind: "option",
      call,
    })),
  ].sort((a, b) => a.call.start - b.call.start);

  const rawGroups = events.filter(({ kind }) => kind === "group");
  const explicitOptions = events.filter(
    ({ kind, call }) => kind === "option" && /^\s*"/.test(call.args[0] ?? ""),
  );
  if (rawGroups.length !== 93) {
    throw new Error(
      `Tab group sanity check failed: expected 93 active calls, found ${rawGroups.length}`,
    );
  }
  if (explicitOptions.length !== 424) {
    throw new Error(
      `Tab placement sanity check failed: expected 424 active literal calls, found ${explicitOptions.length}`,
    );
  }

  const occurrence = new Map();
  const pages = [];
  const groups = [];
  const placements = [];
  let currentSymbol = "";
  let currentPage = "<unscoped>";
  let currentGroup = "<unscoped>";
  for (const { kind, call } of events) {
    const symbol = symbolAt(source, call.start);
    if (symbol !== currentSymbol) {
      currentSymbol = symbol;
      currentPage = "<unscoped>";
      currentGroup = "<unscoped>";
    }
    if (kind === "page") {
      currentPage = displayExpression(call.args[0]);
      currentGroup = "<unscoped>";
      const key = `${symbol}\u0000${currentPage}`;
      const nth = (occurrence.get(key) ?? 0) + 1;
      occurrence.set(key, nth);
      pages.push(
        item(
          "settingTabs",
          stableId("setting-tab", symbol, currentPage, nth),
          currentPage,
          [ref(snapshot, path, source, call.line, symbol)],
          { occurrence: nth, symbol },
        ),
      );
    } else if (kind === "group") {
      currentGroup = displayExpression(call.args[0]);
      const key = `${symbol}\u0000${currentPage}\u0000${currentGroup}`;
      const nth = (occurrence.get(key) ?? 0) + 1;
      occurrence.set(key, nth);
      groups.push(
        item(
          "settingGroups",
          stableId("setting-group", symbol, currentPage, currentGroup, nth),
          currentGroup,
          [ref(snapshot, path, source, call.line, symbol)],
          { occurrence: nth, symbol, tab: currentPage },
        ),
      );
    } else if (/^\s*"/.test(call.args[0] ?? "")) {
      const optionKey = literalString(call.args[0]);
      const key = `${symbol}\u0000${currentPage}\u0000${currentGroup}\u0000${optionKey}`;
      const nth = (occurrence.get(key) ?? 0) + 1;
      occurrence.set(key, nth);
      placements.push(
        item(
          "settingPlacements",
          stableId(
            "setting-placement",
            symbol,
            currentPage,
            currentGroup,
            optionKey,
            nth,
          ),
          optionKey,
          [ref(snapshot, path, source, call.line, symbol)],
          {
            group: currentGroup,
            occurrence: nth,
            optionKey,
            symbol,
            tab: currentPage,
          },
        ),
      );
    }
  }
  return { groups, pages, placements };
}

function extractPresetTypes(snapshot) {
  const source = snapshot.read(PATHS.preset);
  const enumeration = extractEnum(source, "Type");
  return enumeration.values
    .filter(({ name }) => !["TYPE_INVALID", "TYPE_COUNT"].includes(name))
    .map((value) =>
      item(
        "presetTypes",
        stableId("preset-type", value.name),
        value.name,
        [ref(snapshot, PATHS.preset, source, value.line, "Preset::Type")],
        { name: value.name, valueExpression: value.valueExpression },
      ),
    );
}

function extractMenuActions(snapshot) {
  const specs = [
    { callee: "append_menu_item", idIndex: 1, labelIndex: 2, kind: "action" },
    {
      callee: "append_menu_check_item",
      idIndex: 1,
      labelIndex: 2,
      kind: "check-action",
    },
    { callee: "append_submenu", idIndex: 2, labelIndex: 3, kind: "submenu" },
    {
      callee: "AddDropDownSubMenu",
      idIndex: null,
      labelIndex: 1,
      kind: "submenu",
    },
    { callee: "AppendSubMenu", idIndex: null, labelIndex: 1, kind: "submenu" },
    { callee: "new wxMenuItem", idIndex: 1, labelIndex: 2, kind: "action" },
  ];
  const raw = [];
  for (const path of MENU_PATHS) {
    const source = snapshot.read(path);
    for (const spec of specs) {
      for (const call of findCalls(source, spec.callee)) {
        const label = literalString(call.args[spec.labelIndex]);
        if (!label) continue; // Runtime labels belong in the reviewed overlay.
        const symbol = symbolAt(source, call.start);
        raw.push({
          call,
          kind: spec.kind,
          label,
          path,
          source,
          symbol,
          nativeId:
            spec.idIndex === null
              ? null
              : normalizedExpression(call.args[spec.idIndex]),
        });
      }
    }
  }
  raw.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.call.start - b.call.start ||
      a.kind.localeCompare(b.kind),
  );
  return countOccurrences(
    raw,
    ({ kind, label, nativeId, symbol }) =>
      `${symbol}\u0000${kind}\u0000${nativeId}\u0000${label}`,
  ).map(({ call, kind, label, nativeId, occurrence, path, source, symbol }) =>
    item(
      "menuActions",
      stableId("menu-action", symbol, kind, nativeId, label, occurrence),
      label,
      [ref(snapshot, path, source, call.line, symbol)],
      { kind, nativeId, occurrence, symbol },
    ),
  );
}

function extractGizmos(snapshot) {
  const header = snapshot.read(PATHS.gizmoHeader);
  const manager = snapshot.read(PATHS.gizmoManager);
  const values = extractEnum(header, "EType").values.filter(
    ({ name }) => name !== "Undefined",
  );
  const calls = findCalls(manager, "m_gizmos.emplace_back").filter((call) =>
    /\bnew\s+GLGizmo/.test(call.args[0] ?? ""),
  );
  if (calls.length !== values.length) {
    throw new Error(
      `Gizmo registry mismatch: ${values.length} enum values, ${calls.length} constructors`,
    );
  }
  return calls.map((call, index) => {
    const value = values[index];
    const expression = call.args[0];
    const className = expression.match(/\bnew\s+(GLGizmo\w+)/)?.[1];
    const explicitType = expression.match(/\bEType::(\w+)/)?.[1] ?? null;
    if (explicitType && explicitType !== value.name) {
      throw new Error(
        `Gizmo order mismatch at ${className}: enum ${value.name}, constructor ${explicitType}`,
      );
    }
    return item(
      "gizmos",
      stableId("gizmo", value.name),
      value.name,
      [
        ref(
          snapshot,
          PATHS.gizmoHeader,
          header,
          value.line,
          "GLGizmosManager::EType",
        ),
        ref(
          snapshot,
          PATHS.gizmoManager,
          manager,
          call.line,
          "GLGizmosManager::init",
        ),
      ],
      { className, type: value.name },
    );
  });
}

function extractFormatFilters(snapshot) {
  const header = snapshot.read(PATHS.guiAppHeader);
  const source = snapshot.read(PATHS.guiApp);
  const types = extractEnum(header, "FileType")
    .values.map(({ name }) => name)
    .filter((name) => name !== "FT_SIZE");
  const pattern =
    /\/\*\s*(FT_\w+)\s*\*\/\s*\{\s*"([^"]+)"sv\s*,\s*\{([^}]*)\}\s*\}/gs;
  const rows = [];
  for (const match of source.matchAll(pattern)) {
    const type = match[1];
    const line = source.slice(0, match.index).split("\n").length;
    const extensions = [...match[3].matchAll(/"([^"]+)"sv/g)].map(
      (entry) => entry[1],
    );
    const platform =
      type === "FT_MODEL"
        ? source
            .slice(Math.max(0, match.index - 500), match.index)
            .lastIndexOf("#ifdef __APPLE__") >
          source
            .slice(Math.max(0, match.index - 500), match.index)
            .lastIndexOf("#else")
          ? "apple"
          : "non-apple"
        : "all";
    rows.push({ extensions, line, platform, title: match[2], type });
  }
  for (const type of types) {
    if (!rows.some((row) => row.type === type))
      throw new Error(`Missing FileWildcards row for ${type}`);
  }
  return rows.map((row) =>
    item(
      "formatFilters",
      stableId("format-filter", row.type, row.platform),
      row.title,
      [ref(snapshot, PATHS.guiApp, source, row.line, "file_wildcards_by_type")],
      row,
    ),
  );
}

function extractPreview(snapshot) {
  const viewer = snapshot.read(PATHS.gcodeViewer);
  const roles = snapshot.read(PATHS.extrusionRoles);
  const modes = extractEnum(viewer, "EViewType")
    .values.filter(({ name }) => name !== "Count")
    .map((value) =>
      item(
        "previewModes",
        stableId("preview-mode", value.name),
        value.name,
        [
          ref(
            snapshot,
            PATHS.gcodeViewer,
            viewer,
            value.line,
            "GCodeViewer::EViewType",
          ),
        ],
        { name: value.name, valueExpression: value.valueExpression },
      ),
    );
  const filters = extractEnum(roles, "ExtrusionRole")
    .values.filter(
      ({ name }) => !["erNone", "erMixed", "erCount"].includes(name),
    )
    .map((value) =>
      item(
        "previewFilters",
        stableId("preview-filter", value.name),
        value.name,
        [
          ref(
            snapshot,
            PATHS.extrusionRoles,
            roles,
            value.line,
            "ExtrusionRole",
          ),
        ],
        { name: value.name, valueExpression: value.valueExpression },
      ),
    );
  return { filters, modes };
}

function extractCalibration(snapshot) {
  const source = snapshot.read(PATHS.calibration);
  return extractEnum(source, "CalibMode")
    .values.filter(({ name }) => name !== "Calib_None")
    .map((value) =>
      item(
        "calibrationFlows",
        stableId("calibration-flow", value.name),
        value.name,
        [ref(snapshot, PATHS.calibration, source, value.line, "CalibMode")],
        { mode: value.name, valueExpression: value.valueExpression },
      ),
    );
}

function extractDevicePages(snapshot) {
  const acceptedMainPages = new Set(["Device", "Multi-device"]);
  const rows = [];
  for (const path of [PATHS.mainFrame, PATHS.monitor]) {
    const source = snapshot.read(path);
    for (const callee of ["AddPage", "InsertPage"]) {
      for (const call of findCalls(source, callee)) {
        const label = literalString(call.args[1]);
        if (!label) continue;
        if (path === PATHS.mainFrame && !acceptedMainPages.has(label)) continue;
        rows.push({
          call,
          label,
          path,
          source,
          symbol: symbolAt(source, call.start),
        });
      }
    }
  }
  rows.sort(
    (a, b) => a.path.localeCompare(b.path) || a.call.start - b.call.start,
  );
  return countOccurrences(
    rows,
    ({ label, symbol }) => `${symbol}\u0000${label}`,
  ).map(({ call, label, occurrence, path, source, symbol }) =>
    item(
      "devicePages",
      stableId("device-page", symbol, label, occurrence),
      label,
      [ref(snapshot, path, source, call.line, symbol)],
      { occurrence, symbol },
    ),
  );
}

function resolveRuntimeItems(snapshot, overlay) {
  return (overlay.runtimeItems ?? []).map((runtime) => {
    const source = snapshot.read(runtime.source.path);
    const matches = [];
    let from = 0;
    while (true) {
      const offset = source.indexOf(runtime.source.anchor, from);
      if (offset < 0) break;
      matches.push(offset);
      from = offset + runtime.source.anchor.length;
    }
    if (matches.length !== 1) {
      throw new Error(
        `Runtime overlay anchor for ${runtime.id} is stale: expected exactly one match, found ${matches.length}`,
      );
    }
    const offset = matches[0];
    const actualSymbol = symbolAt(source, offset);
    if (actualSymbol !== runtime.source.symbol) {
      throw new Error(
        `Runtime overlay symbol for ${runtime.id} is stale: expected ${runtime.source.symbol}, found ${actualSymbol}`,
      );
    }
    const line = source.slice(0, offset).split("\n").length;
    return item(
      runtime.family,
      runtime.id,
      runtime.label,
      [ref(snapshot, runtime.source.path, source, line, actualSymbol)],
      { kind: "runtime-outcome", reviewedOverlay: true },
    );
  });
}

export function inventoryLeaves(inventory) {
  return Object.values(inventory).flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
}

function applyDispositions(inventory, overlay, { allowUnmapped = false } = {}) {
  const leaves = inventoryLeaves(inventory);
  const byId = new Map();
  for (const mapping of overlay.mappings ?? []) {
    if (byId.has(mapping.id))
      throw new Error(`Duplicate disposition mapping: ${mapping.id}`);
    byId.set(mapping.id, mapping);
  }
  const leafIds = new Set(leaves.map(({ id }) => id));
  if (leafIds.size !== leaves.length)
    throw new Error("Duplicate inventory leaf IDs detected");
  const stale = [...byId.keys()].filter((id) => !leafIds.has(id));
  if (stale.length)
    throw new Error(
      `Stale disposition mapping(s): ${stale.slice(0, 8).join(", ")}`,
    );

  return Object.fromEntries(
    Object.entries(inventory).map(([family, entries]) => {
      if (!Array.isArray(entries)) return [family, entries];
      return [
        family,
        entries.map((entry) => {
          const mapping = byId.get(entry.id);
          if (!mapping && !allowUnmapped)
            throw new Error(`Unmapped upstream parity leaf: ${entry.id}`);
          return {
            ...entry,
            disposition: mapping
              ? {
                  id: mapping.dispositionId,
                  kind: mapping.kind ?? "task",
                  rationale: mapping.rationale ?? null,
                }
              : null,
          };
        }),
      ];
    }),
  );
}

export function buildManifest({
  source = new PinnedSource(),
  overlay = readOverlay(),
  allowUnmapped = false,
} = {}) {
  if (overlay.schemaVersion !== 1)
    throw new Error(
      `Unsupported disposition overlay schema ${overlay.schemaVersion}`,
    );
  const settings = extractSettings(source);
  const tabs = extractTabs(source);
  const preview = extractPreview(source);
  const inventory = {
    calibrationFlows: extractCalibration(source),
    devicePages: extractDevicePages(source),
    formatFilters: extractFormatFilters(source),
    gizmos: extractGizmos(source),
    menuActions: extractMenuActions(source),
    presetTypes: extractPresetTypes(source),
    previewFilters: preview.filters,
    previewModes: preview.modes,
    settingDefinitions: settings.definitions,
    settingGroups: tabs.groups,
    settingModes: settings.modes,
    settingPlacements: tabs.placements,
    settingTabs: tabs.pages,
  };
  for (const runtime of resolveRuntimeItems(source, overlay)) {
    if (!Array.isArray(inventory[runtime.family])) {
      throw new Error(
        `Runtime overlay uses unknown inventory family ${runtime.family}`,
      );
    }
    inventory[runtime.family].push(runtime);
  }
  for (const entries of Object.values(inventory)) {
    entries.sort((a, b) => a.id.localeCompare(b.id));
  }
  const disposed = applyDispositions(inventory, overlay, { allowUnmapped });
  const counts = Object.fromEntries(
    Object.entries(disposed).map(([family, entries]) => [
      family,
      entries.length,
    ]),
  );
  counts.total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const sources = [...source.cache.entries()]
    .map(([path, record]) => ({ blob: record.blob, path }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    counts,
    extractor: {
      name: "OrcaXR Snapmaker parity extractor",
      version: EXTRACTOR_VERSION,
    },
    inventory: disposed,
    schemaVersion: 1,
    sourceFiles: sources,
    summaries: {
      settings: settings.summary,
      syntaxSanity: {
        activeExplicitTabOptionPlacements: 424,
        activeDirectPrintConfigRegistrations: 744,
        activeMacroPrintConfigRegistrations: 45,
        activeTabGroups: 93,
        lexicalExplicitTabOptionPlacementsIncludingComments: 493,
        lexicalLiteralPrintConfigSpellingsIncludingComments: 783,
        lexicalTabGroupsIncludingComments: 122,
      },
    },
    upstream: {
      commit: source.commit,
      repository: UPSTREAM_REPOSITORY,
      tree: source.tree,
    },
  };
}

function seedDispositions(overlay, manifest) {
  if ((overlay.mappings ?? []).length !== 0) {
    throw new Error("Refusing to seed a non-empty reviewed disposition map");
  }
  const runtimeTasks = new Map(
    (overlay.runtimeItems ?? []).map((entry) => [entry.id, entry.seedTaskId]),
  );
  return inventoryLeaves(manifest.inventory)
    .map((leaf) => {
      const dispositionId =
        runtimeTasks.get(leaf.id) ?? SEED_TASK_BY_FAMILY[leaf.family];
      if (!dispositionId) throw new Error(`No bootstrap task for ${leaf.id}`);
      return { dispositionId, id: leaf.id, kind: "task" };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function parseArgs(argv) {
  const options = {
    check: false,
    output: MANIFEST_PATH,
    seed: false,
    stdout: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--check") options.check = true;
    else if (argv[i] === "--seed-dispositions") options.seed = true;
    else if (argv[i] === "--stdout") options.stdout = true;
    else if (argv[i] === "--output") options.output = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let overlay = readOverlay();
  if (options.seed) {
    const bootstrap = buildManifest({ overlay, allowUnmapped: true });
    overlay = { ...overlay, mappings: seedDispositions(overlay, bootstrap) };
    const persistedOverlay = {
      ...overlay,
      runtimeItems: (overlay.runtimeItems ?? []).map(
        ({ seedTaskId, ...entry }) => entry,
      ),
    };
    mkdirSync(dirname(DISPOSITIONS_PATH), { recursive: true });
    writeFileSync(DISPOSITIONS_PATH, canonicalJson(persistedOverlay));
    overlay = persistedOverlay;
  }
  const text = canonicalJson(buildManifest({ overlay }));
  if (options.stdout) process.stdout.write(text);
  if (options.check) {
    const current = readFileSync(options.output, "utf8");
    if (current !== text)
      throw new Error(
        `Generated parity manifest differs from ${options.output}`,
      );
  } else if (!options.stdout || options.output !== MANIFEST_PATH) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, text);
  }
  return text;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`parity extract: ${error.message}`);
    process.exitCode = 1;
  }
}
