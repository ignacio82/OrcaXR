// Independent production OPC helper traces. Reconciliation and authoring results
// are separate: a preservable relationship can still refuse on XML authoring.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  canonicalStringify,
  projectFingerprint,
} from "../../web/src/project/domain/canonical.ts";
import { Bbs3mfProjectSerializer } from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import {
  ORCAXR_EXTENSION_FORMAT as format,
  ORCAXR_EXTENSION_PATH as envelopePath,
} from "../../web/src/project/serialization/CanonicalEnvelope.ts";
import {
  readSafeZip,
  writeDeterministicZip,
} from "../../web/src/project/serialization/deterministicZip.ts";
import {
  mergePackageRelationships,
  mergePackageContentTypes,
  buildRootRelationships,
  buildPartRelationships,
  buildContentTypes,
  resolveRelationshipTarget,
} from "../../web/src/project/serialization/opcPackage.ts";
const root = new URL("../../", import.meta.url),
  read = (p) => readFileSync(new URL(p, root));
const enc = new TextEncoder(),
  utf16 = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const fixture = createProjectFixture(),
  serializer = new Bbs3mfProjectSerializer();
const base = readSafeZip(
  (
    await serializer.serialize({
      state: fixture.state,
      assets: [fixture.asset],
      sourceRevision: 0,
      sourceHash: projectFingerprint(fixture.state),
    })
  ).bytes,
);
const cases = [],
  relsKey = `${format}/opc-relationships`,
  typesKey = `${format}/opc-content-types`;
const rootRels = "_rels/.rels",
  modelRels = "3D/_rels/3dmodel.model.rels",
  types = "[Content_Types].xml";
const row = (
  id = "custom",
  target = "/Metadata/note.txt",
  type = "urn:test",
  mode = "",
) => `<Relationship Id="${id}" Type="${type}" Target="${target}" ${mode}/>`;
function add(name, edit = () => {}) {
  const state = structuredClone(fixture.state),
    files = new Map([...base].map(([p, b]) => [p, b.slice()]));
  files.set("Metadata/note.txt", enc.encode("opaque fixture"));
  edit(state, files);
  // The envelope is the input for the staged integration, independently of the
  // pure OPC comparison. It is updated after edits to preserved extension data.
  const envelope = JSON.parse(
    new TextDecoder().decode(files.get(envelopePath)),
  );
  envelope.state = state;
  files.set(envelopePath, enc.encode(JSON.stringify(envelope)));
  const before = canonicalStringify(state);
  const warnings = [];
  let expected = null;
  try {
    mergePackageRelationships(state, files, warnings);
    mergePackageContentTypes(state, files, warnings);
    const merged = canonicalStringify(state),
      afterWarnings = warnings.map(utf16);
    const outputs = {};
    for (const kind of ["root", "model", "types"]) {
      const warnings = [];
      try {
        const text =
          kind === "root"
            ? buildRootRelationships(state, files, warnings)
            : kind === "model"
              ? buildPartRelationships(state, "3D/3dmodel.model", files)
              : buildContentTypes(files, state);
        outputs[kind] = { text, warnings: warnings.map(utf16) };
      } catch {
        outputs[kind] = null;
      }
    }
    expected = { stateJson: merged, warnings: afterWarnings, outputs };
  } catch {
    /* production refusal */
  }
  cases.push({
    name,
    stateJson: before,
    archiveHex: Buffer.from(writeDeterministicZip(files)).toString("hex"),
    expected,
  });
}
add("generated-baseline");
add("missing-all-parts", (s, f) => {
  for (const p of [rootRels, modelRels, types]) f.delete(p);
});
for (const [name, target] of [
  ["absolute", "/Metadata/note.txt"],
  ["relative", "Metadata/note.txt"],
  ["fragment", "/Metadata/note.txt#piece"],
  ["query", "/Metadata/note.txt?variant=1"],
  ["fragment-query", "/Metadata/note.txt?x=1&amp;y=2#part"],
  ["missing", "/Metadata/missing.txt"],
  ["escape", "../escape"],
  ["backslash", "Metadata\\note.txt"],
  ["percent", "/Metadata/%2e%2e/note.txt"],
  ["source-self", "#part"],
  ["empty-segments", "//Metadata/./note.txt"],
])
  add(`root-target-${name}`, (s, f) =>
    f.set(rootRels, enc.encode(row("r", target))),
  );
