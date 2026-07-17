#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseGcodeText } from "./gcode.mjs";
import { normalizeThreeMf } from "./three-mf.mjs";
import { createZip } from "./zip.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DATA = join(ROOT, "testdata", "parity");
const PROJECT_RECIPE = join(DATA, "recipes", "reference-project");
const MUTATIONS_PATH = join(DATA, "recipes", "mutations.json");
const GCODE_RECIPE = join(DATA, "recipes", "reference.gcode");
const GEOMETRY_RECIPE = join(DATA, "recipes", "tetrahedron.json");
const FIXTURES = join(DATA, "fixtures");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function treeHash(entries) {
  return sha256(
    Buffer.concat(
      [...entries.entries()]
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .flatMap(([name, bytes]) => [
          Buffer.from(`${name}\0`),
          bytes,
          Buffer.from("\0"),
        ]),
    ),
  );
}

function recipeEntries(directory) {
  const entries = new Map();
  const visit = (current) => {
    for (const dirent of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, dirent.name);
      if (dirent.isDirectory()) visit(path);
      else if (dirent.isFile())
        entries.set(
          relative(directory, path).replaceAll("\\", "/"),
          readFileSync(path),
        );
    }
  };
  visit(directory);
  return entries;
}

function replaceExactlyOnce(source, find, replacement, label) {
  const first = source.indexOf(find);
  if (first < 0) throw new Error(`${label}: mutation needle was not found`);
  if (source.indexOf(find, first + find.length) >= 0)
    throw new Error(`${label}: mutation needle is ambiguous`);
  return `${source.slice(0, first)}${replacement}${source.slice(first + find.length)}`;
}

function writeOrCheck(path, content, check, changed) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (existsSync(path) && readFileSync(path).equals(bytes)) return;
  if (check) {
    changed.push(relative(ROOT, path));
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  changed.push(relative(ROOT, path));
}

