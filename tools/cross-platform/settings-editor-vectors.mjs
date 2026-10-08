// Settings editor references from the production browser (`fields.ts`,
// `SettingsDraftEditor.ts`, `stepper.ts`, `scopedStepper.ts`,
// `fullSpectrumSemantics.ts`) over the pinned engine-option schema, replayed
// by the Rust port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { createEngineOptionCatalog } from "../../web/src/settings/generated/loader.ts";
import { SETTING_SCOPE_KEYS } from "../../web/src/settings/generated/settingScopes.ts";
import {
  assessFieldSupport,
  projectSettingsField,
  projectSettingsFields,
} from "../../web/src/settings/editor/fields.ts";
import { SettingsDraftEditor } from "../../web/src/settings/editor/SettingsDraftEditor.ts";
import { serializeSettingValue } from "../../web/src/settings/editor/codec.ts";
import {
  STEP_REFUSAL_REASON,
  stepFor,
  stepSettingValue,
} from "../../web/src/settings/editor/stepper.ts";
import {
  encodeProjectEditorCommitResult,
  encodeProjectEditorComparison,
  encodeProjectEditorCreate,
  encodeProjectEditorEdit,
  encodeProjectEditorEditResult,
  encodeProjectEditorField,
  encodeProjectEditorFieldRef,
  encodeProjectEditorFieldState,
  encodeProjectEditorQuery,
  encodeProjectEditorRow,
  encodeProjectEditorRowsRequest,
  encodeProjectEditorRuleRequest,
  encodeProjectEditorRules,
  encodeProjectEditorStep,
  encodeProjectEditorStepRequest,
} from "../../contracts/generated/project-intents.ts";
import { ScopedSettingsStepper } from "../../web/src/settings/editor/scopedStepper.ts";
import {
  expandFullSpectrumSettingsTransaction,
  getFullSpectrumDependencyState,
  getFullSpectrumSpecialEditorRequirement,
  validateFullSpectrumCrossFields,
} from "../../web/src/settings/editor/fullSpectrumSemantics.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const schemaPath = "web/src/settings/generated/engine-options.schema.json";
const catalog = createEngineOptionCatalog(JSON.parse(read(schemaPath)));
const definitions = catalog.definitions;
const indexOf = new Map(definitions.map((d, i) => [d.id, i]));
const placementIndex = new Map(
  catalog.schema.guiLayout.placements.map((p, i) => [p.id, i]),
);
const json = (value) => canonicalStringify(value);
const surfaces = [
  undefined,
  "process",
  "filament",
  "printer",
  "object",
  "plate",
];
const fold = (text) => text.normalize("NFKD").toLocaleLowerCase("en-US");
const field = (key) => catalog.get(key).id;

// Every definition's projection under each surface and technology.
const projections = definitions.map((d, index) => {
  const any = projectSettingsField(catalog, d, "any");
  return {
    index,
    label: any.label,
    ...(any.fullLabel ? { fullLabel: any.fullLabel } : {}),
    category: any.category,
    ...(any.tooltip ? { tooltip: any.tooltip } : {}),
    ...(any.unit ? { unit: any.unit } : {}),
    mode: any.mode,
    technology: any.technology,
    locations: any.guiLocations.map((l) => placementIndex.get(l.placement.id)),
    primary: surfaces.map((s) => {
      const p = projectSettingsField(catalog, d, "any", s).primaryGuiLocation;
      return p ? placementIndex.get(p.placement.id) : null;
    }),
    applicability: ["fff", "sla", "any"].map(
      (t) => projectSettingsField(catalog, d, t).applicability,
    ),
    support: surfaces.map((s) => {
      const support = assessFieldSupport(catalog, d, s);
      return support.status === "implemented" ? "" : support.reason;
    }),
    enumChoices: any.enumChoices.map((c) => [c.serialized, c.label]),
  };
});