for (const target of [
  "../Metadata/note.txt",
  "../Metadata/note.txt#part",
  "../Metadata/note.txt?part=1",
  "../../escape",
  "/Metadata/note.txt",
  "./x/../../Metadata/note.txt",
])
  add(`model-target-${cases.length}`, (s, f) =>
    f.set(modelRels, enc.encode(row("r", target))),
  );
for (const mode of [
  "External",
  "external",
  "EXTERNAL",
  "Internal",
  "ignored",
  "",
])
  add(`mode-${mode}`, (s, f) =>
    f.set(
      rootRels,
      enc.encode(
        row(
          "r",
          "https://example.test/model?x=1#part",
          "urn:test",
          `TargetMode="${mode}"`,
        ),
      ),
    ),
  );
for (const source of [rootRels, modelRels]) {
  add(`duplicate-id-${source}`, (s, f) =>
    f.set(source, enc.encode(row("same") + row("same"))),
  );
  add(`incomplete-${source}`, (s, f) =>
    f.set(
      source,
      enc.encode(
        '<Relationship Id="r"/><Relationship Type="urn:test" Target="x"/>' +
          row("valid"),
      ),
    ),
  );
}
for (const xml of [
  '<relationship id="r" type="t" target="/Metadata/note.txt"/>',
  '<RELATIONSHIP Id="r" Type="t" Target="/Metadata/note.txt"/>',
  '<Relationship Id="r" id="other" Type="t" Target="/Metadata/note.txt"/>',
  '<Relationship Id="" id="other" Type="t" Target="/Metadata/note.txt"/>',
  '<Relationship Id="r" Id="other" Type="t" Target="/Metadata/note.txt"/>',
  '<Relationship Id="r" Type="t" Target="/Metadata/note.txt" extra="&unknown;"/>',
  '<Relationship Id="r" Type="t" Target="/Metadata/note.txt" extra="&#xD800;"/>',
  '<Relationship Id="r" Type="t" Target="/Metadata/note.txt" extra="&#1114112;"/>',
  '<Relationship Id="r" Type="t" Target="/Metadata/note.txt" extra="&#x1F433;"/>',
  '<Relationship Id="r" Type="t" Target="/Metadata/note.txt" extra="&#x000000000000000000000041;"/>',
  '<Relationship Id="r" Type="t" Target="/Metadata/note.txt" extra="&#0;"/>',
  '<Relationship Id="a&amp;&LT;&quot;&apos;&#13;&#10;&#9;" Type="t" Target="/Metadata/note.txt"/>',
  '<Relationship\u00a0Id\u2000=\uFEFF"r" Type="t" Target="/Metadata/note.txt"/>',
  '<Relationship 9Id="r" Type="t" Target="/Metadata/note.txt"/>',
  '<Relationship Id="r" Type="t" Target="/Metadata/note.txt" broken="a>b"/>',
  '<Relationship Id="r" Type="t" Target="/Metadata/note.txt"',
  '<Relationship:alias Id="r" Type="t" Target="/Metadata/note.txt"/>',
  '<x:Relationship Id="r" Type="t" Target="/Metadata/note.txt"/>',
  '<Relationships Id="r" Type="t" Target="/Metadata/note.txt"/>',
  "<!-- " + row() + " --><![CDATA[" + row("cdata") + "]]>",
  '\ufeff<?xml version="1.0"?><whatever>' + row() + "</whatever>",
])
  add(`scanner-${cases.length}`, (s, f) => f.set(rootRels, enc.encode(xml)));