function semanticHash(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function withoutUndefined(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

export function buildExpectedSummary(threeMfBytes, gcodeText) {
  const threeMf = normalizeThreeMf(threeMfBytes);
  return {
    schemaVersion: 1,
    threeMf: {
      normalizedSha256: semanticHash(threeMf),
      archiveMembers: Object.keys(threeMf.archive),
      relationships: threeMf.relationships,
      models: threeMf.models.map((model) => ({
        path: model.path,
        attributes: model.attributes,
        metadata: model.metadata,
        objects: model.objects.map((object) => ({
          attributes: object.attributes,
          components: object.components,
          mesh: object.mesh && {
            triangles: object.mesh.triangles,
            vertices: object.mesh.vertices,
          },
        })),
        build: model.build,
      })),
      settings: threeMf.settings,
      partAssignments: threeMf.partAssignments,
      facetAnnotations: threeMf.facetAnnotations,
      mixedFilamentDefinitions: threeMf.mixedFilamentDefinitions,
      platesSemanticSha256: semanticHash(threeMf.plates),
      customGcodeSemanticSha256: semanticHash(threeMf.customGcode),
      unknownExtensions: threeMf.unknownExtensions.map((extension) =>
        withoutUndefined({
          attribute: extension.attribute,
          kind: extension.kind,
          namespace: extension.namespace,
          path: extension.path,
          semanticSha256: semanticHash(extension.value),
        }),
      ),
    },
    gcode: parseGcodeText(gcodeText),
  };
}

function formatNumber(value) {
  const normalized = Object.is(value, -0) ? 0 : value;
  return Number.isInteger(normalized)
    ? String(normalized)
    : String(Number(normalized.toFixed(9)));
}

function formatStepNumber(value) {
  return Number.isInteger(value) ? `${value}.` : formatNumber(value);
}

function generateObj(recipe) {
  return [
    "# SPDX-License-Identifier: CC0-1.0",
    `o ${recipe.name}`,
    ...recipe.vertices.map(
      (vertex) => `v ${vertex.map(formatNumber).join(" ")}`,
    ),
    ...recipe.faces.map(
      (face) => `f ${face.map((index) => index + 1).join(" ")}`,
    ),
    "",
  ].join("\n");
}

function faceNormal(vertices, face) {
  const [a, b, c] = face.map((index) => vertices[index]);
  const ab = b.map((value, index) => value - a[index]);
  const ac = c.map((value, index) => value - a[index]);
  const cross = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const length = Math.hypot(...cross);
  return cross.map((value) => value / length);
}

function generateStl(recipe) {
  const lines = [`solid ${recipe.name}`];
  for (const face of recipe.faces) {
    lines.push(
      `  facet normal ${faceNormal(recipe.vertices, face).map(formatNumber).join(" ")}`,
    );
    lines.push("    outer loop");
    for (const index of face)
      lines.push(
        `      vertex ${recipe.vertices[index].map(formatNumber).join(" ")}`,
      );
    lines.push("    endloop", "  endfacet");
  }
  lines.push(`endsolid ${recipe.name}`, "");
  return lines.join("\n");
}

function generateStep(recipe) {
  const lines = [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('OrcaXR CC0 synthetic parity tetrahedron'),'2;1');",
    "FILE_NAME('tetrahedron.step','1980-01-01T00:00:00',('OrcaXR contributors'),('OrcaXR'),'','','');",
    "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));",
    "ENDSEC;",
    "DATA;",
    "#1=APPLICATION_CONTEXT('configuration controlled 3d designs of mechanical parts and assemblies');",
    "#2=APPLICATION_PROTOCOL_DEFINITION('international standard','config_control_design',1994,#1);",
    `#3=PRODUCT('${recipe.name}','${recipe.name}','',(#4));`,
    "#4=PRODUCT_CONTEXT('',#1,'mechanical');",
    "#5=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#3,.NOT_KNOWN.);",
    "#6=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');",
    "#7=PRODUCT_DEFINITION('design','',#5,#6);",
    "#8=PRODUCT_DEFINITION_SHAPE('','',#7);",
    "#9=(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#10)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#11,#12,#13)) REPRESENTATION_CONTEXT('',''));",
    "#10=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-6),#11,'','');",
    "#11=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.));",
    "#12=(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.));",
    "#13=(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT());",
  ];
  recipe.vertices.forEach((vertex, index) => {
    lines.push(
      `#${20 + index}=CARTESIAN_POINT('',(${vertex.map(formatStepNumber).join(",")}));`,
    );
  });
  const faceIds = [];
  recipe.faces.forEach((face, index) => {
    const base = 30 + index * 3;
    lines.push(
      `#${base}=POLY_LOOP('',(${face.map((vertex) => `#${20 + vertex}`).join(",")}));`,
    );
    lines.push(`#${base + 1}=FACE_OUTER_BOUND('',#${base},.T.);`);
    lines.push(`#${base + 2}=FACE('',(#${base + 1}));`);
    faceIds.push(`#${base + 2}`);
  });
  lines.push(
    `#50=CLOSED_SHELL('',(${faceIds.join(",")}));`,
    `#51=FACETED_BREP('${recipe.name}',#50);`,
    "#52=SHAPE_REPRESENTATION('',(#51),#9);",
    "#53=SHAPE_DEFINITION_REPRESENTATION(#8,#52);",
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  );
  return lines.join("\n");
}

function generatedGeometry() {
  const recipe = JSON.parse(readFileSync(GEOMETRY_RECIPE, "utf8"));
  if (
    !Array.isArray(recipe.vertices) ||
    !Array.isArray(recipe.faces) ||
    recipe.vertices.length < 4
  ) {
    throw new Error(
      "Geometry recipe must contain at least four vertices and a face list",
    );
  }
  for (const [index, vertex] of recipe.vertices.entries()) {
    if (
      !Array.isArray(vertex) ||
      vertex.length !== 3 ||
      vertex.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(
        `Geometry recipe vertex ${index} is not a finite XYZ triple`,
      );
    }
  }
  for (const [index, face] of recipe.faces.entries()) {
    if (
      !Array.isArray(face) ||
      face.length !== 3 ||
      face.some(
        (vertex) =>
          !Number.isInteger(vertex) ||
          vertex < 0 ||
          vertex >= recipe.vertices.length,
      )
    ) {
      throw new Error(`Geometry recipe face ${index} is not a valid triangle`);
    }
    if (!faceNormal(recipe.vertices, face).every(Number.isFinite)) {
      throw new Error(`Geometry recipe face ${index} is degenerate`);
    }
  }
  return new Map([
    ["geometry/tetrahedron.obj", Buffer.from(generateObj(recipe))],
    ["geometry/tetrahedron.stl", Buffer.from(generateStl(recipe))],
    ["geometry/tetrahedron.step", Buffer.from(generateStep(recipe))],
  ]);
}

export function buildFixtureArtifacts() {
  const mutations = JSON.parse(readFileSync(MUTATIONS_PATH, "utf8"));
  const sourceEntries = recipeEntries(PROJECT_RECIPE);
  const artifacts = generatedGeometry();
  artifacts.set("fixtures/reference.3mf", createZip(sourceEntries));
  for (const mutation of mutations.threeMf) {
    const entries = new Map(sourceEntries);
    const original = entries.get(mutation.member);
    if (!original)
      throw new Error(
        `${mutation.id}: archive recipe member ${mutation.member} is missing`,
      );
    const changed = replaceExactlyOnce(
      original.toString("utf8"),
      mutation.find,
      mutation.replace,
      mutation.id,
    );
    entries.set(mutation.member, Buffer.from(changed));
    artifacts.set(`fixtures/mutations/${mutation.id}.3mf`, createZip(entries));
  }
  const referenceGcode = readFileSync(GCODE_RECIPE, "utf8");
  artifacts.set("fixtures/reference.gcode", Buffer.from(referenceGcode));
  for (const mutation of mutations.gcode) {
    artifacts.set(
      `fixtures/mutations/${mutation.id}.gcode`,
      Buffer.from(
        replaceExactlyOnce(
          referenceGcode,
          mutation.find,
          mutation.replace,
          mutation.id,
        ),
      ),
    );
  }
  const expected = buildExpectedSummary(
    artifacts.get("fixtures/reference.3mf"),
    referenceGcode,
  );
  artifacts.set(
    "expected/reference.semantic.json",
    Buffer.from(`${JSON.stringify(expected, null, 2)}\n`),
  );
  return artifacts;
}

export function generateFixtures({ check = false } = {}) {
  const artifacts = buildFixtureArtifacts();
  const manifest = {
    schemaVersion: 1,
    generator: "tools/parity-oracles/generate-fixtures.mjs",
    deterministicZip: {
      compression: "STORE",
      memberOrder: "UTF-8 path ascending",
      timestamp: "1980-01-01T00:00:00Z",
    },
    artifacts: [...artifacts.entries()]
      .map(([path, bytes]) => ({
        bytes: bytes.length,
        path,
        sha256: sha256(bytes),
      }))
      .sort((left, right) => left.path.localeCompare(right.path, "en")),
    recipes: {
      geometry: `sha256:${sha256(readFileSync(GEOMETRY_RECIPE))}`,
      mutations: `sha256:${sha256(readFileSync(MUTATIONS_PATH))}`,
      projectTree: `sha256:${treeHash(recipeEntries(PROJECT_RECIPE))}`,
      representativeGcode: `sha256:${sha256(readFileSync(GCODE_RECIPE))}`,
    },
  };
  const changed = [];
  for (const [relativePath, bytes] of artifacts)
    writeOrCheck(join(DATA, relativePath), bytes, check, changed);
  writeOrCheck(
    join(DATA, "generated-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    check,
    changed,
  );
  if (check && changed.length > 0) {
    throw new Error(
      `Generated parity fixtures are stale or missing:\n${changed.map((path) => `  ${path}`).join("\n")}`,
    );
  }
  return { artifacts, changed, manifest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const check = process.argv.includes("--check");
  try {
    const result = generateFixtures({ check });
    const action = check
      ? "verified"
      : result.changed.length
        ? "generated"
        : "already current";
    console.log(
      `Parity fixtures ${action}: ${result.artifacts.size} artifacts`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
