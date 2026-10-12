// How the shells arrange catalogue actions, from the production browser
// (`ActionPresentation.ts` through `ActionPresentationExchange.ts`): the
// command palette's search over the whole catalogue as every language the
// browser ships shows it (labels and hints through the registry's own text
// source) and over a catalogue of case-mapping edge cases — seeded substrings
// of labels, hints and ids, changed case, ECMAScript whitespace, split
// surrogate pairs, final sigma, dotted capital I — plus a context menu's
// sections and the model toolbar's runs over the catalogue's own menus and
// seeded selections of it, and the malformed requests both refuse. Replayed
// by Rust, by WASM in Node, and over JNI through the Kotlin wrapper.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { buildRegistry } from "../../web/src/actions/catalog.ts";
import {
  actionGroupsExchange,
  commandPaletteExchange,
} from "../../web/src/ui/ActionPresentationExchange.ts";
import { Localizer } from "../../web/src/l10n/Localizer.ts";
import { LOCALES, REFERENCE_LOCALE } from "../../web/src/l10n/locales.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
assert.equal(
  process.versions.unicode,
  "16.0",
  "The corpus is Unicode 16's lowercasing, as the core pins it",
);

// xorshift64*, seeded: the corpus is reproducible on any engine.
let seed = 0x9e3779b97f4a7c15n;
const next = () => {
  seed ^= seed >> 12n;
  seed ^= (seed << 25n) & 0xffffffffffffffffn;
  seed ^= seed >> 27n;
  return (seed * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const below = (n) => Number(next() % BigInt(n));
const pick = (values) => values[below(values.length)];

// ---- the palette ------------------------------------------------------------

const reference = JSON.parse(read("web/public/l10n/en.json"));
const entry = (action) => ({
  id: action.id,
  label: action.label,
  ...(action.hint === undefined ? {} : { hint: action.hint }),
});
const catalogues = [];
for (const locale of [
  REFERENCE_LOCALE,
  ...LOCALES.map((l) => l.id).filter((id) => id !== REFERENCE_LOCALE),
]) {
  const path = `web/public/l10n/${locale}.json`;
  let messages;
  try {
    messages = JSON.parse(read(path));
  } catch {
    continue;
  }
  const registry = buildRegistry();
  const l10n = new Localizer({ reference });
  l10n.setCatalog(locale, messages);
  registry.useTextSource(l10n);
  catalogues.push({
    name: locale,
    actions: registry.forSurface("command-palette").map(entry),
  });
}
assert.ok(catalogues.length >= 10, "the browser ships its languages");
// Case-mapping edge cases the catalogues do not carry.
catalogues.push({
  name: "edge cases",
  actions: [
    { id: "sigma", label: "ΟΔΟΣ ΣΑΣ", hint: "ΑΣͅ" },
    { id: "dotted_i", label: "İSTANBUL", hint: "Diyarbakır" },
    { id: "sharp_s", label: "STRASSE Straße ẞ" },
    { id: "lone\ud800surrogate", label: "a\udc00b\ud83d" },
    { id: "astral", label: "𐐀 Deseret 😀", hint: "𑢠 Warang Citi" },
    { id: "cherokee", label: "ᎠᎡ Ⴀ Ა ǅ Ⅰ" },
    { id: "spaces", label: "a b c﻿d", hint: "　tab\t" },
    { id: "ID_ONLY", label: "", hint: "" },
  ],
});

const WHITESPACE = [" ", "  ", "\t", " ", " ", "　", "﻿", "\n", ""];
const FIXED = [
  "",
  "   ",
  "　",
  "a",
  "A",
  "plate",
  " PLATE ",
  "cube",
  "tool_",
  "_",
  "zzzz",
  "σ",
  "ς",
  "ß",
  "i̇",
  "ı",
  "\ud800",
  "\udc00b",
  "\ud83d",
  "😀",
  "Ꭰ",
  "ꭰ",
  "ა",
  "ǆ",
  "ⅰ",
  "a b",
  "c﻿d",
];
const variants = [
  (s) => s,
  (s) => s.toUpperCase(),
  (s) => s.toLowerCase(),
  (s) => [...s].map((c, i) => (i % 2 ? c.toUpperCase() : c)).join(""),
];
const palette = [];
for (const [index, catalogue] of catalogues.entries()) {
  const actionsJson = JSON.stringify(catalogue.actions);
  const queries = [...FIXED];
  for (let i = 0; i < 60; i += 1) {
    const action = pick(catalogue.actions);
    const field = pick(["label", "label", "hint", "id"]);
    const source = action[field] ?? action.label;
    const start = below(Math.max(1, source.length));
    const piece = source.slice(start, start + 1 + below(9));
    queries.push(pick(WHITESPACE) + pick(variants)(piece) + pick(WHITESPACE));
  }
  for (const query of queries) {
    const request = `{"actions":${actionsJson},"query":${JSON.stringify(query)}}`;
    palette.push({
      catalogue: index,
      query: JSON.stringify(query),
      reply: commandPaletteExchange(request),
    });
  }
}

// ---- menus and the toolbar ----------------------------------------------------

const registry = buildRegistry();
const all = registry.allSource().map((action) => action.id);
const groups = [];
const arrange = (actions, layout) => {
  const request = JSON.stringify({ actions, layout });
  groups.push({ request, reply: actionGroupsExchange(request) });
};
for (const layout of ["context", "toolbar"]) {
  arrange([], layout);
  arrange(all, layout);
  arrange(registry.forContext("object").map((a) => a.id), layout);
  arrange(registry.forContext("plate").map((a) => a.id), layout);
  arrange(registry.forSurface("dom-toolbar").map((a) => a.id), layout);
  arrange(registry.forSurface("dom-menu").map((a) => a.id), layout);
  for (let i = 0; i < 40; i += 1) {
    // Seeded selections: in catalogue order, shuffled, with repeats.
    const chosen = all.filter(() => below(4) === 0);
    if (i % 3 === 1) chosen.sort(() => below(3) - 1);
    if (i % 5 === 2 && chosen.length) chosen.push(chosen[0]);
    arrange(chosen, layout);
  }
}

// ---- refusals -------------------------------------------------------------------

const refusals = [];
function refuse(exchange, request) {
  const run = { palette: commandPaletteExchange, groups: actionGroupsExchange }[exchange];
  assert.throws(() => run(request), /invalid_request/, request);
  refusals.push({ exchange, request });
}
refuse("palette", "{");
refuse("palette", "[]");
refuse("palette", JSON.stringify({ actions: [] }));
refuse("palette", JSON.stringify({ query: "" }));
refuse("palette", JSON.stringify({ actions: [], query: 1 }));
refuse("palette", JSON.stringify({ actions: {}, query: "" }));
refuse("palette", JSON.stringify({ actions: [{ id: "a" }], query: "" }));
refuse("palette", JSON.stringify({ actions: [{ label: "a" }], query: "" }));
refuse("palette", JSON.stringify({ actions: [{ id: "a", label: 1 }], query: "" }));
refuse("palette", JSON.stringify({ actions: [{ id: "a", label: "A", hint: null }], query: "" }));
refuse("palette", JSON.stringify({ actions: [{ id: "a", label: "A", extra: "x" }], query: "" }));
refuse("palette", JSON.stringify({ actions: ["a"], query: "" }));
refuse("palette", JSON.stringify({ actions: [], query: "", extra: 1 }));
refuse("groups", "{");
refuse("groups", JSON.stringify({ actions: ["mirror_x"] }));
refuse("groups", JSON.stringify({ layout: "context" }));
refuse("groups", JSON.stringify({ actions: ["mirror_x"], layout: "menu" }));
refuse("groups", JSON.stringify({ actions: ["not_an_action"], layout: "context" }));
refuse("groups", JSON.stringify({ actions: ["Mirror_X"], layout: "toolbar" }));
refuse("groups", JSON.stringify({ actions: ["mirror_x\ud800"], layout: "toolbar" }));
refuse("groups", JSON.stringify({ actions: [1], layout: "toolbar" }));
refuse("groups", JSON.stringify({ actions: "mirror_x", layout: "toolbar" }));
refuse("groups", JSON.stringify({ actions: [], layout: "context", extra: 1 }));

const sources = [
  "tools/cross-platform/action-presentation-vectors.mjs",
  "web/src/ui/ActionPresentation.ts",
  "web/src/ui/ActionPresentationExchange.ts",
  "web/src/actions/ActionRegistry.ts",
  ...catalogues
    .filter((c) => c.name !== "edge cases")
    .map((c) => `web/public/l10n/${c.name}.json`),
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    engine: { v8: process.versions.v8, unicode: process.versions.unicode },
    catalogues: catalogues.map((c) => ({
      name: c.name,
      actions: JSON.stringify(c.actions),
    })),
    palette,
    groups,
    refusals,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/action-presentation-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Action presentation reference drift",
  );
const matched = palette.filter((c) => c.reply !== '{"matches":[]}').length;
console.log(
  `Action presentation references: ${catalogues.length} catalogues, ${palette.length} palette searches ` +
    `(${matched} matching), ${groups.length} arrangements, ${refusals.length} malformed requests`,
);
