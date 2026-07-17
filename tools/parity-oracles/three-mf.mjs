import { createHash } from "node:crypto";
import { posix } from "node:path";
import { readZip } from "./zip.mjs";
import {
  attribute,
  canonicalXml,
  childElements,
  descendants,
  localName,
  namespaceUri,
  parseXml,
  textContent,
} from "./xml.mjs";

const CORE_3MF_NAMESPACE =
  "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const KNOWN_NAMESPACES = new Set([
  "",
  CORE_3MF_NAMESPACE,
  RELATIONSHIP_NAMESPACE,
  CONTENT_TYPES_NAMESPACE,
  XML_NAMESPACE,
]);
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".gcode",
  ".ini",
  ".cfg",
  ".config",
  ".json",
  ".xml",
  ".rels",
  ".model",
]);
const STANDARD_MEMBER =
  /^(?:\[Content_Types\]\.xml|_rels\/\.rels|3D\/|Metadata\/|Auxiliaries\/|Thumbnails\/)/i;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedText(bytes) {
  return bytes
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

function looksLikeXml(text) {
  return /^\s*(?:<\?xml[^>]*>\s*)?</.test(text);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function parseLineConfig(text) {
  let section = "";
  const values = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) {
      values.push({ key: "<line>", section, value: line });
    } else {
      values.push({
        key: line.slice(0, equals).trim(),
        section,
        value: line.slice(equals + 1).trim(),
      });
    }
  }
  return values.sort((left, right) =>
    `${left.section}\0${left.key}\0${left.value}`.localeCompare(
      `${right.section}\0${right.key}\0${right.value}`,
      "en",
    ),
  );
}