// Field queries: modes, technologies, surfaces, scopes, filters and searches.
const queryCases = [];
const addQuery = (query) => {
  const fields = projectSettingsFields(catalog, query);
  queryCases.push({
    queryJson: json(query),
    fields: fields.map((f) =>
      query.search
        ? [
            indexOf.get(f.id),
            f.searchMatches.map((m) => [m.field, m.start, m.length, m.text]),
          ]
        : indexOf.get(f.id),
    ),
  });
};
for (const mode of ["simple", "advanced", "develop"])
  for (const technology of ["fff", "sla", "any"])
    addQuery({ mode, technology });
for (const guiSurface of surfaces.slice(1))
  addQuery({ mode: "develop", technology: "fff", guiSurface });
for (const scope of Object.keys(SETTING_SCOPE_KEYS))
  addQuery({
    mode: "advanced",
    technology: "fff",
    guiSurface: scope === "plate" ? "plate" : "process",
    scope,
    includeUnavailable: true,
    includeUnknownApplicability: true,
  });
addQuery({
  mode: "develop",
  technology: "sla",
  includeNonApplicable: true,
  includeUnknownApplicability: true,
  includeUnavailable: false,
});
addQuery({ mode: "simple", technology: "fff", includeUnavailable: false });
const searches = [
  "layer",
  "Layer height",
  "  speed   WALL speed ",
  "°c",
  "℃",
  "nozzle temp",
  "x",
  "ironing pattern",
  "support",
  "PrintConfigDef",
  "zzzz-no-match",
  "   ",
  "Quality",
  "process",
  "%",
  "mm3/s2",
  "180°",
  "Сlassic",
  "classic",
  "±0.35",
];
for (const search of searches) {
  addQuery({ mode: "develop", technology: "any", search });
  addQuery({
    mode: "advanced",
    technology: "fff",
    guiSurface: "process",
    search,
    includeUnknownApplicability: true,
  });
}

// The folding a host performs, for every non-ASCII text a query folds.
const foldings = {};
const texts = new Set(searches);
for (const p of projections)
  for (const t of [p.label, p.fullLabel, p.category, p.tooltip, p.unit])
    if (t) texts.add(t);
for (const d of definitions) {
  for (const a of d.behavior.aliases.value) texts.add(a);
  for (const c of projections[indexOf.get(d.id)].enumChoices)
    for (const t of c) texts.add(t);
}
for (const t of [
  ...catalog.schema.guiLayout.tabs,
  ...catalog.schema.guiLayout.groups,
])
  texts.add(t.label);
for (const t of texts) if (/[^\x00-\x7f]/.test(t)) foldings[t] = fold(t);