add("invalid-utf8", (s, f) => f.set(rootRels, new Uint8Array([255])));
add("split-utf8-end", (s, f) =>
  f.set(types, new Uint8Array([60, 84, 121, 112, 101, 115, 62, 0xf0, 0x9f])),
);
for (const value of [
  null,
  {},
  [{}],
  [
    {
      source: "/",
      id: "r",
      type: "t",
      target: "/Metadata/note.txt",
      targetMode: "Internal",
      extra: "removed",
    },
  ],
  [
    {
      source: "/",
      id: "r\ud800",
      type: "t",
      target: "/Metadata/note.txt",
      targetMode: "Internal",
    },
  ],
])
  add(`preserved-rels-${cases.length}`, (s) => {
    s.extensionData = { [relsKey]: value, other: { retained: "😀" } };
  });
add("preserved-package-merge", (s, f) => {
  s.extensionData = {
    [relsKey]: [
      {
        source: "/",
        id: "r",
        type: "t",
        target: "/Metadata/note.txt",
        targetMode: "Internal",
      },
    ],
  };
  f.set(
    rootRels,
    enc.encode(row("r", "/Metadata/note.txt", "t") + row("another")),
  );
});
add("preserved-id-conflict-on-write", (s, f) => {
  s.extensionData = {
    [relsKey]: [
      {
        source: "/",
        id: "r",
        type: "old",
        target: "/Metadata/note.txt",
        targetMode: "Internal",
      },
    ],
  };
  f.set(rootRels, enc.encode(row("r")));
});
add("fixed-id-conflict-on-write", (s) => {
  s.extensionData = {
    [relsKey]: [
      {
        source: "/",
        id: "rel-3dmodel",
        type: "custom",
        target: "/Metadata/note.txt",
        targetMode: "Internal",
      },
    ],
  };
});
for (const xml of [
  '<Default Extension="TXT" ContentType="text/plain"/>',
  '<Default Extension="txt" ContentType="application/private"/>',
  '<Default Extension="unknown" ContentType="application/private"/>',
  '<Default Extension="model" ContentType="wrong"/>',
  '<Default Extension=".txt" ContentType="text/plain"/>',
  '<Default Extension="txt"/>',
  '<Override PartName="/Metadata/note.txt" ContentType="application/private"/>',
  '<Override PartName="/Metadata/missing.txt" ContentType="application/private"/>',
  '<Override PartName="relative" ContentType="text/plain"/>',
  '<Override PartName="/../escape" ContentType="text/plain"/>',
  '<Default Extension="txt" ContentType="one"/><Default Extension="TXT" ContentType="two"/>',
  '<Default Extension="txt" ContentType="application/private"/><Default Extension="txt" ContentType="text/plain"/>',
  '<Default Extension="txt" ContentType="&amp;&quot;&lt;&gt;&apos;"/>',
  '<Override PartName="/Metadata/note.txt" ContentType="&#0;"/>',
  '<default extension="txt" contentType="application/private"/>',
])
  add(`types-${cases.length}`, (s, f) => f.set(types, enc.encode(xml)));
for (const missing of [false, true])
  for (const raw of [
    null,
    {},
    [{}],
    [{ kind: "default", extension: "rels", contentType: "wrong" }],
    [
      {
        kind: "override",
        partName: "/Metadata/missing.txt",
        contentType: "x",
        extra: "removed",
      },
    ],
  ])
    add(`preserved-types-${cases.length}`, (s, f) => {
      s.extensionData = { [typesKey]: raw };
      if (missing) f.delete(types);
    });