function classifyMember(name, bytes) {
  const extension = posix.extname(name).toLowerCase();
  const textLike =
    TEXT_EXTENSIONS.has(extension) || name.toLowerCase().endsWith(".rels");
  const raw = { bytes: bytes.length, sha256: sha256(bytes) };
  if (textLike) {
    const text = normalizedText(bytes);
    if (looksLikeXml(text)) {
      const tree = parseXml(text, name);
      return { kind: "xml", raw, tree, value: canonicalXml(tree) };
    }
    if (extension === ".json" || /^\s*[\[{]/.test(text)) {
      try {
        return { kind: "json", raw, value: canonicalJson(JSON.parse(text)) };
      } catch {
        // Preserve malformed JSON as text so comparisons remain safe and lossless.
      }
    }
    if (
      extension === ".config" ||
      extension === ".ini" ||
      extension === ".cfg"
    ) {
      return { kind: "config", raw, value: parseLineConfig(text) };
    }
    return { kind: "text", raw, value: text };
  }
  return { kind: "binary", raw, value: raw };
}

function relationshipSource(name) {
  if (name === "_rels/.rels") return "/";
  const match = name.match(/^(.*\/)?_rels\/([^/]+)\.rels$/);
  if (!match) return name;
  return `${match[1] ?? ""}${match[2]}`;
}

function resolveRelationshipTarget(source, target) {
  if (target.startsWith("/"))
    return posix.normalize(target).replace(/^\/+/, "");
  const base = source === "/" ? "" : posix.dirname(source);
  return posix.normalize(posix.join(base, target)).replace(/^\/+/, "");
}

function relationshipSummary(documents, memberNames) {
  const relationships = [];
  for (const [name, document] of documents) {
    if (!name.toLowerCase().endsWith(".rels")) continue;
    const source = relationshipSource(name);
    for (const { node } of descendants(
      document.tree,
      (candidate) => localName(candidate.name) === "Relationship",
    )) {
      const target = attribute(node, "Target") ?? "";
      const targetMode = attribute(node, "TargetMode") ?? "Internal";
      const resolvedTarget =
        targetMode.toLowerCase() === "external"
          ? target
          : resolveRelationshipTarget(source, target);
      relationships.push({
        id: attribute(node, "Id") ?? "",
        missing:
          targetMode.toLowerCase() === "external"
            ? false
            : !memberNames.has(resolvedTarget),
        source,
        target,
        targetMode,
        type: attribute(node, "Type") ?? "",
        resolvedTarget,
      });
    }
  }
  return relationships.sort((left, right) =>
    `${left.source}\0${left.id}\0${left.type}\0${left.target}`.localeCompare(
      `${right.source}\0${right.id}\0${right.type}\0${right.target}`,
      "en",
    ),
  );
}

function attributesByLocalName(node) {
  return Object.fromEntries(
    Object.entries(node.attributes)
      .map(([name, value]) => [localName(name), value])
      .sort(([left], [right]) => left.localeCompare(right, "en")),
  );
}

function modelSummary(documents) {
  const models = [];
  for (const [name, document] of documents) {
    if (!name.toLowerCase().endsWith(".model")) continue;
    const tree = document.tree;
    const resources = childElements(tree, "resources")[0];
    const build = childElements(tree, "build")[0];
    const metadata = childElements(tree, "metadata")
      .map((node) => ({
        name: attribute(node, "name") ?? "",
        value: textContent(node).trim(),
      }))
      .sort((left, right) =>
        `${left.name}\0${left.value}`.localeCompare(
          `${right.name}\0${right.value}`,
          "en",
        ),
      );
    const objects = (resources ? childElements(resources, "object") : [])
      .map((object) => {
        const componentsNode = childElements(object, "components")[0];
        const mesh = childElements(object, "mesh")[0];
        const vertices = mesh
          ? descendants(mesh, (node) => localName(node.name) === "vertex")
              .length
          : 0;
        const triangles = mesh
          ? descendants(mesh, (node) => localName(node.name) === "triangle")
              .length
          : 0;
        return {
          attributes: attributesByLocalName(object),
          components: componentsNode
            ? childElements(componentsNode, "component").map(
                attributesByLocalName,
              )
            : [],
          mesh: mesh
            ? { canonical: canonicalXml(mesh), triangles, vertices }
            : null,
        };
      })
      .sort((left, right) =>
        (left.attributes.id ?? "").localeCompare(
          right.attributes.id ?? "",
          "en",
        ),
      );
    const buildItems = build
      ? childElements(build, "item").map(attributesByLocalName)
      : [];
    models.push({
      attributes: attributesByLocalName(tree),
      build: buildItems,
      metadata,
      objects,
      path: name,
    });
  }
  return models.sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
}

function settingSummary(documents, classified) {
  const settings = [];
  for (const [name, document] of documents) {
    if (!/\.(?:config|xml|model)$/i.test(name)) continue;
    for (const { node, path } of descendants(document.tree, (candidate) =>
      ["metadata", "setting", "option"].includes(localName(candidate.name)),
    )) {
      const key =
        attribute(node, "key") ??
        attribute(node, "name") ??
        attribute(node, "type");
      if (key === null) continue;
      settings.push({
        key,
        path: `${name}${path}`,
        value: attribute(node, "value") ?? textContent(node).trim(),
      });
    }
  }
  for (const [name, member] of classified) {
    if (
      member.kind === "json" &&
      /(?:settings|config)/i.test(name) &&
      member.value &&
      typeof member.value === "object"
    ) {
      for (const [key, value] of Object.entries(member.value)) {
        settings.push({
          key,
          path: `${name}#/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          value,
        });
      }
    } else if (member.kind === "config") {
      for (let index = 0; index < member.value.length; index += 1) {
        const setting = member.value[index];
        settings.push({
          key: setting.key,
          path: `${name}#/${setting.section || "<root>"}/${index}`,
          value: setting.value,
        });
      }
    }
  }
  return settings.sort((left, right) =>
    `${left.path}\0${left.key}`.localeCompare(
      `${right.path}\0${right.key}`,
      "en",
    ),
  );
}

function scopeIdentity(node) {
  const identity = {};
  for (const key of [
    "id",
    "object_id",
    "instance_id",
    "subtype",
    "min_z",
    "max_z",
  ]) {
    const value = attribute(node, key);
    if (value !== null) identity[key] = value;
  }
  return identity;
}

function partAssignmentSummary(documents) {
  const assignments = [];
  const scopeNames = new Set(["object", "part", "volume", "layer_range"]);
  for (const [name, document] of documents) {
    for (const { node, path } of descendants(document.tree, (candidate) =>
      scopeNames.has(localName(candidate.name)),
    )) {
      for (const setting of childElements(node).filter((child) =>
        ["metadata", "setting", "option"].includes(localName(child.name)),
      )) {
        const key =
          attribute(setting, "key") ?? attribute(setting, "name") ?? "";
        if (!/(?:^|_)(?:extruder|filament)(?:$|_)/i.test(key)) continue;
        assignments.push({
          identity: scopeIdentity(node),
          key,
          path: `${name}${path}`,
          scope: localName(node.name),
          value: attribute(setting, "value") ?? textContent(setting).trim(),
        });
      }
    }
  }
  return assignments.sort((left, right) =>
    `${left.path}\0${left.key}`.localeCompare(
      `${right.path}\0${right.key}`,
      "en",
    ),
  );
}

function facetAnnotationSummary(documents) {
  const annotations = [];
  const annotationName = /(?:paint|support|seam|fuzzy|facet|brim)/i;
  for (const [name, document] of documents) {
    for (const { node, path } of descendants(document.tree)) {
      const payload = Object.fromEntries(
        Object.entries(node.attributes)
          .filter(([attrName]) => annotationName.test(localName(attrName)))
          .map(([attrName, value]) => [localName(attrName), value])
          .sort(([left], [right]) => left.localeCompare(right, "en")),
      );
      if (
        Object.keys(payload).length === 0 &&
        !annotationName.test(localName(node.name))
      )
        continue;
      annotations.push({
        element: localName(node.name),
        path: `${name}${path}`,
        payload,
        text: textContent(node).trim(),
      });
    }
  }
  return annotations.sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
}

function plateSummary(documents, classified) {
  const plates = [];
  for (const [name, document] of documents) {
    for (const { node, path } of descendants(
      document.tree,
      (candidate) => localName(candidate.name) === "plate",
    )) {
      plates.push({
        attributes: attributesByLocalName(node),
        canonical: canonicalXml(node),
        path: `${name}${path}`,
      });
    }
  }
  for (const [name, member] of classified) {
    if (!/(?:^|[/_.-])plate(?:[/_.-]|\d|$)/i.test(name)) continue;
    plates.push({ member: name, payload: member.value });
  }
  return plates.sort((left, right) =>
    (left.path ?? left.member).localeCompare(right.path ?? right.member, "en"),
  );
}

function unknownExtensionSummary(documents, classified) {
  const extensions = [];
  for (const [name, document] of documents) {
    for (const { node, path } of descendants(document.tree)) {
      const elementUri = namespaceUri(node.name);
      if (elementUri && !KNOWN_NAMESPACES.has(elementUri)) {
        extensions.push({
          kind: "element",
          namespace: elementUri,
          path: `${name}${path}`,
          value: canonicalXml(node),
        });
      }
      for (const [attrName, value] of Object.entries(node.attributes)) {
        const uri = namespaceUri(attrName);
        if (uri && !KNOWN_NAMESPACES.has(uri)) {
          extensions.push({
            attribute: localName(attrName),
            kind: "attribute",
            namespace: uri,
            path: `${name}${path}`,
            value,
          });
        }
      }
    }
  }
  for (const [name, member] of classified) {
    if (!STANDARD_MEMBER.test(name)) {
      extensions.push({
        kind: "member",
        path: name,
        raw: member.raw,
        value: member.value,
      });
    }
  }
  return extensions.sort((left, right) =>
    `${left.path}\0${left.kind}\0${left.attribute ?? ""}`.localeCompare(
      `${right.path}\0${right.kind}\0${right.attribute ?? ""}`,
      "en",
    ),
  );
}

function archiveSummary(classified, ignoredMembers) {
  return Object.fromEntries(
    [...classified.entries()]
      .filter(([name]) => !ignoredMembers.some((pattern) => pattern.test(name)))
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([name, member]) => [
        name,
        { kind: member.kind, value: member.value },
      ]),
  );
}

/**
 * Normalize a 3MF package without retaining ZIP order, compression, or timestamps. Every
 * member is still represented, and key BBS/Orca semantics are indexed separately for useful
 * diffs and regression assertions.
 */
export function normalizeThreeMf(input, options = {}) {
  const entries = readZip(input, options.zipLimits);
  const classified = new Map();
  const documents = new Map();
  for (const [name, bytes] of entries) {
    const member = classifyMember(name, bytes);
    classified.set(name, member);
    if (member.tree) documents.set(name, member);
  }
  const settings = settingSummary(documents, classified);
  const memberNames = new Set(entries.keys());
  const customGcode = [
    ...settings.filter((setting) => /gcode/i.test(setting.key)),
    ...[...classified.entries()]
      .filter(([name]) => /gcode/i.test(name))
      .map(([name, member]) => ({ member: name, payload: member.value })),
  ];
  return {
    format: "orcaxr-structural-3mf-v1",
    relationships: relationshipSummary(documents, memberNames),
    models: modelSummary(documents),
    settings,
    partAssignments: partAssignmentSummary(documents),
    facetAnnotations: facetAnnotationSummary(documents),
    mixedFilamentDefinitions: settings.filter((setting) =>
      /mixed_filament/i.test(setting.key),
    ),
    plates: plateSummary(documents, classified),
    customGcode,
    unknownExtensions: unknownExtensionSummary(documents, classified),
    archive: archiveSummary(
      classified,
      (options.ignoreMembers ?? []).map((pattern) =>
        pattern instanceof RegExp ? pattern : new RegExp(pattern),
      ),
    ),
  };
}

function preview(value) {
  const json = JSON.stringify(value);
  return json.length <= 300 ? value : `${json.slice(0, 297)}...`;
}

function deepDifferences(left, right, path, output, maxDifferences) {
  if (output.length >= maxDifferences) return;
  if (Object.is(left, right)) return;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      output.push({
        actual: preview(right),
        expected: preview(left),
        kind: "type",
        path,
      });
      return;
    }
    if (left.length !== right.length) {
      output.push({
        actual: right.length,
        expected: left.length,
        kind: "array-length",
        path,
      });
    }
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      deepDifferences(
        left[index],
        right[index],
        `${path}/${index}`,
        output,
        maxDifferences,
      );
    }
    return;
  }
  const leftObject = left !== null && typeof left === "object";
  const rightObject = right !== null && typeof right === "object";
  if (leftObject || rightObject) {
    if (!leftObject || !rightObject) {
      output.push({
        actual: preview(right),
        expected: preview(left),
        kind: "type",
        path,
      });
      return;
    }
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    for (const key of keys) {
      const childPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (!Object.hasOwn(left, key)) {
        output.push({
          actual: preview(right[key]),
          expected: undefined,
          kind: "unexpected",
          path: childPath,
        });
      } else if (!Object.hasOwn(right, key)) {
        output.push({
          actual: undefined,
          expected: preview(left[key]),
          kind: "missing",
          path: childPath,
        });
      } else {
        deepDifferences(
          left[key],
          right[key],
          childPath,
          output,
          maxDifferences,
        );
      }
      if (output.length >= maxDifferences) return;
    }
    return;
  }
  output.push({
    actual: preview(right),
    expected: preview(left),
    kind: "changed",
    path,
  });
}

export function compareThreeMf(expected, actual, options = {}) {
  const left = normalizeThreeMf(expected, options);
  const right = normalizeThreeMf(actual, options);
  const differences = [];
  deepDifferences(left, right, "", differences, options.maxDifferences ?? 200);
  return {
    actual: right,
    differences,
    equal: differences.length === 0,
    expected: left,
  };
}