// Draft editors: states, comparisons, resets, commits and refusals.
const value = (v) => (v === undefined ? undefined : json(v));
const state = (editor, id) => {
  const s = editor.getFieldState(id);
  return {
    field: indexOf.get(id),
    ...(s.value !== undefined ? { valueJson: value(s.value) } : {}),
    ...(s.serializedValue !== undefined
      ? { serialized: s.serializedValue }
      : {}),
    origin: s.origin,
    hasLocalOverride: s.hasLocalOverride,
    changed: s.changed,
    draftChanged: s.draftChanged,
    ...(s.draftRaw !== undefined ? { draftRaw: s.draftRaw } : {}),
    ...(s.draftValue !== undefined
      ? { draftValueJson: value(s.draftValue) }
      : {}),
    ...(s.draftSerialized !== undefined
      ? { draftSerialized: s.draftSerialized }
      : {}),
    issues: s.issues.map(({ code, path, message }) => ({
      code,
      path,
      message,
    })),
  };
};
const comparison = (editor, id) => {
  const c = editor.compare(id);
  return {
    field: indexOf.get(id),
    ...(c.defaultValue !== undefined
      ? { defaultJson: value(c.defaultValue) }
      : {}),
    ...(c.inheritedValue !== undefined
      ? { inheritedJson: value(c.inheritedValue) }
      : {}),
    ...(c.overrideValue !== undefined
      ? { overrideJson: value(c.overrideValue) }
      : {}),
    ...(c.effectiveValue !== undefined
      ? { effectiveJson: value(c.effectiveValue) }
      : {}),
    ...(c.draftValue !== undefined ? { draftJson: value(c.draftValue) } : {}),
    effectiveEqualsDefault: c.effectiveEqualsDefault,
    draftEqualsEffective: c.draftEqualsEffective,
  };
};
const attempt = (run) => {
  try {
    return { ok: run() ?? null };
  } catch (error) {
    return {
      error: error.message,
      ...(error.issues
        ? {
            issues: error.issues.map(({ code, path, message }) => ({
              code,
              path,
              message,
            })),
          }
        : {}),
    };
  }
};
function editorScenario(name, options, steps) {
  editorDefinitions.push([options, steps]);
  let editor;
  // Member order follows canonical JSON, as a native host receives it.
  const created = attempt(() => {
    editor = new SettingsDraftEditor(catalog, JSON.parse(json(options)));
  });
  const out = [];
  if (editor)
    for (const s of steps) {
      const record = { stepJson: json(s) };
      if (s.op === "state")
        Object.assign(
          record,
          attempt(() => state(editor, s.field)),
        );
      else if (s.op === "compare")
        Object.assign(
          record,
          attempt(() => comparison(editor, s.field)),
        );
      else if (s.op === "set")
        Object.assign(
          record,
          attempt(() => editor.setDraft(s.field, s.raw)),
        );
      else if (s.op === "clear")
        Object.assign(
          record,
          attempt(() => editor.clearDraft(s.field)),
        );
      else if (s.op === "inherit")
        Object.assign(
          record,
          attempt(() => editor.resetToInherited(s.field)),
        );
      else if (s.op === "default")
        Object.assign(
          record,
          attempt(() => editor.resetToDefault(s.field)),
        );
      else if (s.op === "commit")
        Object.assign(
          record,
          attempt(() => {
            const c = editor.commit();
            return {
              baseRevision: c.baseRevision,
              revision: c.revision,
              changes: c.changes.map((ch) => ({
                field: indexOf.get(ch.fieldId),
                action: ch.action,
                ...(ch.previousValue !== undefined
                  ? { previousJson: value(ch.previousValue) }
                  : {}),
                ...(ch.value !== undefined
                  ? { valueJson: value(ch.value) }
                  : {}),
                ...(ch.serialized !== undefined
                  ? { serialized: ch.serialized }
                  : {}),
              })),
              nextOverridesJson: json(c.nextOverrides),
            };
          }),
        );
      else throw Error(s.op);
      record.revision = editor.getRevision();
      record.overridesJson = json(editor.getOverrides());
      out.push(record);
    }
  return {
    name,
    optionsJson: json(options),
    ...(created.error ? { error: created.error } : {}),
    steps: out,
  };
}
const editorDefinitions = [];
const unsupported = definitions.find(
  (d) => assessFieldSupport(catalog, d, "process").status !== "implemented",
);
const readonly = definitions.find((d) => d.presentation.readonly.value);
const editors = [
  editorScenario(
    "project",
    {
      mode: "advanced",
      technology: "fff",
      guiSurface: "process",
      inherited: {
        layer_height: 0.2,
        wall_loops: 3,
        sparse_infill_density: { percent: true, value: 15 },
        enable_support: false,
      },
      overrides: { wall_loops: 4, layer_height: 0.2 },
    },
    [
      ...[
        "layer_height",
        "wall_loops",
        "sparse_infill_density",
        "enable_support",
        "brim_width",
        "sparse_infill_pattern",
      ].flatMap((k) => [
        { op: "state", field: field(k) },
        { op: "compare", field: field(k) },
      ]),
      { op: "set", field: field("layer_height"), raw: "0.16" },
      { op: "set", field: field("wall_loops"), raw: "x" },
      { op: "state", field: field("wall_loops") },
      { op: "set", field: field("wall_loops"), raw: "2" },
      { op: "set", field: field("sparse_infill_density"), raw: "25%" },
      { op: "default", field: field("brim_width") },
      { op: "inherit", field: field("layer_height") },
      { op: "set", field: field("enable_support"), raw: "1" },
      { op: "set", field: field("sparse_infill_pattern"), raw: "gyroid" },
      ...[
        "layer_height",
        "wall_loops",
        "sparse_infill_density",
        "enable_support",
        "brim_width",
        "sparse_infill_pattern",
      ].flatMap((k) => [
        { op: "state", field: field(k) },
        { op: "compare", field: field(k) },
      ]),
      { op: "commit" },
      { op: "commit" },
      { op: "set", field: field("wall_loops"), raw: "-5" },
      { op: "set", field: field("layer_height"), raw: "abc" },
      { op: "commit" },
      { op: "clear", field: field("layer_height") },
      { op: "clear", field: field("wall_loops") },
      { op: "inherit", field: field("wall_loops") },
      { op: "commit" },
      { op: "set", field: "setting-definition:nope", raw: "1" },
      { op: "state", field: "setting-definition:nope" },
      { op: "set", field: unsupported.id, raw: "1" },
      { op: "set", field: readonly.id, raw: "1" },
      { op: "default", field: field("wall_loops") },
    ],
  ),
  editorScenario(
    "plate",
    {
      mode: "develop",
      technology: "any",
      guiSurface: "plate",
      scope: "plate",
      inherited: { curr_bed_type: "Cool Plate" },
      overrides: {},
    },
    [
      { op: "set", field: field("layer_height"), raw: "0.1" },
      ...SETTING_SCOPE_KEYS.plate.slice(0, 6).flatMap((k) => [
        { op: "state", field: field(k) },
        { op: "compare", field: field(k) },
      ]),
      { op: "commit" },
    ],
  ),
  editorScenario("unknown-inherited", { inherited: { "not-a-key": 1 } }, []),
  editorScenario("unknown-override", { overrides: { b_key: 1, a_key: 2 } }, []),
  editorScenario(
    "out-of-scope",
    { scope: "part", overrides: { layer_height: 0.2 } },
    [],
  ),
];