add("unicode-path-suffixes", (s, f) => {
  for (const p of ["A.KONFIG", "B.İ", "C.ΟΣ", "D.Σ", "E.𐐀", "F.K"])
    f.set(p, enc.encode("unicode extension"));
  f.set(
    types,
    enc.encode(
      '<Default Extension="k" ContentType="application/octet-stream"/>',
    ),
  );
});
add("unicode-version-independent-suffixes", (s, f) => {
  // Assigned uppercase letters with new lowercase mappings after Unicode 16.
  for (const cp of [
    42958,
    42962,
    42964,
    ...Array.from({ length: 25 }, (_, i) => 93856 + i),
  ]) {
    for (const suffix of [
      String.fromCodePoint(cp),
      `AΣ${String.fromCodePoint(cp)}`,
    ]) {
      f.set(`Data.${suffix}`, enc.encode("pinned casing"));
    }
  }
});
add("nonstandard-suffixes-explicit-overrides", (s, f) => {
  for (const p of [
    "Metadata/data.Σ",
    "Metadata/space.x y",
    "Metadata/noext",
    "Metadata.v1/nodot",
    "Metadata/end.",
  ]) {
    f.set(p, enc.encode("retained bytes"));
  }
  f.set(
    types,
    enc.encode(
      '<Types><Override PartName="/Metadata/data.Σ" ContentType="application/x-private"/></Types>',
    ),
  );
});
for (const retain of [false, true]) {
  add(`generated-fallback-overrides-${retain}`, (s, f) => {
    const paths = [
      "Metadata/data.Σ",
      "Metadata/space.x y",
      "Metadata/noext",
      "Metadata.v1/nodot",
      "Metadata/end.",
    ];
    for (const p of paths) f.set(p, enc.encode("retained bytes"));
    f.set(
      types,
      enc.encode(
        `<Types>${paths.map((p) => `<Override PartName="/${p}" ContentType="application/octet-stream"/>`).join("")}</Types>`,
      ),
    );
    if (retain)
      s.extensionData = {
        [typesKey]: [
          {
            kind: "override",
            partName: `/${paths[0]}`,
            contentType: "application/octet-stream",
          },
        ],
      };
  });
}
add("preserved-fragment-query-dangling", (s) => {
  s.extensionData = {
    [relsKey]: [
      "/Metadata/note.txt#part",
      "/Metadata/note.txt?q=1",
      "/absent#part",
      "/absent#part",
    ].map((target, i) => ({
      source: "/",
      id: `p${i}`,
      type: "custom",
      target,
      targetMode: "Internal",
    })),
  };
});
add("missing-required-model", (s, f) => f.delete("3D/3dmodel.model"));
const paths = [];
for (const source of ["/", "3D/3dmodel.model"])
  for (const target of [
    "a",
    "/a",
    "../a",
    "../../a",
    "../Metadata/note.txt#x",
    "/a?b",
    "a%2fb",
    "a\\b",
    "a\u0000b",
    "a//./b",
    "/",
    "?q",
    "./",
    "a".repeat(513),
    "bad\ud800",
  ]) {
    let result = null;
    try {
      result = utf16(resolveRelationshipTarget(source, target));
    } catch {}
    paths.push({ source, target: utf16(target), resolved: result });
  }
const sources = [
  "tools/cross-platform/opc-vectors.mjs",
  "web/src/project/serialization/opcPackage.ts",
  "web/src/project/serialization/opcLowercase.ts",
  "web/src/project/serialization/opcCaseData.ts",
  "contracts/opc-lowercase.json",
  "tools/cross-platform/generate-opc-lowercase.mjs",
  "web/src/project/serialization/Bbs3mfProjectSerializer.ts",
  "web/src/project/serialization/CanonicalEnvelope.ts",
  "web/src/project/serialization/deterministicZip.ts",
  "web/src/project/__tests__/fixtures.ts",
  "web/src/project/domain/canonical.ts",
].sort();
const result =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      cases,
      paths,
    },
    null,
    2,
  ) + "\n";
const output = new URL("testdata/cross-platform/opc-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(output, result);
else assert.equal(readFileSync(output, "utf8"), result, "OPC reference drift");
console.log(
  `OPC references: ${cases.length} cases, ${cases.filter((c) => c.expected).length} merges, ${paths.length} target resolutions`,
);
