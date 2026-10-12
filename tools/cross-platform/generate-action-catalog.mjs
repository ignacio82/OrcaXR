// Generate the native action catalog from the production registry
// (`web/src/actions/`): every action in catalog order with the capability the
// registry resolved for it, the prerequisite rules, the surface, group and
// state vocabularies (with each group's label and `GROUPS` order), and each
// enablement rule translated into Rust. A rule
// outside the small boolean grammar the registry uses, or one that reads a
// workspace field the native state does not model, fails generation instead
// of being approximated.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "../../web/node_modules/typescript/lib/typescript.js";
import { buildRegistry } from "../../web/src/actions/catalog.ts";
import { GROUPS } from "../../web/src/actions/ActionRegistry.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const parse = (path) =>
  ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
const str = (value) => JSON.stringify(value);
const pascal = (value) =>
  value
    .split(/[-_]/)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");

// String-literal unions, by alias name, across the files that declare them.
const aliases = new Map();
for (const path of [
  "web/src/actions/ActionRegistry.ts",
  "web/src/actions/UiState.ts",
  "web/src/printer/PrintJobStatus.ts",
  "web/src/startup/FeatureInitialization.ts",
]) {
  parse(path).forEachChild((node) => {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node.type);
  });
}
function union(name) {
  const type = aliases.get(name);
  assert.ok(type, `type ${name}`);
  const members = ts.isUnionTypeNode(type) ? type.types : [type];
  return members.flatMap((member) => {
    if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))
      return [member.literal.text];
    if (ts.isTypeReferenceNode(member)) return union(member.typeName.text);
    assert.fail(`${name}: unsupported union member ${member.getText()}`);
  });
}
const vocabularies = {
  Surface: union("ActionSurface"),
  Group: union("GroupId"),
  ContextTarget: union("ContextTarget"),
  Status: union("CapabilityStatus"),
  Mode: union("WorkspaceMode"),
  PrinterJobState: union("PrinterJobUiState"),
  FeaturePhase: union("FeaturePhase"),
  BootPhase: union("BootPhase"),
  Prerequisite: union("PrerequisiteId"),
};
for (const [name, values] of Object.entries(vocabularies))
  assert.equal(new Set(values).size, values.length, `${name} is unique`);
assert.deepEqual(
  GROUPS.map((group) => group.id).sort(),
  [...vocabularies.Group].sort(),
  "GROUPS names every GroupId once",
);

// The workspace fields a rule may read, as the native state models them.
// Optional flags read as false when absent, so only their truthiness (or an
// explicit `=== true`) has the same meaning natively.
const FIELDS = {
  mode: { rust: "mode", kind: "enum", type: "Mode" },
  modelCount: { rust: "model_count", kind: "count" },
  plateCount: { rust: "plate_count", kind: "count" },
  hasSelection: { rust: "has_selection", kind: "flag" },
  simplifyPreviewing: { rust: "simplify_previewing", kind: "optional-flag" },
  calibrationSessionOpen: {
    rust: "calibration_session_open",
    kind: "optional-flag",
  },
  hasInstanceSelection: { rust: "has_instance_selection", kind: "flag" },
  canUndo: { rust: "can_undo", kind: "flag" },
  canRedo: { rust: "can_redo", kind: "flag" },
  dirty: { rust: "dirty", kind: "flag" },
  projectionHealthy: { rust: "projection_healthy", kind: "flag" },
  hasClipboard: { rust: "has_clipboard", kind: "flag" },
  isSlicing: { rust: "is_slicing", kind: "flag" },
  gcodeReady: { rust: "gcode_ready", kind: "flag" },
  preflightBlocked: { rust: "preflight_blocked", kind: "flag" },
  printerJobState: {
    rust: "printer_job_state",
    kind: "enum",
    type: "PrinterJobState",
  },
};