// Stepping every definition from its default and from edge values.
const stepped = (d, current, direction) => {
  try {
    const outcome = stepSettingValue(d, current, direction);
    return outcome.value === null
      ? { refusal: outcome.refusal }
      : outcome.value;
  } catch (error) {
    return { throws: error.message };
  }
};
const steps = definitions.map((d) => {
  const currents = new Set(["", "abc", "1", "true", "0"]);
  if (d.default.provided) {
    try {
      currents.add(serializeSettingValue(d, d.default.value));
    } catch {
      // An invalid default is stepped from the edge values alone.
    }
  }
  for (const bound of [d.constraints.min.value, d.constraints.max.value])
    if (bound !== null) {
      currents.add(String(bound));
      currents.add(String(bound + 0.5));
      currents.add(String(bound - 1e-7));
    }
  for (const c of projections[indexOf.get(d.id)].enumChoices)
    currents.add(c[0]);
  return [...currents].map((current) => [
    current,
    stepped(d, current, 1),
    stepped(d, current, -1),
  ]);
});
const stepForCases = [
  [0, 1],
  [0, 100],
  [0.05, 1],
  [1, 0],
  [5, 5],
  [-10, 10],
  [0, 0.3],
  [0, 999999],
  [0.0001, 0.0007],
  [-1e300, 1e300],
  [0, 7],
  [3, 2.5],
].map(([a, b]) => [a, b, stepFor(a, b)]);

