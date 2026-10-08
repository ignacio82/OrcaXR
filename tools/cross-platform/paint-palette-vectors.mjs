// Paint palette references from the production browser (`paintPalette.ts`):
// every distinct filament library in the project corpora, plus edge cases
// derived from them, projected with and without unavailable recipes.
// Replayed by the Rust port.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { projectPaintPalette } from "../../web/src/project/painting/paintPalette.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const json = (value) => canonicalStringify(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

// Every filament library a corpus state carries, by canonical identity.
const corpora = [
  "testdata/cross-platform/project-command-vectors.json",
  "testdata/cross-platform/project-session-vectors.json",
  "testdata/cross-platform/canonical-complete-vectors.json",
  "testdata/cross-platform/project-model-vectors.json",
];
const libraries = new Map();
const visit = (value) => {
  if (
    typeof value === "string" &&
    value.startsWith("{") &&
    value.includes('"filaments"')
  ) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && parsed.filaments?.physical)
        libraries.set(json(parsed.filaments), parsed.filaments);
    } catch {
      // Not a state.
    }
    return;
  }
  if (Array.isArray(value)) value.forEach(visit);
  else if (value && typeof value === "object")
    Object.values(value).forEach(visit);
};
for (const path of corpora) visit(JSON.parse(read(path)));
const harvested = [...libraries.values()];
assert.ok(harvested.length > 0);

// Edge cases over a library that has both physical and mixed filaments.
const base = harvested.find(
  (l) => l.physical.length >= 2 && l.mixed.some((m) => m.fullSpectrum),
);
assert.ok(base, "a corpus library with a Full Spectrum recipe");
const variants = [];
const variant = (name, edit) => {
  const library = clone(base);
  edit(library);
  variants.push([name, library]);
};
variant("names-and-colors", (l) => {
  l.physical[0].name = "";
  l.physical[0].color = " #ABC ";
  l.physical[1].color = "#AABBCCDD";
  l.physical[1].material = "";
  for (const m of l.mixed) {
    m.name = "";
    m.displayColor = "";
  }
});
variant("bad-colors", (l) => {
  l.physical[0].color = "red";
  l.physical[1].color = "";
  for (const m of l.mixed) m.displayColor = "#12345";
});
variant("reordered-tools", (l) => {
  l.physical.reverse();
});
variant("disabled-and-deleted", (l) => {
  l.mixed.forEach((m, i) => {
    if (i % 2 === 0) m.enabled = false;
    else if (m.fullSpectrum) m.fullSpectrum.deleted = true;
  });
});
variant("missing-components", (l) => {
  l.physical = l.physical.slice(0, 1);
});
variant("zero-weights", (l) => {
  for (const m of l.mixed) for (const c of m.components) c.weight = 0;
});
variant("odd-weights", (l) => {
  for (const m of l.mixed)
    m.components.forEach((c, i) => (c.weight = [1, 2, 3.5][i % 3]));
});
variant("many-physical", (l) => {
  const extra = [];
  for (let i = 0; i < 10; i += 1)
    extra.push({
      ...clone(l.physical[0]),
      id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
      toolId: 20 + i,
    });
  l.physical.push(...extra);
});

const cases = [
  ...harvested.map((filaments, i) => [`corpus-${i}`, filaments]),
  ...variants,
].map(([name, filaments]) => ({
  name,
  filamentsJson: json(filaments),
  palettes: [false, true].map((includeUnavailable) =>
    // The default entry carries an explicit undefined keyboard number.
    json(clone(projectPaintPalette({ filaments }, { includeUnavailable }))),
  ),
}));

// The harvested libraries are embedded in the output, so a corpus that only
// changes its provenance does not invalidate this one.
const sources = [
  "tools/cross-platform/paint-palette-vectors.mjs",
  "web/src/project/painting/paintPalette.ts",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      cases,
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "testdata/cross-platform/paint-palette-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Paint palette reference drift",
  );
console.log(
  `paint palette: ${harvested.length} corpus libraries, ${variants.length} variants`,
);