// One rule, `(s) => <expression>`, as a Rust expression over `s: &UiState`.
// Precedence follows both languages: `!` binds tighter than comparisons,
// which bind tighter than `&&`, then `||`.
const PRECEDENCE = { or: 1, and: 2, compare: 3, not: 4, atom: 5 };
function translate(fn, label) {
  const file = ts.createSourceFile(
    "rule.ts",
    `(${fn});`,
    ts.ScriptTarget.Latest,
    true,
  );
  let expression = file.statements[0].expression;
  while (ts.isParenthesizedExpression(expression))
    expression = expression.expression;
  assert.ok(ts.isArrowFunction(expression), `${label}: not an arrow function`);
  assert.equal(expression.parameters.length, 1, `${label}: one parameter`);
  const param = expression.parameters[0].name.getText();
  assert.ok(ts.isExpression(expression.body), `${label}: expression body`);
  const fail = (node) =>
    assert.fail(`${label}: unsupported rule syntax ${node.getText()}`);
  const field = (node) => {
    if (
      !ts.isPropertyAccessExpression(node) ||
      node.expression.getText() !== param
    )
      return undefined;
    const name = node.name.text;
    assert.ok(
      FIELDS[name],
      `${label}: reads ${name}, which the native UiState does not model`,
    );
    return { name, ...FIELDS[name] };
  };
  const wrap = (text, own, parent) => (own < parent ? `(${text})` : text);
  const visit = (node, parent) => {
    if (ts.isParenthesizedExpression(node))
      return visit(node.expression, parent);
    const f = field(node);
    if (f) {
      assert.ok(
        f.kind === "flag" || f.kind === "optional-flag",
        `${label}: ${f.name} is not a flag`,
      );
      return `s.${f.rust}`;
    }
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken
    )
      return `!${visit(node.operand, PRECEDENCE.not)}`;
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken
      ) {
        const own =
          op === ts.SyntaxKind.BarBarToken ? PRECEDENCE.or : PRECEDENCE.and;
        const rust = op === ts.SyntaxKind.BarBarToken ? "||" : "&&";
        // Both operators are left-associative in both languages.
        return wrap(
          `${visit(node.left, own)} ${rust} ${visit(node.right, own + 1)}`,
          own,
          parent,
        );
      }
      const f = field(node.left);
      if (!f) fail(node);
      const right = node.right;
      const compare = (text) => wrap(text, PRECEDENCE.compare, parent);
      const equality = {
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: "==",
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: "!=",
      }[op];
      const ordering = {
        [ts.SyntaxKind.GreaterThanToken]: ">",
        [ts.SyntaxKind.GreaterThanEqualsToken]: ">=",
        [ts.SyntaxKind.LessThanToken]: "<",
        [ts.SyntaxKind.LessThanEqualsToken]: "<=",
      }[op];
      if (f.kind === "count" && ordering && ts.isNumericLiteral(right)) {
        const value = Number(right.text);
        assert.ok(Number.isSafeInteger(value) && value >= 0, `${label}: count`);
        return compare(`s.${f.rust} ${ordering} ${value}`);
      }
      if (f.kind === "count" && equality && ts.isNumericLiteral(right)) {
        const value = Number(right.text);
        assert.ok(Number.isSafeInteger(value) && value >= 0, `${label}: count`);
        return compare(`s.${f.rust} ${equality} ${value}`);
      }
      if (f.kind === "enum" && equality && ts.isStringLiteral(right)) {
        assert.ok(
          vocabularies[f.type].includes(right.text),
          `${label}: ${right.text} is not a ${f.type}`,
        );
        return compare(
          `s.${f.rust} ${equality} ${f.type}::${pascal(right.text)}`,
        );
      }
      if (
        (f.kind === "flag" || f.kind === "optional-flag") &&
        equality &&
        (right.kind === ts.SyntaxKind.TrueKeyword ||
          right.kind === ts.SyntaxKind.FalseKeyword)
      ) {
        const wanted =
          (right.kind === ts.SyntaxKind.TrueKeyword) === (equality === "==");
        // An absent optional flag is neither `=== false` nor `!== true`'s
        // complement; only the positive test reads the same natively.
        if (f.kind === "optional-flag")
          assert.ok(wanted, `${label}: ${f.name} must be tested with === true`);
        return wanted
          ? wrap(`s.${f.rust}`, PRECEDENCE.atom, parent)
          : wrap(`!s.${f.rust}`, PRECEDENCE.not, parent);
      }
      fail(node);
    }
    fail(node);
  };
  return visit(expression.body, PRECEDENCE.or);
}