// Keyboard-free rows for every scope, through the production controller.
async function rows(scope, mode, snapshot) {
  const stepper = new ScopedSettingsStepper({
    loadCatalog: async () => catalog,
    listTargets: () => [
      {
        id: "target",
        scope,
        label: "Target",
        path: "Target",
        overrideCount: 0,
      },
    ],
    adapterFor: () => ({
      load: () => snapshot,
      apply: () => snapshot,
    }),
    onChange: () => {},
    mode,
    technology: "fff",
  });
  stepper.selectTarget("target");
  stepper.getView();
  await stepper.whenIdle();
  await stepper.whenIdle();
  const view = stepper.getView();
  assert.equal(view.status, "ready");
  return {
    scope,
    mode,
    snapshotJson: json({
      inherited: snapshot.inherited,
      overrides: snapshot.overrides,
    }),
    unavailable: view.unavailable,
    rows: view.rows.map((r) => ({
      field: indexOf.get(r.fieldId),
      label: r.label,
      group: r.group,
      value: r.value,
      unit: r.unit,
      overridden: r.overridden,
      steppable: r.steppable,
      ...(r.reason ? { reason: r.reason } : {}),
      kind: r.kind,
      choices: r.choices.map((c) => [c.serialized, c.label]),
      ...(r.minimum !== undefined ? { minimum: r.minimum } : {}),
      ...(r.maximum !== undefined ? { maximum: r.maximum } : {}),
      integer: r.integer,
      typeable: r.typeable,
    })),
  };
}
const rowCases = [];
for (const scope of Object.keys(SETTING_SCOPE_KEYS))
  for (const mode of ["simple", "develop"])
    rowCases.push(
      await rows(scope, mode, {
        revision: 1,
        sourceHash: "x",
        inherited: { layer_height: 0.2, wall_loops: 2 },
        overrides:
          scope === "plate"
            ? {}
            : scope === "project"
              ? { layer_height: 0.24 }
              : { wall_loops: 5 },
      }),
    );

// Full Spectrum rules.
const fsValues = [
  {},
  { dithering_local_z_mode: true },
  { dithering_local_z_mode: false, dithering_local_z_infill: true },
  { dithering_local_z_mode: 1 },
  {
    mixed_filament_height_lower_bound: 0.3,
    mixed_filament_height_upper_bound: 0.2,
  },
  {
    mixed_filament_height_lower_bound: 0.2,
    mixed_filament_height_upper_bound: 0.2,
  },
  {
    mixed_filament_height_lower_bound: -0,
    mixed_filament_height_upper_bound: -1e-7,
  },
  {
    mixed_filament_height_lower_bound: "0.3",
    mixed_filament_height_upper_bound: 0.2,
  },
];
const fullSpectrum = fsValues.map((values) => ({
  valuesJson: json(values),
  expansions: [[], ["dithering_local_z_mode"], ["other"]].map((changedKeys) => {
    try {
      const e = expandFullSpectrumSettingsTransaction({
        changedKeys,
        effectiveValues: values,
      });
      return {
        changedKeys,
        effectiveJson: json(e.effectiveValues),
        implicit: e.implicitKeys.map((k) => [k, e.implicitValues[k]]),
      };
    } catch (error) {
      return { changedKeys, error: error.message };
    }
  }),
  dependencies: [
    "dithering_local_z_whole_objects",
    "dithering_local_z_infill",
    "dithering_local_z_direct_multicolor",
    "dithering_local_z_mode",
    "layer_height",
  ].map((key) => {
    const d = getFullSpectrumDependencyState(key, values);
    return d ? [key, d.enabled] : [key, null];
  }),
  crossField: validateFullSpectrumCrossFields(values).map((i) => i.message),
}));
const specialEditors = ["mixed_filament_definitions", "layer_height", ""].map(
  (key) => [
    key,
    getFullSpectrumSpecialEditorRequirement(key)?.unavailableReason ?? null,
  ],
);

// The host exchange, encoded by the generated TypeScript codecs: what a
// binding returns for each request. Large lists are sampled; every position's
// field ID is checked against `ids`.
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const camel = (value) => value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const optionalText = (value) =>
  value === undefined || value === null
    ? { absent: {} }
    : { value: units(value) };
const optional = (value, map = (v) => v) =>
  value === undefined || value === null
    ? { absent: {} }
    : { value: map(value) };
const valueJson = (value) => optional(value, (v) => units(json(v)));
const wireField = (f) => ({
  id: units(f.id),
  key: units(f.key),
  owner: units(f.owner),
  label: units(f.label),
  fullLabel: optionalText(f.fullLabel),
  category: units(f.category),
  tooltip: optionalText(f.tooltip),
  unit: optionalText(f.unit),
  mode: f.mode,
  technology: f.technology,
  applicability: camel(f.applicability),
  support:
    f.support.status === "implemented"
      ? { implemented: {} }
      : { unavailable: units(f.support.reason) },
  locations: f.guiLocations.map((l) => ({
    tabId: units(l.tab.id),
    tab: units(l.tab.label),
    tabOrder: l.tab.order,
    groupId: units(l.group.id),
    group: units(l.group.label),
    groupOrder: l.group.order,
    placementId: units(l.placement.id),
    order: l.placement.order,
    surface: l.placement.surface,
  })),
  primary: optional(
    f.primaryGuiLocation
      ? f.guiLocations.indexOf(f.primaryGuiLocation)
      : undefined,
  ),
  enumChoices: f.enumChoices.map((c) => ({
    serialized: units(c.serialized),
    label: units(c.label),
  })),
  matches: f.searchMatches.map((m) => ({
    field: m.field,
    start: m.start,
    length: m.length,
    text: units(m.text),
  })),
});
const wireIssues = (issues) =>
  issues.map(({ code, path, message }) => ({
    code: units(code),
    path: units(path),
    message: units(message),
  }));
const wireQuery = (q) => ({
  mode: q.mode,
  technology: q.technology,
  surface: optional(q.guiSurface),
  scope: optional(q.scope && camel(q.scope)),
  search: units(q.search ?? ""),
  includeNonApplicable: q.includeNonApplicable === true,
  includeUnknownApplicability: q.includeUnknownApplicability === true,
  includeUnavailable: q.includeUnavailable !== false,
});
const sample = (length) =>
  [...new Set([0, 1, Math.floor(length / 2), length - 1])].filter(
    (i) => i >= 0 && i < length,
  );
const wireQueries = queryCases.map((c) => {
  const query = JSON.parse(c.queryJson);
  const fields = projectSettingsFields(catalog, query);
  return {
    requestJson: encodeProjectEditorQuery(wireQuery(query)),
    count: fields.length,
    samples: sample(fields.length).map((i) => [
      i,
      encodeProjectEditorField(wireField(fields[i])),
    ]),
  };
});
const wireCreate = (options) =>
  encodeProjectEditorCreate({
    mode: options.mode ?? "advanced",
    technology: options.technology ?? "fff",
    surface: optional(options.guiSurface),
    scope: optional(options.scope && camel(options.scope)),
    inheritedJson: units(json(options.inherited ?? {})),
    overridesJson: units(json(options.overrides ?? {})),
  });