// The grammar refuses rather than approximates.
for (const [rule, why] of [
  ["(s) => s.extruderCount > 1", /does not model/],
  ["(s) => s.simplifyPreviewing === false", /=== true/],
  ["(s) => s.modelCount > 0.5", /count/],
  ["(s) => s.mode === 'edit'", /not a Mode/],
  ["(s) => s.modelCount", /not a flag/],
  ["(s) => Boolean(s.dirty)", /unsupported rule syntax/],
  ["(s) => s.dirty ? true : false", /unsupported rule syntax/],
  ["(s, t) => s.dirty", /one parameter/],
  ["(s) => { return s.dirty; }", /expression body/],
])
  assert.throws(() => translate(rule, "probe"), why, rule);
assert.equal(
  translate(
    "(s) => !(s.dirty || s.canUndo) && (s.modelCount > 1 || s.isSlicing)",
    "probe",
  ),
  "!(s.dirty || s.can_undo) && (s.model_count > 1 || s.is_slicing)",
);
assert.equal(
  translate(
    "(s) => s.dirty === false || s.printerJobState !== 'paused'",
    "probe",
  ),
  "!s.dirty || s.printer_job_state != PrinterJobState::Paused",
);

// Prerequisite rules are private to the registry, so read them from source.
const registrySource = parse("web/src/actions/ActionRegistry.ts");
let prerequisites;
registrySource.forEachChild((node) => {
  if (!ts.isVariableStatement(node)) return;
  for (const d of node.declarationList.declarations)
    if (d.name.getText() === "PREREQUISITES") prerequisites = d.initializer;
});
assert.ok(
  prerequisites && ts.isObjectLiteralExpression(prerequisites),
  "PREREQUISITES",
);
const rules = new Map();
for (const property of prerequisites.properties) {
  assert.ok(ts.isPropertyAssignment(property));
  const id = property.name.text;
  const value = property.initializer;
  assert.ok(ts.isObjectLiteralExpression(value), id);
  const member = (name) =>
    value.properties.find((p) => p.name.getText() === name)?.initializer;
  const reason = member("reason");
  assert.ok(reason && ts.isStringLiteral(reason), `${id} reason`);
  rules.set(id, {
    met: translate(member("met").getText(), `prerequisite ${id}`),
    reason: reason.text,
  });
}
assert.deepEqual(
  [...rules.keys()].sort(),
  [...vocabularies.Prerequisite].sort(),
  "every prerequisite has a rule",
);

// The catalog, in the registry's own order and resolved capability.
const actions = buildRegistry().allSource();
assert.equal(new Set(actions.map((a) => a.id)).size, actions.length);
const predicates = new Map();
const predicate = (fn, label) => {
  if (!fn) return "None";
  const body = translate(fn.toString(), label);
  if (!predicates.has(body)) predicates.set(body, `rule_${predicates.size}`);
  return `Some(${predicates.get(body)})`;
};
const variant = (type, value) => {
  assert.ok(vocabularies[type].includes(value), `${value} is not a ${type}`);
  return `${type}::${pascal(value)}`;
};
const optional = (value) =>
  value === undefined ? "None" : `Some(${str(value)})`;
let entries = "";
for (const a of actions) {
  const c = a.capability;
  entries +=
    `Action { id: ${str(a.id)}, label: ${str(a.label)}, group: ${variant("Group", a.group)}, ` +
    `surfaces: &[${c.surfaces.map((s) => variant("Surface", s)).join(", ")}], ` +
    `context: &[${(a.context ?? []).map((t) => variant("ContextTarget", t)).join(", ")}], ` +
    `status: ${variant("Status", c.status)}, reason: ${optional(c.reason)}, ` +
    `prerequisites: &[${c.prerequisites.map((p) => variant("Prerequisite", p)).join(", ")}], ` +
    `xr_unsupported_reason: ${optional(a.xrUnsupportedReason)}, ` +
    `enabled: ${predicate(a.isEnabled, `${a.id} isEnabled`)}, ` +
    `visible: ${predicate(a.isVisible, `${a.id} isVisible`)} },\n`;
}