function wireEditor(options, steps) {
  let editor;
  try {
    editor = new SettingsDraftEditor(catalog, JSON.parse(json(options)));
  } catch {
    return { createJson: wireCreate(options), refused: true, steps: [] };
  }
  const out = steps.map((s) => {
    const ref = encodeProjectEditorFieldRef({ fieldId: units(s.field ?? "") });
    const outcome = (run) => {
      try {
        run();
        return { applied: {} };
      } catch (error) {
        return {
          refused: {
            message: units(error.message),
            issues: wireIssues(error.issues ?? []),
          },
        };
      }
    };
    let record;
    if (s.op === "state" || s.op === "compare") {
      try {
        if (s.op === "state") {
          const v = editor.getFieldState(s.field);
          record = {
            requestJson: ref,
            replyJson: encodeProjectEditorFieldState({
              field: wireField(v.field),
              valueJson: valueJson(v.value),
              serialized: optionalText(v.serializedValue),
              origin: v.origin,
              hasLocalOverride: v.hasLocalOverride,
              changed: v.changed,
              draftChanged: v.draftChanged,
              draftRaw: optionalText(v.draftRaw),
              draftValueJson: valueJson(v.draftValue),
              draftSerialized: optionalText(v.draftSerialized),
              issues: wireIssues(v.issues),
            }),
          };
        } else {
          const c = editor.compare(s.field);
          record = {
            requestJson: ref,
            replyJson: encodeProjectEditorComparison({
              fieldId: units(c.fieldId),
              key: units(c.key),
              defaultJson: valueJson(c.defaultValue),
              inheritedJson: valueJson(c.inheritedValue),
              overrideJson: valueJson(c.overrideValue),
              effectiveJson: valueJson(c.effectiveValue),
              draftJson: valueJson(c.draftValue),
              effectiveEqualsDefault: c.effectiveEqualsDefault,
              draftEqualsEffective: c.draftEqualsEffective,
            }),
          };
        }
      } catch {
        record = { requestJson: ref, refused: true };
      }
    } else if (s.op === "commit") {
      let result;
      try {
        const c = editor.commit();
        result = {
          committed: {
            baseRevision: c.baseRevision,
            revision: c.revision,
            changes: c.changes.map((ch) => ({
              fieldId: units(ch.fieldId),
              key: units(ch.key),
              owner: units(ch.owner),
              action: ch.action,
              previousJson: valueJson(ch.previousValue),
              valueJson: valueJson(ch.value),
              serialized: optionalText(ch.serialized),
            })),
            nextOverridesJson: units(json(c.nextOverrides)),
          },
        };
      } catch (error) {
        result = {
          refused: {
            message: units(error.message),
            issues: wireIssues(error.issues ?? []),
          },
        };
      }
      record = { replyJson: encodeProjectEditorCommitResult(result) };
    } else {
      const fieldId = units(s.field);
      const edit =
        s.op === "set"
          ? { set: { fieldId, raw: units(s.raw) } }
          : s.op === "clear"
            ? { clear: { fieldId } }
            : s.op === "inherit"
              ? { inherit: { fieldId } }
              : { reset: { fieldId } };
      const run =
        s.op === "set"
          ? () => editor.setDraft(s.field, s.raw)
          : s.op === "clear"
            ? () => editor.clearDraft(s.field)
            : s.op === "inherit"
              ? () => editor.resetToInherited(s.field)
              : () => editor.resetToDefault(s.field);
      record = {
        requestJson: encodeProjectEditorEdit(edit),
        replyJson: encodeProjectEditorEditResult(outcome(run)),
      };
    }
    return {
      ...record,
      revision: editor.getRevision(),
      overridesJson: json(editor.getOverrides()),
    };
  });
  return { createJson: wireCreate(options), steps: out };
}
const wireSteps = [];
steps.forEach((origins, index) => {
  if (index % 7 !== 0) return;
  for (const [current] of origins)
    for (const up of [true, false]) {
      let reply;
      try {
        const o = stepSettingValue(definitions[index], current, up ? 1 : -1);
        reply =
          o.value === null
            ? {
                refused: {
                  code: camel(o.refusal),
                  reason: units(STEP_REFUSAL_REASON[o.refusal]),
                },
              }
            : { value: units(o.value) };
      } catch (error) {
        reply = { codec: units(error.message) };
      }
      wireSteps.push({
        requestJson: encodeProjectEditorStepRequest({
          fieldId: units(definitions[index].id),
          current: units(current),
          up,
        }),
        replyJson: encodeProjectEditorStep(reply),
      });
    }
});
const wireRows = [];
for (const c of rowCases) {
  const snapshot = JSON.parse(c.snapshotJson);
  const surface = c.scope === "plate" ? "plate" : "process";
  const options = {
    mode: c.mode,
    technology: "fff",
    guiSurface: surface,
    ...(c.scope === "project" ? {} : { scope: c.scope }),
    inherited: snapshot.inherited,
    overrides: snapshot.overrides,
  };
  const editor = new SettingsDraftEditor(catalog, JSON.parse(json(options)));
  const fieldsById = new Map(
    editor
      .query({
        mode: c.mode,
        technology: "fff",
        guiSurface: surface,
        ...(c.scope === "project" ? {} : { scope: c.scope }),
        includeUnavailable: true,
        includeUnknownApplicability: true,
      })
      .map((f) => [f.id, f]),
  );
  wireRows.push({
    createJson: wireCreate(options),
    requestJson: encodeProjectEditorRowsRequest({ scope: camel(c.scope) }),
    count: c.rows.length,
    unavailable: c.unavailable,
    samples: sample(c.rows.length).map((i) => {
      const r = c.rows[i];
      return [
        i,
        encodeProjectEditorRow({
          field: wireField(fieldsById.get(definitions[r.field].id)),
          group: units(r.group),
          value: units(r.value),
          overridden: r.overridden,
          steppable: r.steppable,
          reason: optionalText(r.reason),
          kind: camel(r.kind),
          minimum: optional(r.minimum),
          maximum: optional(r.maximum),
          integer: r.integer,
          typeable: r.typeable,
        }),
      ];
    }),
  });
}
const wireRules = [];
for (const values of fsValues)
  for (const changedKeys of [[], ["dithering_local_z_mode"], ["other"]])
    for (const key of [
      "dithering_local_z_infill",
      "dithering_local_z_mode",
      "mixed_filament_definitions",
    ]) {
      let expansion;
      try {
        const e = expandFullSpectrumSettingsTransaction({
          changedKeys,
          effectiveValues: JSON.parse(json(values)),
        });
        expansion = {
          expanded: {
            effectiveJson: units(json(e.effectiveValues)),
            implicit: e.implicitKeys.map((k) => ({
              key: units(k),
              value: e.implicitValues[k],
            })),
          },
        };
      } catch (error) {
        expansion = { refused: units(error.message) };
      }
      const dependency = getFullSpectrumDependencyState(key, values);
      const cross = validateFullSpectrumCrossFields(values);
      wireRules.push({
        requestJson: encodeProjectEditorRuleRequest({
          changedKeys: changedKeys.map(units),
          key: units(key),
          effectiveJson: units(json(values)),
        }),
        replyJson: encodeProjectEditorRules({
          expansion,
          dependency: dependency
            ? { enabled: dependency.enabled }
            : { unmanaged: {} },
          crossField: optionalText(cross[0]?.message),
          structuredEditor: optionalText(
            getFullSpectrumSpecialEditorRequirement(key)?.unavailableReason,
          ),
        }),
      });
    }

const wireEditors = editorDefinitions.map(([options, steps]) =>
  wireEditor(options, steps),
);

const sources = [
  "tools/cross-platform/settings-editor-vectors.mjs",
  "web/src/settings/editor/fields.ts",
  "web/src/settings/editor/SettingsDraftEditor.ts",
  "web/src/settings/editor/stepper.ts",
  "web/src/settings/editor/scopedStepper.ts",
  "web/src/settings/editor/fullSpectrumSemantics.ts",
  "web/src/settings/editor/codec.ts",
  "contracts/project-intents.json",
  schemaPath,
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      projections,
      queryCases,
      foldings,
      editors,
      steps,
      stepForCases,
      rowCases,
      fullSpectrum,
      specialEditors,
      wire: {
        ids: definitions.map((d) => d.id),
        queryEditorJson: wireCreate({}),
        queries: wireQueries,
        editors: wireEditors,
        steps: wireSteps,
        rows: wireRows,
        rules: wireRules,
      },
    },
    null,
    1,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/settings-editor-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Settings editor reference drift",
  );
console.log(
  `settings editor: ${projections.length} fields, ${queryCases.length} queries, ` +
    `${editors.reduce((n, e) => n + e.steps.length, 0)} editor steps, ` +
    `${steps.reduce((n, s) => n + s.length, 0)} step origins, ${rowCases.length} row views`,
);