const enumeration = (name, values, doc) =>
  `/// ${doc}\n#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\npub enum ${name} {\n` +
  values.map((v) => `    ${pascal(v)},\n`).join("") +
  `}\nimpl ${name} {\n` +
  `    pub const ALL: [Self; ${values.length}] = [${values.map((v) => `Self::${pascal(v)}`).join(", ")}];\n` +
  `    /// The browser's identifier.\n    pub fn id(self) -> &'static str {\n        match self {\n` +
  values.map((v) => `            Self::${pascal(v)} => ${str(v)},\n`).join("") +
  `        }\n    }\n` +
  `    pub fn from_id(id: &str) -> Option<Self> {\n        Self::ALL.into_iter().find(|v| v.id() == id)\n    }\n}\n`;

let rust =
  "// Generated by tools/cross-platform/generate-action-catalog.mjs. Do not edit.\n" +
  "use super::{Action, UiState};\n\n" +
  enumeration(
    "Surface",
    vocabularies.Surface,
    "Where an action surfaces (`ActionSurface`).",
  ) +
  enumeration(
    "Group",
    vocabularies.Group,
    "An action's catalog group (`GroupId`).",
  ) +
  // `GROUPS`: each group's label and the declared order menus section by.
  "impl Group {\n" +
  `    /// The browser's groups in \`GROUPS\`' declared order, which grouped menus follow.\n` +
  `    pub const ORDER: [Self; ${GROUPS.length}] = [${GROUPS.map((g) => `Self::${pascal(g.id)}`).join(", ")}];\n` +
  "    /// The browser's label for the group (`GROUPS`).\n    pub fn label(self) -> &'static str {\n        match self {\n" +
  GROUPS.map((g) => `            Self::${pascal(g.id)} => ${str(g.label)},\n`).join("") +
  "        }\n    }\n}\n" +
  enumeration(
    "ContextTarget",
    vocabularies.ContextTarget,
    "What a context menu was opened on.",
  ) +
  enumeration("Status", vocabularies.Status, "A declared capability status.") +
  enumeration(
    "Mode",
    vocabularies.Mode,
    "The workspace's modal surface (`WorkspaceMode`).",
  ) +
  enumeration(
    "PrinterJobState",
    vocabularies.PrinterJobState,
    "What the connected printer reports (`PrinterJobUiState`).",
  ) +
  enumeration(
    "FeaturePhase",
    vocabularies.FeaturePhase,
    "A startup feature's phase.",
  ) +
  enumeration(
    "BootPhase",
    vocabularies.BootPhase,
    "The application's startup phase.",
  ) +
  enumeration(
    "Prerequisite",
    vocabularies.Prerequisite,
    "A registry prerequisite (`PrerequisiteId`).",
  ) +
  "impl Prerequisite {\n" +
  "    /// Whether the workspace meets it.\n    pub fn met(self, s: &UiState) -> bool {\n        match self {\n" +
  vocabularies.Prerequisite.map(
    (p) => `            Self::${pascal(p)} => ${rules.get(p).met},\n`,
  ).join("") +
  "        }\n    }\n" +
  "    /// The browser's reason when it is not met.\n    pub fn reason(self) -> &'static str {\n        match self {\n" +
  vocabularies.Prerequisite.map(
    (p) => `            Self::${pascal(p)} => ${str(rules.get(p).reason)},\n`,
  ).join("") +
  "        }\n    }\n}\n\n" +
  [...predicates]
    .map(
      ([body, name]) => `fn ${name}(s: &UiState) -> bool {\n    ${body}\n}\n`,
    )
    .join("") +
  `\n/// The registry's catalog, in its order.\npub static ACTIONS: &[Action] = &[\n${entries}];\n`;

function rustfmt(source) {
  const directory = mkdtempSync(join(tmpdir(), "orcaxr-action-catalog-"));
  try {
    const path = join(directory, "generated.rs");
    writeFileSync(path, source);
    const result = spawnSync(
      "rustfmt",
      ["+1.94.1", "--edition", "2024", path],
      {
        stdio: "inherit",
        timeout: 60000,
      },
    );
    assert.equal(result.status, 0, result.error?.message);
    return readFileSync(path, "utf8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const file = "core/crates/orcaxr-contracts/src/capabilities/generated.rs";
const formatted = rustfmt(rust);
const target = new URL(file, root);
if (process.argv.includes("--write")) writeFileSync(target, formatted);
else
  assert.equal(
    readFileSync(target, "utf8"),
    formatted,
    `${file} needs regeneration`,
  );
console.log(
  `action catalog: ${actions.length} actions, ${predicates.size} rules, ${rules.size} prerequisites`,
);
