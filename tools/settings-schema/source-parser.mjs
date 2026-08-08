import {
  findCalls,
  findMatching,
  lineNumberAt,
  splitTopLevel,
  stripCppComments,
  symbolAt,
} from "../parity/cpp-scan.mjs";
import { extractGuiLayout, TAB_SOURCE_PATH } from "./gui-source-parser.mjs";

export const SETTINGS_SCHEMA_VERSION = 2;
export const SETTINGS_PARSER_VERSION = "0.2.0";
export const PRINT_CONFIG_PATH = "src/libslic3r/PrintConfig.cpp";
export const CONFIG_HEADER_PATH = "src/libslic3r/Config.hpp";

const OPTION_TYPES = Object.freeze({
  coNone: {
    shape: "scalar",
    valueType: "none",
    percent: "none",
    collectionDelimiter: null,
    componentDelimiter: null,
  },
  coFloat: {
    shape: "scalar",
    valueType: "float",
    percent: "none",
    collectionDelimiter: null,
    componentDelimiter: null,
  },
  coFloats: {
    shape: "vector",
    valueType: "float",
    percent: "none",
    collectionDelimiter: ",",
    componentDelimiter: null,
  },
  coInt: {
    shape: "scalar",
    valueType: "int",
    percent: "none",
    collectionDelimiter: null,
    componentDelimiter: null,
  },
  coInts: {
    shape: "vector",
    valueType: "int",
    percent: "none",
    collectionDelimiter: ",",
    componentDelimiter: null,
  },
  coString: {
    shape: "scalar",
    valueType: "string",
    percent: "none",
    collectionDelimiter: null,
    componentDelimiter: null,
  },
  coStrings: {
    shape: "vector",
    valueType: "string",
    percent: "none",
    collectionDelimiter: ";",
    componentDelimiter: null,
  },
  coPercent: {
    shape: "scalar",
    valueType: "float",
    percent: "percent",
    collectionDelimiter: null,
    componentDelimiter: null,
  },
  coPercents: {
    shape: "vector",
    valueType: "float",
    percent: "percent",
    collectionDelimiter: ",",
    componentDelimiter: null,
  },
  coFloatOrPercent: {
    shape: "scalar",
    valueType: "float-or-percent",
    percent: "float-or-percent",
    collectionDelimiter: null,
    componentDelimiter: null,
  },
  coFloatsOrPercents: {
    shape: "vector",
    valueType: "float-or-percent",
    percent: "float-or-percent",
    collectionDelimiter: ",",
    componentDelimiter: null,
  },
  coPoint: {
    shape: "scalar",
    valueType: "point2",
    percent: "none",
    collectionDelimiter: null,
    componentDelimiter: ",",
  },
  coPoints: {
    shape: "vector",
    valueType: "point2",
    percent: "none",
    collectionDelimiter: ",",
    componentDelimiter: "x",
  },
  coPoint3: {
    shape: "scalar",
    valueType: "point3",
    percent: "none",
    collectionDelimiter: null,
    componentDelimiter: ",",
  },
  coBool: {
    shape: "scalar",
    valueType: "bool",
    percent: "none",
    collectionDelimiter: null,
    componentDelimiter: null,
  },
  coBools: {
    shape: "vector",
    valueType: "bool",
    percent: "none",
    collectionDelimiter: ",",
    componentDelimiter: null,
  },
  coEnum: {
    shape: "scalar",
    valueType: "enum",
    percent: "none",
    collectionDelimiter: null,
    componentDelimiter: null,
  },
  coEnums: {
    shape: "vector",
    valueType: "enum",
    percent: "none",
    collectionDelimiter: ",",
    componentDelimiter: null,
  },
});

const FIELD_KINDS = Object.freeze({
  aliases: "string-array",
  category: "string",
  cli: "string",
  cli_params: "string",
  enum_keys_map: "expression",
  enum_labels: "string-array",
  enum_labels_ex: "string-array",
  enum_labels_u1: "string-array",
  enum_values: "string-array",
  enum_values_ex: "string-array",
  enum_values_u1: "string-array",
  full_label: "string",
  full_width: "boolean",
  gui_flags: "string",
  gui_type: "gui-type",
  height: "number",
  label: "string",
  max: "number",
  max_literal: "number",
  min: "number",
  mode: "mode",
  multiline: "boolean",
  printer_technology: "technology",
  ratio_over: "string",
  readonly: "boolean",
  sidetext: "string",
  tooltip: "string",
  width: "number",
});

const ENUM_ARRAY_FIELDS = new Set([
  "enum_values",
  "enum_labels",
  "enum_values_u1",
  "enum_labels_u1",
  "enum_values_ex",
  "enum_labels_ex",
]);

const MODE_VALUES = Object.freeze({
  comSimple: "simple",
  comAdvanced: "advanced",
  comDevelop: "develop",
});
const TECHNOLOGY_VALUES = Object.freeze({
  ptUnknown: "unknown",
  ptAny: "any",
  ptFFF: "fff",
  ptSLA: "sla",
});

function normalizeExpression(expression) {
  return expression.replace(/\s+/g, " ").trim();
}

function cppStringLiteral(raw) {
  const quote = raw.indexOf('"');
  if (quote < 0 || !raw.endsWith('"'))
    throw new Error(`Malformed C++ string literal ${raw}`);
  const body = raw.slice(quote + 1, -1);
  let output = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "\\") {
      output += character;
      continue;
    }
    index += 1;
    const escaped = body[index];
    if (escaped === undefined) throw new Error(`Trailing escape in ${raw}`);
    if (escaped === "n") output += "\n";
    else if (escaped === "r") output += "\r";
    else if (escaped === "t") output += "\t";
    else if (escaped === "b") output += "\b";
    else if (escaped === "f") output += "\f";
    else if (escaped === "v") output += "\v";
    else if (escaped === "a") output += "\x07";
    else if (escaped === "\\" || escaped === '"' || escaped === "'")
      output += escaped;
    else if (escaped === "x") {
      const match = body.slice(index + 1).match(/^[0-9A-Fa-f]+/);
      if (!match) throw new Error(`Invalid hexadecimal escape in ${raw}`);
      output += String.fromCodePoint(Number.parseInt(match[0], 16));
      index += match[0].length;
    } else if (escaped === "u" || escaped === "U") {
      const length = escaped === "u" ? 4 : 8;
      const digits = body.slice(index + 1, index + 1 + length);
      if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(digits))
        throw new Error(`Invalid Unicode escape in ${raw}`);
      output += String.fromCodePoint(Number.parseInt(digits, 16));
      index += length;
    } else if (/[0-7]/.test(escaped)) {
      const match = body.slice(index).match(/^[0-7]{1,3}/);
      output += String.fromCodePoint(Number.parseInt(match[0], 8));
      index += match[0].length - 1;
    } else {
      throw new Error(`Unsupported C++ escape \\${escaped} in ${raw}`);
    }
  }
  return output;
}

function scanCppStringLiterals(expression) {
  const values = [];
  const spans = [];
  const pattern = /(?:u8|u|U|L)?"(?:\\.|[^"\\])*"/g;
  for (const match of expression.matchAll(pattern)) {
    values.push(cppStringLiteral(match[0]));
    spans.push([match.index, match.index + match[0].length]);
  }
  return { spans, values };
}

function resolvedValue(expression, value) {
  return { expression: normalizeExpression(expression), resolved: true, value };
}

function unresolvedValue(expression) {
  return { expression: normalizeExpression(expression), resolved: false };
}

export function parseStringExpression(expression) {
  const normalized = normalizeExpression(expression);
  if (normalized === "ConfigOptionDef::nocli")
    return resolvedValue(normalized, "~~~noCLI");
  const { spans, values } = scanCppStringLiterals(expression);
  if (spans.length === 0) return unresolvedValue(normalized);
  let residual = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    residual += expression.slice(cursor, start);
    cursor = end;
  }
  residual += expression.slice(cursor);
  residual = residual
    .replace(/\b(?:L|_u8L|std::string)\b/g, "")
    .replace(/[+(),\s]/g, "");
  return residual === ""
    ? resolvedValue(normalized, values.join(""))
    : unresolvedValue(normalized);
}

class NumericParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }
  whitespace() {
    while (/\s/.test(this.source[this.index] ?? "")) this.index += 1;
  }
  parse() {
    const value = this.expression();
    this.whitespace();
    if (this.index !== this.source.length || !Number.isFinite(value))
      throw new Error("not a numeric literal expression");
    return value;
  }
  expression() {
    let value = this.term();
    while (true) {
      this.whitespace();
      const op = this.source[this.index];
      if (op !== "+" && op !== "-") return value;
      this.index += 1;
      const rhs = this.term();
      value = op === "+" ? value + rhs : value - rhs;
    }
  }
  term() {
    let value = this.factor();
    while (true) {
      this.whitespace();
      const op = this.source[this.index];
      if (op !== "*" && op !== "/") return value;
      this.index += 1;
      const rhs = this.factor();
      value = op === "*" ? value * rhs : value / rhs;
    }
  }
  factor() {
    this.whitespace();
    const sign =
      this.source[this.index] === "+" || this.source[this.index] === "-"
        ? this.source[this.index++]
        : "+";
    this.whitespace();
    let value;
    if (this.source[this.index] === "(") {
      this.index += 1;
      value = this.expression();
      this.whitespace();
      if (this.source[this.index++] !== ")")
        throw new Error("unbalanced numeric expression");
    } else {
      const match = this.source
        .slice(this.index)
        .match(/^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)/);
      if (!match) throw new Error("not a numeric token");
      value = Number(match[0]);
      this.index += match[0].length;
      if (/[fFlL]/.test(this.source[this.index] ?? "")) this.index += 1;
    }
    return sign === "-" ? -value : value;
  }
}

export function parseNumberExpression(expression) {
  const normalized = normalizeExpression(expression);
  if (normalized === "INT_MIN") return resolvedValue(normalized, -2147483648);
  if (normalized === "INT_MAX") return resolvedValue(normalized, 2147483647);
  try {
    return resolvedValue(normalized, new NumericParser(normalized).parse());
  } catch {
    return unresolvedValue(normalized);
  }
}

function parseBooleanExpression(expression) {
  const normalized = normalizeExpression(expression);
  if (normalized === "true" || normalized === "1")
    return resolvedValue(normalized, true);
  if (normalized === "false" || normalized === "0")
    return resolvedValue(normalized, false);
  return unresolvedValue(normalized);
}

function parseEnumExpression(expression, values) {
  const normalized = normalizeExpression(expression);
  return Object.hasOwn(values, normalized)
    ? resolvedValue(normalized, values[normalized])
    : unresolvedValue(normalized);
}

function parseStringArray(expression) {
  const normalized = normalizeExpression(expression);
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) {
    return { expression: normalized, items: [], resolved: false };
  }
  const inner = normalized.slice(1, -1);
  const items = splitTopLevel(inner).filter(Boolean).map(parseStringExpression);
  return {
    expression: normalized,
    items,
    resolved: items.every((item) => item.resolved),
  };
}

function nextSemicolon(clean, start, limit) {
  const stack = [];
  const pairs = { "(": ")", "[": "]", "{": "}" };
  let quote = "";
  for (let index = start; index < limit; index += 1) {
    const character = clean[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (pairs[character]) stack.push(pairs[character]);
    else if (character === stack.at(-1)) stack.pop();
    else if (character === ";" && stack.length === 0) return index;
  }
  return -1;
}

function extractOperations(source, clean, start, end) {
  const operations = [];
  const pattern = /\bdef\s*->/g;
  pattern.lastIndex = start;
  while (true) {
    const match = pattern.exec(clean);
    if (!match || match.index >= end) break;
    const semicolon = nextSemicolon(clean, match.index, end);
    if (semicolon < 0) {
      throw new Error(
        `Unsupported unterminated def operation at line ${lineNumberAt(source, match.index)}`,
      );
    }
    const lineStart = clean.lastIndexOf("\n", match.index) + 1;
    const prefix = clean.slice(lineStart, match.index);
    const appendPrefix = prefix.match(/\bappend\s*\(\s*$/);
    if (appendPrefix) {
      const statementStart = lineStart + appendPrefix.index;
      const statement = clean.slice(statementStart, semicolon + 1);
      const parsed = statement.match(
        /^append\s*\(\s*def\s*->\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*)\s*\)\s*;$/,
      );
      if (
        !parsed ||
        parsed[1] !== parsed[3] ||
        !ENUM_ARRAY_FIELDS.has(parsed[1])
      ) {
        throw new Error(
          `Unsupported append-to-def syntax at line ${lineNumberAt(source, statementStart)}: ${normalizeExpression(statement)}`,
        );
      }
      operations.push({
        field: parsed[1],
        operation: "append-copy",
        sourceVariable: parsed[2],
        expression: normalizeExpression(`${parsed[2]}->${parsed[3]}`),
        line: lineNumberAt(source, statementStart),
      });
      pattern.lastIndex = semicolon + 1;
      continue;
    }
    const statement = clean.slice(match.index, semicolon + 1);
    let parsed = statement.match(
      /^def\s*->\s*set_default_value\s*\(([\s\S]*)\)\s*;$/,
    );
    if (parsed) {
      operations.push({
        field: "default_value",
        operation: "set",
        expression: normalizeExpression(parsed[1]),
        line: lineNumberAt(source, match.index),
      });
      pattern.lastIndex = semicolon + 1;
      continue;
    }
    parsed = statement.match(
      /^def\s*->\s*([A-Za-z_]\w*)\s*\.\s*(push_back|emplace_back)\s*\(([\s\S]*)\)\s*;$/,
    );
    if (parsed) {
      const field = parsed[1];
      if (!ENUM_ARRAY_FIELDS.has(field)) {
        throw new Error(
          `Unsupported def vector mutation ${field}.${parsed[2]} at line ${lineNumberAt(source, match.index)}`,
        );
      }
      operations.push({
        field,
        operation: "append",
        expression: normalizeExpression(parsed[3]),
        line: lineNumberAt(source, match.index),
      });
      pattern.lastIndex = semicolon + 1;
      continue;
    }
    parsed = statement.match(/^def\s*->\s*([A-Za-z_]\w*)\s*=\s*([\s\S]*);$/);
    if (parsed) {
      const field = parsed[1];
      if (!Object.hasOwn(FIELD_KINDS, field)) {
        throw new Error(
          `Unsupported ConfigOptionDef field ${field} at line ${lineNumberAt(source, match.index)}`,
        );
      }
      operations.push({
        field,
        operation: "assign",
        expression: normalizeExpression(parsed[2]),
        line: lineNumberAt(source, match.index),
      });
      pattern.lastIndex = semicolon + 1;
      continue;
    }
    throw new Error(
      `Unsupported def syntax at line ${lineNumberAt(source, match.index)}: ${normalizeExpression(statement)}`,
    );
  }
  return operations;
}

function sourceField(
  value,
  expression = null,
  provided = false,
  inference = null,
) {
  const field = { provided, resolved: true, value };
  if (expression !== null) field.expression = normalizeExpression(expression);
  if (inference !== null) field.inference = inference;
  return field;
}

function emptyDefinition(registration, technology) {
  const type = OPTION_TYPES[registration.optionType];
  if (!type)
    throw new Error(
      `Unsupported ConfigOptionType ${registration.optionType} for ${registration.key}`,
    );
  return {
    id: registration.id,
    key: registration.key,
    owner: registration.symbol,
    registrationKind: registration.kind,
    storage: {
      optionType: registration.optionType,
      valueType: type.valueType,
      shape: type.shape,
      nullable: registration.nullable ?? false,
      percentSemantics: type.percent,
      serialization: {
        collectionDelimiter: type.collectionDelimiter,
        componentDelimiter: type.componentDelimiter,
        nilToken: registration.nullable ? "nil" : null,
        percentSuffix: type.percent === "none" ? null : "%",
      },
    },
    constraints: {
      min: sourceField(null),
      max: sourceField(null),
      maxLiteral: sourceField(1),
    },
    presentation: {
      label: sourceField(null),
      fullLabel: sourceField(null),
      category: sourceField(null),
      tooltip: sourceField(null),
      unit: sourceField(null),
      multiline: sourceField(false),
      fullWidth: sourceField(false),
      readonly: sourceField(false),
      height: sourceField(null),
      width: sourceField(null),
      guiType: sourceField("undefined"),
      guiFlags: sourceField(""),
    },
    applicability: {
      mode: sourceField("simple"),
      technology,
    },
    enum: {
      keyMapExpression: sourceField(null),
      storageMap: null,
      values: [],
      labels: [],
      valuesU1: [],
      labelsU1: [],
      valuesExtended: [],
      labelsExtended: [],
    },
    behavior: {
      cli: sourceField(null),
      cliParams: sourceField(null),
      ratioOver: sourceField(null),
      aliases: sourceField([]),
    },
    default: { provided: false, resolved: false },
    sourceAssignments: [],
    provenance: registration.provenance,
  };
}

function inferTechnology(symbol) {
  if (symbol === "PrintConfigDef::init_common_params") {
    return sourceField(
      "any",
      "assign_printer_technology_to_unknown(this->options, ptAny)",
      false,
      "PrintConfigDef constructor phase",
    );
  }
  if (symbol === "PrintConfigDef::init_fff_params") {
    return sourceField(
      "fff",
      "assign_printer_technology_to_unknown(this->options, ptFFF)",
      false,
      "PrintConfigDef constructor phase",
    );
  }
  if (symbol === "PrintConfigDef::init_sla_params") {
    return sourceField(
      "sla",
      "assign_printer_technology_to_unknown(this->options, ptSLA)",
      false,
      "PrintConfigDef constructor phase",
    );
  }
  return sourceField("unknown");
}

function parseConstructor(expression) {
  const normalized = normalizeExpression(expression);
  const match = normalized.match(
    /^new\s+([A-Za-z_:][\w:]*(?:<[^>]+>)?)\s*([({])([\s\S]*)([)}])$/,
  );
  if (!match || (match[2] === "(" ? match[4] !== ")" : match[4] !== "}")) {
    return {
      className: null,
      expression: normalized,
      provided: true,
      resolved: false,
      kind: "cpp-expression",
    };
  }
  const className = match[1];
  const content = match[3].trim();
  const vectorClass =
    /^(?:ConfigOptionFloats|ConfigOptionInts|ConfigOptionStrings|ConfigOptionBools|ConfigOptionPercents|ConfigOptionEnumsGeneric)$/.test(
      className,
    );
  if (/^ConfigOptionEnum<[^>]+>$/.test(className)) {
    return {
      className,
      expression: normalized,
      provided: true,
      resolved: false,
      kind: "enum",
      symbol: normalizeExpression(content),
    };
  }
  if (className === "ConfigOptionFloatOrPercent") {
    const args = splitTopLevel(content);
    if (args.length !== 2)
      return {
        className,
        expression: normalized,
        provided: true,
        resolved: false,
        kind: "float-or-percent",
      };
    const value = parseNumberExpression(args[0]);
    const percent = parseBooleanExpression(args[1]);
    return value.resolved && percent.resolved
      ? {
          className,
          expression: normalized,
          provided: true,
          resolved: true,
          kind: "float-or-percent",
          value: { value: value.value, percent: percent.value },
        }
      : {
          className,
          expression: normalized,
          provided: true,
          resolved: false,
          kind: "float-or-percent",
          parts: { value, percent },
        };
  }
  if (className === "ConfigOptionPoint" || className === "ConfigOptionPoint3") {
    const dimensions = className === "ConfigOptionPoint" ? 2 : 3;
    if (!content)
      return {
        className,
        expression: normalized,
        provided: true,
        resolved: true,
        kind: "point",
        value: Array(dimensions).fill(0),
      };
    const vec = content.match(/^Vec[23]d\s*\(([\s\S]*)\)$/);
    if (!vec)
      return {
        className,
        expression: normalized,
        provided: true,
        resolved: false,
        kind: "point",
      };
    const items = splitTopLevel(vec[1]).map(parseNumberExpression);
    return items.length === dimensions && items.every((item) => item.resolved)
      ? {
          className,
          expression: normalized,
          provided: true,
          resolved: true,
          kind: "point",
          value: items.map((item) => item.value),
        }
      : {
          className,
          expression: normalized,
          provided: true,
          resolved: false,
          kind: "point",
          items,
        };
  }
  if (className === "ConfigOptionPoints") {
    if (!content)
      return {
        className,
        expression: normalized,
        provided: true,
        resolved: true,
        kind: "vector",
        value: [],
      };
    const points = splitTopLevel(content).map((item) => {
      const vec = item.match(/^Vec2d\s*\(([\s\S]*)\)$/);
      if (!vec) return unresolvedValue(item);
      const coordinates = splitTopLevel(vec[1]).map(parseNumberExpression);
      return coordinates.length === 2 &&
        coordinates.every((coordinate) => coordinate.resolved)
        ? resolvedValue(
            item,
            coordinates.map((coordinate) => coordinate.value),
          )
        : unresolvedValue(item);
    });
    return points.every((point) => point.resolved)
      ? {
          className,
          expression: normalized,
          provided: true,
          resolved: true,
          kind: "vector",
          value: points.map((point) => point.value),
        }
      : {
          className,
          expression: normalized,
          provided: true,
          resolved: false,
          kind: "vector",
          items: points,
        };
  }
  const scalarParsers = {
    ConfigOptionFloat: parseNumberExpression,
    ConfigOptionInt: parseNumberExpression,
    ConfigOptionPercent: parseNumberExpression,
    ConfigOptionBool: parseBooleanExpression,
    ConfigOptionString: parseStringExpression,
  };
  if (Object.hasOwn(scalarParsers, className)) {
    const parser = scalarParsers[className];
    const defaultValues = {
      ConfigOptionFloat: 0,
      ConfigOptionInt: 0,
      ConfigOptionPercent: 0,
      ConfigOptionBool: false,
      ConfigOptionString: "",
    };
    const parsed = content
      ? parser(content)
      : resolvedValue("", defaultValues[className]);
    return parsed.resolved
      ? {
          className,
          expression: normalized,
          provided: true,
          resolved: true,
          kind: "scalar",
          value: parsed.value,
        }
      : {
          className,
          expression: normalized,
          provided: true,
          resolved: false,
          kind: "scalar",
          scalar: parsed,
        };
  }
  if (vectorClass) {
    if (!content)
      return {
        className,
        expression: normalized,
        provided: true,
        resolved: true,
        kind: "vector",
        value: [],
      };
    let vectorContent = content;
    if (vectorContent.startsWith("{") && vectorContent.endsWith("}"))
      vectorContent = vectorContent.slice(1, -1).trim();
    if (className === "ConfigOptionEnumsGeneric") {
      const symbols = splitTopLevel(vectorContent).map(normalizeExpression);
      return {
        className,
        expression: normalized,
        provided: true,
        resolved: false,
        kind: "enum-vector",
        symbols,
      };
    }
    const parser =
      className === "ConfigOptionStrings"
        ? parseStringExpression
        : className === "ConfigOptionBools"
          ? parseBooleanExpression
          : parseNumberExpression;
    const items = splitTopLevel(vectorContent).map(parser);
    return items.every((item) => item.resolved)
      ? {
          className,
          expression: normalized,
          provided: true,
          resolved: true,
          kind: "vector",
          value: items.map((item) => item.value),
        }
      : {
          className,
          expression: normalized,
          provided: true,
          resolved: false,
          kind: "vector",
          items,
        };
  }
  return {
    className,
    expression: normalized,
    provided: true,
    resolved: false,
    kind: "cpp-expression",
  };
}

function setParsedField(definition, target, key, expression, parser) {
  const parsed = parser(expression);
  target[key] = { provided: true, ...parsed };
}

function applyOperation(definition, operation, sourceVariables) {
  definition.sourceAssignments.push(operation);
  const { field, expression } = operation;
  if (field === "default_value") {
    definition.default = parseConstructor(expression);
    return;
  }
  if (ENUM_ARRAY_FIELDS.has(field)) {
    const mapping = {
      enum_values: "values",
      enum_labels: "labels",
      enum_values_u1: "valuesU1",
      enum_labels_u1: "labelsU1",
      enum_values_ex: "valuesExtended",
      enum_labels_ex: "labelsExtended",
    };
    const target = definition.enum[mapping[field]];
    if (operation.operation === "append") {
      target.push(parseStringExpression(expression));
    } else if (operation.operation === "append-copy") {
      const sourceDefinition = sourceVariables.get(operation.sourceVariable);
      if (!sourceDefinition) {
        throw new Error(
          `Unknown source variable ${operation.sourceVariable} while copying ${field} into ${definition.key}`,
        );
      }
      const sourceItems = sourceDefinition.enum[mapping[field]];
      target.push(
        ...sourceItems.map((item) => ({
          ...item,
          inference: `copied by ${operation.expression} from ${sourceDefinition.key}`,
        })),
      );
    } else {
      const copy = expression.match(/^([A-Za-z_]\w*)->([A-Za-z_]\w*)$/);
      if (copy) {
        if (copy[2] !== field)
          throw new Error(
            `Mismatched enum field copy ${expression} into ${field}`,
          );
        const sourceDefinition = sourceVariables.get(copy[1]);
        if (!sourceDefinition)
          throw new Error(
            `Unknown source variable ${copy[1]} while copying ${field} into ${definition.key}`,
          );
        const sourceItems = sourceDefinition.enum[mapping[field]];
        target.length = 0;
        target.push(
          ...sourceItems.map((item) => ({
            ...item,
            inference: `copied by ${expression} from ${sourceDefinition.key}`,
          })),
        );
        return;
      }
      const array = parseStringArray(expression);
      target.length = 0;
      if (array.items.length) target.push(...array.items);
      else target.push(unresolvedValue(expression));
    }
    return;
  }
  const presentation = {
    label: "label",
    full_label: "fullLabel",
    category: "category",
    tooltip: "tooltip",
    sidetext: "unit",
    multiline: "multiline",
    full_width: "fullWidth",
    readonly: "readonly",
    height: "height",
    width: "width",
    gui_type: "guiType",
    gui_flags: "guiFlags",
  };
  const copy =
    operation.operation === "assign"
      ? expression.match(/^([A-Za-z_]\w*)->([A-Za-z_]\w*)$/)
      : null;
  if (copy) {
    if (copy[2] !== field)
      throw new Error(`Mismatched field copy ${expression} into ${field}`);
    const sourceDefinition = sourceVariables.get(copy[1]);
    if (!sourceDefinition)
      throw new Error(
        `Unknown source variable ${copy[1]} while copying ${field} into ${definition.key}`,
      );
    let sourceValue;
    let destination;
    let destinationKey;
    if (Object.hasOwn(presentation, field)) {
      sourceValue = sourceDefinition.presentation[presentation[field]];
      destination = definition.presentation;
      destinationKey = presentation[field];
    } else if (field === "min" || field === "max" || field === "max_literal") {
      destinationKey = field === "max_literal" ? "maxLiteral" : field;
      sourceValue = sourceDefinition.constraints[destinationKey];
      destination = definition.constraints;
    } else if (
      field === "cli" ||
      field === "cli_params" ||
      field === "ratio_over"
    ) {
      destinationKey =
        field === "cli_params"
          ? "cliParams"
          : field === "ratio_over"
            ? "ratioOver"
            : "cli";
      sourceValue = sourceDefinition.behavior[destinationKey];
      destination = definition.behavior;
    } else {
      throw new Error(
        `Unsupported source-backed field copy ${expression} into ${definition.key}`,
      );
    }
    destination[destinationKey] = {
      ...sourceValue,
      expression,
      inference: `copied from ${sourceDefinition.key}`,
    };
    return;
  }
  if (Object.hasOwn(presentation, field)) {
    const target = presentation[field];
    const parser =
      FIELD_KINDS[field] === "string"
        ? parseStringExpression
        : FIELD_KINDS[field] === "boolean"
          ? parseBooleanExpression
          : FIELD_KINDS[field] === "number"
            ? parseNumberExpression
            : FIELD_KINDS[field] === "gui-type"
              ? (value) =>
                  resolvedValue(
                    value,
                    normalizeExpression(value).replace(
                      /^ConfigOptionDef::GUIType::/,
                      "",
                    ),
                  )
              : parseStringExpression;
    setParsedField(
      definition,
      definition.presentation,
      target,
      expression,
      parser,
    );
    return;
  }
  if (field === "min" || field === "max" || field === "max_literal") {
    setParsedField(
      definition,
      definition.constraints,
      field === "max_literal" ? "maxLiteral" : field,
      expression,
      parseNumberExpression,
    );
    return;
  }
  if (field === "mode") {
    setParsedField(
      definition,
      definition.applicability,
      "mode",
      expression,
      (value) => parseEnumExpression(value, MODE_VALUES),
    );
    return;
  }
  if (field === "printer_technology") {
    setParsedField(
      definition,
      definition.applicability,
      "technology",
      expression,
      (value) => parseEnumExpression(value, TECHNOLOGY_VALUES),
    );
    return;
  }
  if (field === "enum_keys_map") {
    definition.enum.keyMapExpression = {
      provided: true,
      ...unresolvedValue(expression),
    };
    return;
  }
  if (field === "cli" || field === "cli_params" || field === "ratio_over") {
    setParsedField(
      definition,
      definition.behavior,
      field === "cli_params"
        ? "cliParams"
        : field === "ratio_over"
          ? "ratioOver"
          : "cli",
      expression,
      parseStringExpression,
    );
    return;
  }
  if (field === "aliases") {
    const parsed = parseStringArray(expression);
    definition.behavior.aliases = {
      expression: parsed.expression,
      provided: true,
      resolved: parsed.resolved,
      ...(parsed.resolved
        ? { value: parsed.items.map((item) => item.value) }
        : { items: parsed.items }),
    };
    return;
  }
  throw new Error(`Parser implementation missed supported field ${field}`);
}

function registrationVariable(clean, call) {
  const lineStart = clean.lastIndexOf("\n", call.start) + 1;
  const prefix = clean.slice(lineStart, call.start);
  return (
    prefix.match(/(?:^|\s)(?:auto\s+)?([A-Za-z_]\w*)\s*=\s*def\s*=\s*$/)?.[1] ??
    null
  );
}

function verifyManifestMetadata(definition, manifestDefinition) {
  const fields = [
    ["label", definition.presentation.label],
    ["category", definition.presentation.category],
  ];
  for (const [name, field] of fields) {
    const expected = manifestDefinition[name];
    if (!field.provided || expected === null || expected === undefined)
      continue;
    if (!field.resolved || field.value !== expected) {
      throw new Error(
        `Manifest ${name} mismatch for ${definition.key}: schema ${field.resolved ? JSON.stringify(field.value) : "<unresolved>"}, manifest ${JSON.stringify(expected)}`,
      );
    }
  }
  if (
    manifestDefinition.mode !== null &&
    manifestDefinition.mode !== undefined
  ) {
    const expectedMode = MODE_VALUES[manifestDefinition.mode];
    if (expectedMode === undefined)
      throw new Error(
        `Unsupported manifest mode ${manifestDefinition.mode} for ${definition.key}`,
      );
    if (
      !definition.applicability.mode.resolved ||
      definition.applicability.mode.value !== expectedMode
    ) {
      throw new Error(
        `Manifest mode mismatch for ${definition.key}: schema ${definition.applicability.mode.value}, manifest ${manifestDefinition.mode}`,
      );
    }
  }
  if (
    Boolean(manifestDefinition.macroExpanded) !==
    (definition.registrationKind === "macro")
  ) {
    throw new Error(`Manifest macro-expansion mismatch for ${definition.key}`);
  }
}

function registrationLiteral(expression) {
  const parsed = parseStringExpression(expression);
  return parsed.resolved ? parsed.value : null;
}

function parseEnumMaps(source, clean) {
  const maps = new Map();
  const pattern = /\bs_keys_map_([A-Za-z_]\w*)\s*(?:=\s*)?\{/g;
  for (const match of clean.matchAll(pattern)) {
    const open = clean.indexOf("{", match.index);
    const close = findMatching(clean, open, "{", "}");
    const body = clean.slice(open + 1, close);
    const entries = [];
    for (const rawEntry of splitTopLevel(body)) {
      const trimmed = rawEntry.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
        throw new Error(
          `Unsupported enum-map entry in s_keys_map_${match[1]} at line ${lineNumberAt(source, open)}`,
        );
      }
      const parts = splitTopLevel(trimmed.slice(1, -1));
      if (parts.length !== 2)
        throw new Error(
          `Enum-map entry does not have two fields in s_keys_map_${match[1]}`,
        );
      const serialized = parseStringExpression(parts[0]);
      if (!serialized.resolved)
        throw new Error(
          `Unresolved enum serialization key ${parts[0]} in s_keys_map_${match[1]}`,
        );
      entries.push({
        serialized: serialized.value,
        valueExpression: normalizeExpression(parts[1]),
      });
    }
    maps.set(match[1], {
      name: match[1],
      entries,
      line: lineNumberAt(source, match.index),
    });
    pattern.lastIndex = close + 1;
  }
  return maps;
}

function enumMapName(expression) {
  if (!expression) return null;
  const direct = expression.match(/&s_keys_map_([A-Za-z_]\w*)/);
  if (direct) return direct[1];
  const generic = expression.match(
    /&ConfigOptionEnum<\s*([A-Za-z_]\w*)\s*>::get_enum_values\s*\(\s*\)/,
  );
  return generic?.[1] ?? null;
}

function normalizedEnumSymbol(expression) {
  return normalizeExpression(expression)
    .replace(/^\(int\)\s*/, "")
    .replace(/^int\s*\((.*)\)$/, "$1")
    .replace(/^static_cast<int>\s*\((.*)\)$/, "$1")
    .replace(/\s+/g, "");
}

function enumSymbolsEquivalent(leftExpression, rightExpression) {
  const left = normalizedEnumSymbol(leftExpression);
  const right = normalizedEnumSymbol(rightExpression);
  if (left === right) return true;
  const leftLeaf = left.split("::").at(-1);
  const rightLeaf = right.split("::").at(-1);
  return (
    leftLeaf === rightLeaf && (!left.includes("::") || !right.includes("::"))
  );
}

function attachEnumMaps(definitions, maps) {
  for (const definition of definitions) {
    const expression = definition.enum.keyMapExpression.expression;
    const name = enumMapName(expression);
    if (name !== null) {
      const map = maps.get(name);
      if (!map)
        throw new Error(
          `Unknown enum key map ${name} referenced by ${definition.key}`,
        );
      definition.enum.keyMapExpression = {
        ...definition.enum.keyMapExpression,
        resolved: true,
        value: name,
      };
      definition.enum.storageMap = map;
    }
    if (
      definition.default.kind === "enum" &&
      definition.default.symbol &&
      definition.enum.storageMap
    ) {
      const entries = definition.enum.storageMap.entries.filter((candidate) =>
        enumSymbolsEquivalent(
          candidate.valueExpression,
          definition.default.symbol,
        ),
      );
      if (entries.length > 1)
        throw new Error(
          `Ambiguous enum default ${definition.default.symbol} for ${definition.key}`,
        );
      if (entries.length === 1) {
        definition.default.resolved = true;
        definition.default.value = entries[0].serialized;
      }
    }
    if (
      definition.default.kind === "enum-vector" &&
      definition.default.symbols &&
      definition.enum.storageMap
    ) {
      const serialized = definition.default.symbols.map((symbol) => {
        const entries = definition.enum.storageMap.entries.filter((candidate) =>
          enumSymbolsEquivalent(candidate.valueExpression, symbol),
        );
        if (entries.length > 1)
          throw new Error(
            `Ambiguous enum-vector default ${symbol} for ${definition.key}`,
          );
        return entries[0]?.serialized ?? null;
      });
      if (serialized.every((value) => value !== null)) {
        definition.default.resolved = true;
        definition.default.value = serialized;
      }
    }
  }
}

function manifestIndex(manifest) {
  const definitions = manifest?.inventory?.settingDefinitions;
  if (!Array.isArray(definitions))
    throw new Error("Parity manifest has no settingDefinitions inventory");
  const byLineAndKey = new Map();
  for (const definition of definitions) {
    const source = definition.sources?.[0];
    if (!source)
      throw new Error(`Manifest definition ${definition.id} has no source`);
    const identity = `${source.line}\0${definition.key}`;
    if (byLineAndKey.has(identity))
      throw new Error(`Duplicate manifest source identity ${identity}`);
    byLineAndKey.set(identity, definition);
  }
  return byLineAndKey;
}

function parseNumericInitializer(expression, description) {
  const normalized = normalizeExpression(expression);
  if (!normalized.startsWith("{") || !normalized.endsWith("}")) {
    throw new Error(`Unsupported ${description} initializer: ${normalized}`);
  }
  const values = splitTopLevel(normalized.slice(1, -1))
    .filter(Boolean)
    .map(parseNumberExpression);
  if (values.length === 0 || values.some((value) => !value.resolved)) {
    throw new Error(`Unresolved ${description} initializer: ${normalized}`);
  }
  return values.map((value) => value.value);
}

function resolveAxisFormat(expression, axisUpper, description) {
  const normalized = normalizeExpression(expression);
  const match = normalized.match(
    /^\(boost::format\((.*)\)\s*%\s*axis_upper\)\.str\(\)$/,
  );
  if (!match)
    throw new Error(`Unsupported dynamic axis ${description}: ${normalized}`);
  const format = parseStringExpression(match[1]);
  if (!format.resolved || !format.value.includes("%1%")) {
    throw new Error(`Unresolved dynamic axis ${description}: ${normalized}`);
  }
  return {
    expression: normalized,
    provided: true,
    resolved: true,
    value: format.value.replaceAll("%1%", axisUpper),
    inference: `evaluated boost::format with axis_upper=${axisUpper}`,
  };
}

function parseDynamicAxisDefinitions({
  source,
  clean,
  snapshot,
  manifest,
  manifestDefinitions,
  matchedManifestIds,
}) {
  const axesMatch = /\bstd::vector\s*<\s*AxisDefault\s*>\s+axes\s*\{/g.exec(
    clean,
  );
  if (!axesMatch) throw new Error("AxisDefault initializer was not found");
  const axesOpen = clean.indexOf("{", axesMatch.index);
  const axesClose = findMatching(clean, axesOpen, "{", "}");
  const rows = splitTopLevel(clean.slice(axesOpen + 1, axesClose))
    .filter(Boolean)
    .map((entry, index) => {
      const normalized = normalizeExpression(entry);
      if (!normalized.startsWith("{") || !normalized.endsWith("}")) {
        throw new Error(
          `Unsupported AxisDefault row ${index + 1}: ${normalized}`,
        );
      }
      const parts = splitTopLevel(normalized.slice(1, -1));
      if (parts.length !== 4)
        throw new Error(
          `AxisDefault row ${index + 1} has ${parts.length} fields, expected four`,
        );
      const name = parseStringExpression(parts[0]);
      if (!name.resolved || !/^[xyze]$/.test(name.value))
        throw new Error(`Unsupported AxisDefault name ${parts[0]}`);
      return {
        name: name.value,
        upper: name.value.toUpperCase(),
        maxFeedrate: parseNumericInitializer(
          parts[1],
          `${name.value} max_feedrate`,
        ),
        maxAcceleration: parseNumericInitializer(
          parts[2],
          `${name.value} max_acceleration`,
        ),
        maxJerk: parseNumericInitializer(parts[3], `${name.value} max_jerk`),
        expression: normalized,
      };
    });
  if (rows.length !== 4 || rows.map((row) => row.name).join("") !== "xyze") {
    throw new Error(
      `Unsupported AxisDefault roster: ${rows.map((row) => row.name).join(", ")}`,
    );
  }

  const loopPattern =
    /for\s*\(\s*const\s+AxisDefault\s*&\s*axis\s*:\s*axes\s*\)\s*\{/g;
  loopPattern.lastIndex = axesClose;
  const loopMatch = loopPattern.exec(clean);
  if (!loopMatch) throw new Error("AxisDefault expansion loop was not found");
  const loopOpen = clean.indexOf("{", loopMatch.index);
  const loopClose = findMatching(clean, loopOpen, "{", "}");
  const templates = findCalls(source, "this->add").filter(
    (call) => call.start > loopOpen && call.start < loopClose,
  );
  const expected = new Map([
    [
      "machine_max_speed_",
      { sourceMember: "axis.max_feedrate", rowMember: "maxFeedrate" },
    ],
    [
      "machine_max_acceleration_",
      { sourceMember: "axis.max_acceleration", rowMember: "maxAcceleration" },
    ],
    [
      "machine_max_jerk_",
      { sourceMember: "axis.max_jerk", rowMember: "maxJerk" },
    ],
  ]);
  if (templates.length !== expected.size) {
    throw new Error(
      `Expected ${expected.size} dynamic axis registrations, found ${templates.length}`,
    );
  }

  const definitions = [];
  const sourceVariables = new Map();
  for (
    let templateIndex = 0;
    templateIndex < templates.length;
    templateIndex += 1
  ) {
    const call = templates[templateIndex];
    const keyExpression = normalizeExpression(call.args[0]);
    const expressionMatch = keyExpression.match(
      /^"([^"]+)"\s*\+\s*axis\.name$/,
    );
    if (!expressionMatch || !expected.has(expressionMatch[1])) {
      throw new Error(
        `Unsupported dynamic axis key at line ${call.line}: ${keyExpression}`,
      );
    }
    const prefix = expressionMatch[1];
    const axisSpec = expected.get(prefix);
    const optionType = normalizeExpression(call.args[1]);
    if (optionType !== "coFloats")
      throw new Error(`Unsupported ${prefix} type ${optionType}`);
    const manifestDefinition = manifestDefinitions.get(
      `${call.line}\0${prefix}`,
    );
    if (!manifestDefinition)
      throw new Error(
        `Dynamic axis template ${prefix} at line ${call.line} is missing from the parity manifest`,
      );
    if (manifestDefinition.optionType !== optionType) {
      throw new Error(
        `Type mismatch for ${prefix}: source ${optionType}, manifest ${manifestDefinition.optionType}`,
      );
    }
    const symbol = symbolAt(source, call.start);
    if (manifestDefinition.symbol !== symbol)
      throw new Error(
        `Owner mismatch for ${prefix}: source ${symbol}, manifest ${manifestDefinition.symbol}`,
      );
    matchedManifestIds.add(manifestDefinition.id);
    const nextBoundary = templates[templateIndex + 1]?.start ?? loopClose;
    const operations = extractOperations(source, clean, call.end, nextBoundary);
    for (const row of rows) {
      const key = `${prefix}${row.name}`;
      const registration = {
        id: `${manifestDefinition.id}:axis:${row.name}`,
        key,
        optionType,
        symbol,
        kind: "derived-axis",
        provenance: sourceProvenance(
          snapshot,
          manifest,
          { symbol },
          call.line,
          source.slice(call.start, call.end),
          {
            manifestDefinitionId: manifestDefinition.id,
            axisInitializer: row.expression,
          },
        ),
      };
      const definition = emptyDefinition(registration, inferTechnology(symbol));
      for (const operation of operations)
        applyOperation(definition, operation, sourceVariables);
      if (
        !definition.presentation.fullLabel.provided ||
        !definition.presentation.tooltip.provided
      ) {
        throw new Error(
          `Dynamic axis template ${prefix} does not provide full_label and tooltip`,
        );
      }
      definition.presentation.fullLabel = resolveAxisFormat(
        definition.presentation.fullLabel.expression,
        row.upper,
        `${key} full_label`,
      );
      definition.presentation.tooltip = resolveAxisFormat(
        definition.presentation.tooltip.expression,
        row.upper,
        `${key} tooltip`,
      );
      const expectedDefault = `new ConfigOptionFloats(${axisSpec.sourceMember})`;
      if (definition.default.expression !== expectedDefault) {
        throw new Error(
          `Unsupported ${key} default: ${definition.default.expression ?? "<missing>"}`,
        );
      }
      definition.default = {
        className: definition.default.className,
        expression: definition.default.expression,
        provided: true,
        kind: "vector",
        resolved: true,
        value: [...row[axisSpec.rowMember]],
        inference: `evaluated ${axisSpec.sourceMember} from AxisDefault row ${row.name}`,
      };
      definitions.push(definition);
    }
  }
  return definitions;
}

function sourceProvenance(
  snapshot,
  manifest,
  definition,
  line,
  anchor,
  derivedFrom = null,
) {
  const provenance = {
    repository: manifest.upstream.repository,
    commit: manifest.upstream.commit,
    tree: manifest.upstream.tree,
    path: PRINT_CONFIG_PATH,
    blob: snapshot.blob(PRINT_CONFIG_PATH),
    line,
    anchor: normalizeExpression(anchor),
    symbol: definition.symbol,
  };
  if (derivedFrom !== null) provenance.derivedFrom = derivedFrom;
  return provenance;
}

function parseDynamicFilamentDefinitions(
  source,
  clean,
  literalDefinitions,
  snapshot,
  manifest,
) {
  const calls = findCalls(source, "this->add_nullable");
  if (calls.length !== 1)
    throw new Error(
      `Expected one dynamic add_nullable site, found ${calls.length}`,
    );
  const call = calls[0];
  const keyExpression = normalizeExpression(call.args[0]);
  const typeExpression = normalizeExpression(call.args[1]);
  if (
    keyExpression !== 'std::string("filament_") + opt_key' ||
    typeExpression !== "it_opt->second.type"
  ) {
    throw new Error(
      `Unsupported dynamic option registration at line ${call.line}: ${keyExpression}, ${typeExpression}`,
    );
  }
  const loopStart = clean.lastIndexOf("for (const char *opt_key", call.start);
  if (loopStart < 0)
    throw new Error("Dynamic filament option loop was not found");
  const listOpen = clean.indexOf("{", loopStart);
  const listClose = findMatching(clean, listOpen, "{", "}");
  if (listClose > call.start)
    throw new Error(
      "Dynamic filament option key list did not end before registration",
    );
  const keys = scanCppStringLiterals(
    source.slice(listOpen + 1, listClose),
  ).values;
  if (keys.length === 0 || new Set(keys).size !== keys.length)
    throw new Error("Dynamic filament option list is empty or duplicated");
  const bodyOpen = clean.indexOf("{", listClose + 1);
  const bodyClose = findMatching(clean, bodyOpen, "{", "}");
  const body = normalizeExpression(clean.slice(call.end, bodyClose));
  const requiredFragments = [
    "def->label = it_opt->second.label;",
    "def->full_label = it_opt->second.full_label;",
    "def->tooltip = it_opt->second.tooltip;",
    "def->sidetext = it_opt->second.sidetext;",
    "def->enum_keys_map = it_opt->second.enum_keys_map;",
    "def->enum_labels = it_opt->second.enum_labels;",
    "def->enum_values = it_opt->second.enum_values;",
    "def->min = it_opt->second.min;",
    "def->max = it_opt->second.max;",
    "switch (def->type)",
  ];
  for (const fragment of requiredFragments) {
    if (!body.includes(fragment))
      throw new Error(
        `Unsupported dynamic filament option body: missing ${fragment}`,
      );
  }
  const simpleKeys = new Set([
    "retraction_length",
    "z_hop",
    "long_retractions_when_cut",
    "retraction_distances_when_cut",
  ]);
  const definitions = [];
  for (const baseKey of keys) {
    const candidates = literalDefinitions.filter(
      (definition) =>
        definition.key === baseKey &&
        definition.owner === "PrintConfigDef::init_fff_params" &&
        definition.provenance.line < call.line,
    );
    const base = candidates.at(-1);
    if (!base)
      throw new Error(
        `Dynamic filament option ${baseKey} has no source definition`,
      );
    if (base.storage.shape !== "vector")
      throw new Error(`Dynamic filament base ${baseKey} is not vector-valued`);
    const key = `filament_${baseKey}`;
    const registration = {
      id: `derived-nullable:${key}`,
      key,
      symbol: "PrintConfigDef::init_fff_params",
      kind: "derived-nullable",
      optionType: base.storage.optionType,
      nullable: true,
      provenance: sourceProvenance(
        snapshot,
        manifest,
        { symbol: "PrintConfigDef::init_fff_params" },
        call.line,
        source.slice(call.start, call.end),
        base.provenance,
      ),
    };
    const definition = emptyDefinition(
      registration,
      inferTechnology(registration.symbol),
    );
    definition.presentation.label = {
      ...base.presentation.label,
      inference: `copied from ${baseKey}`,
    };
    definition.presentation.fullLabel = {
      ...base.presentation.fullLabel,
      inference: `copied from ${baseKey}`,
    };
    definition.presentation.tooltip = {
      ...base.presentation.tooltip,
      inference: `copied from ${baseKey}`,
    };
    definition.presentation.unit = {
      ...base.presentation.unit,
      inference: `copied from ${baseKey}`,
    };
    definition.constraints.min = {
      ...base.constraints.min,
      inference: `copied from ${baseKey}`,
    };
    definition.constraints.max = {
      ...base.constraints.max,
      inference: `copied from ${baseKey}`,
    };
    definition.enum.keyMapExpression = {
      ...base.enum.keyMapExpression,
      inference: `copied from ${baseKey}`,
    };
    definition.enum.storageMap = base.enum.storageMap;
    definition.enum.values = base.enum.values.map((value) => ({
      ...value,
      inference: `copied from ${baseKey}`,
    }));
    definition.enum.labels = base.enum.labels.map((value) => ({
      ...value,
      inference: `copied from ${baseKey}`,
    }));
    definition.applicability.mode = sourceField(
      simpleKeys.has(baseKey) ? "simple" : "advanced",
      simpleKeys.has(baseKey)
        ? "conditional simple-mode key list"
        : "dynamic-loop else branch",
      true,
    );
    definition.default = {
      ...base.default,
      expression: `nullable copy of ${baseKey}: ${base.default.expression ?? "<no default>"}`,
      inference: `copied through nullable ${base.storage.optionType} switch from ${baseKey}`,
    };
    definitions.push(definition);
  }
  return definitions;
}

function collectLocalBindings(source, clean) {
  const bindings = [];
  const patterns = [
    {
      kind: "string",
      pattern: /\b(?:const\s+)?std::string\s+([A-Za-z_]\w*)\s*=/g,
      parser: parseStringExpression,
    },
    {
      kind: "number",
      pattern: /\bconst\s+(?:int|double|float|auto)\s+([A-Za-z_]\w*)\s*=/g,
      parser: parseNumberExpression,
    },
  ];
  for (const { kind, pattern, parser } of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const expressionStart = match.index + match[0].length;
      const semicolon = nextSemicolon(clean, expressionStart, clean.length);
      if (semicolon < 0)
        throw new Error(`Unterminated local ${kind} binding ${match[1]}`);
      const expression = source.slice(expressionStart, semicolon);
      const parsed = parser(expression);
      if (!parsed.resolved) continue;
      bindings.push({
        kind,
        name: match[1],
        owner: symbolAt(source, match.index),
        line: lineNumberAt(source, match.index),
        expression: normalizeExpression(expression),
        value: parsed.value,
      });
    }
  }
  return bindings;
}

function bindingsAt(bindings, owner, line, kind) {
  const result = new Map();
  for (const binding of bindings) {
    if (
      binding.kind !== kind ||
      binding.owner !== owner ||
      binding.line >= line
    )
      continue;
    const previous = result.get(binding.name);
    if (!previous || previous.line < binding.line)
      result.set(binding.name, binding);
  }
  return result;
}

function substituteStringBindings(expression, bindings) {
  let output = "";
  let quote = "";
  for (let index = 0; index < expression.length;) {
    const character = expression[index];
    if (quote) {
      output += character;
      if (character === "\\") {
        output += expression[index + 1] ?? "";
        index += 2;
      } else {
        if (character === quote) quote = "";
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      index += 1;
      continue;
    }
    const identifier = expression.slice(index).match(/^[A-Za-z_]\w*/)?.[0];
    if (identifier) {
      const binding = bindings.get(identifier);
      output += binding ? JSON.stringify(binding.value) : identifier;
      index += identifier.length;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

function resolveLocalBindings(source, clean, definitions) {
  const bindings = collectLocalBindings(source, clean);
  const stringFields = (definition) => [
    definition.presentation.label,
    definition.presentation.fullLabel,
    definition.presentation.category,
    definition.presentation.tooltip,
    definition.presentation.unit,
    definition.presentation.guiFlags,
    definition.behavior.cli,
    definition.behavior.cliParams,
    definition.behavior.ratioOver,
    ...definition.enum.values,
    ...definition.enum.labels,
    ...definition.enum.valuesU1,
    ...definition.enum.labelsU1,
    ...definition.enum.valuesExtended,
    ...definition.enum.labelsExtended,
  ];
  for (const definition of definitions) {
    const stringBindings = bindingsAt(
      bindings,
      definition.owner,
      definition.provenance.line,
      "string",
    );
    for (const field of stringFields(definition)) {
      if (!field?.provided && !Object.hasOwn(field ?? {}, "expression"))
        continue;
      if (field.resolved || !field.expression) continue;
      const substituted = substituteStringBindings(
        field.expression,
        stringBindings,
      );
      if (substituted === field.expression) continue;
      const parsed = parseStringExpression(substituted);
      if (!parsed.resolved) continue;
      const used = [...stringBindings.values()].filter((binding) =>
        new RegExp(`\\b${binding.name}\\b`).test(field.expression),
      );
      Object.assign(field, {
        resolved: true,
        value: parsed.value,
        inference: `resolved local string binding(s): ${used.map((binding) => `${binding.name}@${binding.line}`).join(", ")}`,
      });
    }
    const numberBindings = bindingsAt(
      bindings,
      definition.owner,
      definition.provenance.line,
      "number",
    );
    for (const field of [
      definition.constraints.min,
      definition.constraints.max,
      definition.constraints.maxLiteral,
    ]) {
      if (field.resolved || !field.expression) continue;
      const match = field.expression.match(/^([+-]?)([A-Za-z_]\w*)$/);
      const binding = match ? numberBindings.get(match[2]) : null;
      if (!binding) continue;
      Object.assign(field, {
        resolved: true,
        value: match[1] === "-" ? -binding.value : binding.value,
        inference: `resolved local numeric binding ${binding.name}@${binding.line}`,
      });
    }
  }
}

function coverage(definitions) {
  const unresolvedFields = {};
  let unresolvedDefaults = 0;
  let missingDefaults = 0;
  let enumWithoutMap = 0;
  const visit = (path, value) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(`${path}/${index}`, item));
    } else if (value && typeof value === "object") {
      if (
        Object.hasOwn(value, "resolved") &&
        value.resolved === false &&
        Object.hasOwn(value, "expression")
      ) {
        const family = path.replace(/\/\d+/g, "/*");
        unresolvedFields[family] = (unresolvedFields[family] ?? 0) + 1;
        return;
      }
      for (const [key, child] of Object.entries(value))
        visit(`${path}/${key}`, child);
    }
  };
  const definitionsWithoutExplicitDefault = [];
  for (const definition of definitions) {
    if (!definition.default.provided) {
      missingDefaults += 1;
      definitionsWithoutExplicitDefault.push({
        id: definition.id,
        key: definition.key,
        owner: definition.owner,
      });
    } else if (!definition.default.resolved) unresolvedDefaults += 1;
    if (
      definition.storage.valueType === "enum" &&
      definition.enum.storageMap === null
    )
      enumWithoutMap += 1;
    visit("", definition);
  }
  const byKey = new Map();
  for (const definition of definitions) {
    const entries = byKey.get(definition.key) ?? [];
    entries.push(definition);
    byKey.set(definition.key, entries);
  }
  const duplicateKeys = [...byKey.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([key, entries]) => ({
      key,
      count: entries.length,
      owners: entries.map((entry) => entry.owner),
    }))
    .sort((left, right) => left.key.localeCompare(right.key, "en"));
  return {
    definitions: definitions.length,
    uniqueKeys: new Set(definitions.map((definition) => definition.key)).size,
    printConfigDefinitions: definitions.filter((definition) =>
      definition.owner.startsWith("PrintConfigDef::"),
    ).length,
    derivedAxisDefinitions: definitions.filter(
      (definition) => definition.registrationKind === "derived-axis",
    ).length,
    derivedNullableDefinitions: definitions.filter(
      (definition) => definition.registrationKind === "derived-nullable",
    ).length,
    missingDefaults,
    definitionsWithoutExplicitDefault,
    duplicateKeys,
    unresolvedDefaults,
    enumWithoutStorageMap: enumWithoutMap,
    unresolvedSourceValues: Object.values(unresolvedFields).reduce(
      (sum, value) => sum + value,
      0,
    ),
    unresolvedSourceValueFamilies: Object.fromEntries(
      Object.entries(unresolvedFields).sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      ),
    ),
  };
}

function verifySerializationAuthority(configHeader) {
  const required = [
    ["coStrings semicolon serialization", "// semicolon-separated strings"],
    ["numeric vector comma serialization", "std::getline(is, item_str, ',')"],
    ["point-vector component delimiter", 'ss << "x";'],
    ["nullable nil token", 'ss << "nil";'],
  ];
  for (const [description, fragment] of required) {
    if (!configHeader.includes(fragment))
      throw new Error(
        `Config.hpp drift: missing ${description} authority fragment`,
      );
  }
}

export function extractEngineOptionSchema({
  snapshot,
  manifest,
  manifestSha256,
  allowSyntheticSource = false,
}) {
  if (manifest?.upstream?.commit === undefined) {
    throw new Error("Parity manifest has no pinned upstream commit");
  }
  if (manifest.upstream.commit !== "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626") {
    throw new Error(`Unexpected settings baseline ${manifest.upstream.commit}`);
  }
  if (!/^[0-9a-f]{64}$/.test(manifestSha256 ?? ""))
    throw new Error("Exact parity-manifest SHA-256 is required");
  if (snapshot.tree !== manifest.upstream.tree)
    throw new Error(
      `Manifest tree ${manifest.upstream.tree} != pinned source tree ${snapshot.tree}`,
    );
  const source = snapshot.read(PRINT_CONFIG_PATH);
  const configHeader = snapshot.read(CONFIG_HEADER_PATH);
  verifySerializationAuthority(configHeader);
  const sourceFileIndex = new Map(
    manifest.sourceFiles.map((file) => [file.path, file.blob]),
  );
  for (const path of [PRINT_CONFIG_PATH, CONFIG_HEADER_PATH]) {
    if (allowSyntheticSource) continue;
    if (sourceFileIndex.get(path) !== snapshot.blob(path)) {
      throw new Error(`Manifest/source blob mismatch for ${path}`);
    }
  }
  const clean = stripCppComments(source);
  const allDirectCalls = findCalls(source, "this->add");
  const allMacroCalls = findCalls(source, "new_def");
  const directCalls = allDirectCalls.filter(
    (call) => registrationLiteral(call.args[0]) !== null,
  );
  const macroCalls = allMacroCalls.filter(
    (call) => registrationLiteral(call.args[0]) !== null,
  );
  const allowedDynamicKeys = new Set([
    '"machine_max_speed_" + axis.name',
    '"machine_max_acceleration_" + axis.name',
    '"machine_max_jerk_" + axis.name',
    "OPT_KEY",
  ]);
  const unsupportedDynamicCalls = allDirectCalls.filter(
    (call) =>
      registrationLiteral(call.args[0]) === null &&
      !allowedDynamicKeys.has(normalizeExpression(call.args[0])),
  );
  if (unsupportedDynamicCalls.length) {
    const call = unsupportedDynamicCalls[0];
    throw new Error(
      `Unsupported dynamic this->add key at line ${call.line}: ${normalizeExpression(call.args[0])}`,
    );
  }
  const macroHelperCalls = allDirectCalls.filter(
    (call) => normalizeExpression(call.args[0]) === "OPT_KEY",
  );
  const macroDeclarations = allMacroCalls.filter(
    (call) => normalizeExpression(call.args[0]) === "OPT_KEY",
  );
  if (macroHelperCalls.length !== 1 || macroDeclarations.length !== 1) {
    throw new Error(
      `Expected one new_def macro helper, found ${macroHelperCalls.length} this->add and ${macroDeclarations.length} declarations`,
    );
  }
  const unresolvedMacroCalls = allMacroCalls.filter(
    (call) =>
      registrationLiteral(call.args[0]) === null &&
      normalizeExpression(call.args[0]) !== "OPT_KEY",
  );
  if (unresolvedMacroCalls.length) {
    const call = unresolvedMacroCalls[0];
    throw new Error(
      `Unsupported dynamic new_def key at line ${call.line}: ${normalizeExpression(call.args[0])}`,
    );
  }
  const registrations = [
    ...directCalls.map((call) => ({ ...call, kind: "literal" })),
    ...macroCalls.map((call) => ({ ...call, kind: "macro" })),
  ].sort((left, right) => left.start - right.start);
  const allBoundaries = [
    ...findCalls(source, "this->add"),
    ...findCalls(source, "this->add_nullable"),
    ...findCalls(source, "new_def"),
  ].sort((left, right) => left.start - right.start);
  const manifestDefinitions = manifestIndex(manifest);
  const matchedManifestIds = new Set();
  const literalDefinitions = [];
  const sourceVariables = new Map();
  for (const call of registrations) {
    const key = registrationLiteral(call.args[0]);
    const manifestDefinition = manifestDefinitions.get(`${call.line}\0${key}`);
    if (!manifestDefinition)
      throw new Error(
        `Source option ${key} at line ${call.line} is missing from the parity manifest`,
      );
    if (manifestDefinition.optionType !== normalizeExpression(call.args[1])) {
      throw new Error(
        `Type mismatch for ${key}: source ${normalizeExpression(call.args[1])}, manifest ${manifestDefinition.optionType}`,
      );
    }
    const symbol = symbolAt(source, call.start);
    if (manifestDefinition.symbol !== symbol)
      throw new Error(
        `Owner mismatch for ${key}: source ${symbol}, manifest ${manifestDefinition.symbol}`,
      );
    if (
      !allowSyntheticSource &&
      manifestDefinition.sources[0].blob !== snapshot.blob(PRINT_CONFIG_PATH)
    )
      throw new Error(`Stale source blob for ${key}`);
    matchedManifestIds.add(manifestDefinition.id);
    const nextBoundary =
      allBoundaries.find((boundary) => boundary.start > call.start)?.start ??
      source.length;
    const registration = {
      id: manifestDefinition.id,
      key,
      optionType: normalizeExpression(call.args[1]),
      symbol,
      kind: call.kind,
      provenance: sourceProvenance(
        snapshot,
        manifest,
        { symbol },
        call.line,
        source.slice(call.start, call.end),
      ),
    };
    const definition = emptyDefinition(registration, inferTechnology(symbol));
    if (call.kind === "macro") {
      if (call.args.length !== 4)
        throw new Error(`new_def for ${key} does not have four arguments`);
      definition.presentation.label = {
        provided: true,
        ...parseStringExpression(call.args[2]),
      };
      definition.presentation.tooltip = {
        provided: true,
        ...parseStringExpression(call.args[3]),
      };
    }
    const operations = extractOperations(source, clean, call.end, nextBoundary);
    for (const operation of operations)
      applyOperation(definition, operation, sourceVariables);
    verifyManifestMetadata(definition, manifestDefinition);
    literalDefinitions.push(definition);
    const variable = registrationVariable(clean, call);
    if (variable !== null) {
      if (sourceVariables.has(variable))
        throw new Error(
          `Duplicate registration variable ${variable} at line ${call.line}`,
        );
      sourceVariables.set(variable, definition);
    }
  }
  const axisDefinitions = parseDynamicAxisDefinitions({
    source,
    clean,
    snapshot,
    manifest,
    manifestDefinitions,
    matchedManifestIds,
  });
  if (
    matchedManifestIds.size !== manifest.inventory.settingDefinitions.length
  ) {
    const missing = manifest.inventory.settingDefinitions.filter(
      (definition) => !matchedManifestIds.has(definition.id),
    );
    throw new Error(
      `Parity manifest has ${missing.length} setting definitions missing from source: ${missing
        .slice(0, 5)
        .map((item) => item.id)
        .join(", ")}`,
    );
  }
  const enumMaps = parseEnumMaps(source, clean);
  const sourceDefinitions = [...literalDefinitions, ...axisDefinitions];
  attachEnumMaps(sourceDefinitions, enumMaps);
  const dynamic = parseDynamicFilamentDefinitions(
    source,
    clean,
    sourceDefinitions,
    snapshot,
    manifest,
  );
  attachEnumMaps(dynamic, enumMaps);
  const definitions = [...sourceDefinitions, ...dynamic].sort((left, right) =>
    `${left.owner}\0${left.key}\0${String(left.provenance.line).padStart(6, "0")}\0${left.id}`.localeCompare(
      `${right.owner}\0${right.key}\0${String(right.provenance.line).padStart(6, "0")}\0${right.id}`,
      "en",
    ),
  );
  resolveLocalBindings(source, clean, definitions);
  const ids = new Set();
  for (const definition of definitions) {
    if (ids.has(definition.id))
      throw new Error(`Duplicate schema definition id ${definition.id}`);
    ids.add(definition.id);
  }
  const schemaCoverage = coverage(definitions);
  if (
    schemaCoverage.unresolvedDefaults !== 0 ||
    schemaCoverage.unresolvedSourceValues !== 0
  ) {
    throw new Error(
      `Unsupported source expressions remain: ${schemaCoverage.unresolvedDefaults} defaults, ` +
        `${schemaCoverage.unresolvedSourceValues} metadata values`,
    );
  }
  const guiLayout = extractGuiLayout({
    snapshot,
    manifest,
    allowSyntheticSource,
  });
  const definitionsByKey = new Map();
  for (const definition of definitions) {
    const matches = definitionsByKey.get(definition.key) ?? [];
    matches.push(definition);
    definitionsByKey.set(definition.key, matches);
  }
  const placements = guiLayout.placements.map((placement) => {
    const matches = definitionsByKey.get(placement.optionKey) ?? [];
    if (matches.length === 0)
      throw new Error(
        `Tab.cpp placement ${placement.id} references unknown engine option ${placement.optionKey}`,
      );
    return {
      ...placement,
      definitionBinding: {
        definitionIds: matches.map((definition) => definition.id),
        status: matches.length === 1 ? "exact" : "ambiguous",
      },
    };
  });
  const placedKeys = new Set(
    placements.map((placement) => placement.optionKey),
  );
  const ambiguousDefinitionKeys = [...placedKeys]
    .filter((key) => (definitionsByKey.get(key)?.length ?? 0) > 1)
    .sort((left, right) => left.localeCompare(right, "en"));
  for (const widget of guiLayout.unresolved.specialWidgets) {
    if (!definitionsByKey.has(widget.optionKey))
      throw new Error(
        `Tab.cpp custom widget references unknown engine option ${widget.optionKey}`,
      );
  }
  for (const write of guiLayout.scopeEvidence.projectConfigWrites) {
    if (!definitionsByKey.has(write.optionKey))
      throw new Error(
        `Tab.cpp project-config write references unknown engine option ${write.optionKey}`,
      );
  }
  const resolvedGuiLayout = {
    ...guiLayout,
    coverage: {
      ...guiLayout.coverage,
      ambiguousDefinitionKeys,
      definitionsWithoutLiteralPlacement: definitions.filter(
        (definition) => !placedKeys.has(definition.key),
      ).length,
      exactDefinitionBindings: placements.filter(
        (placement) => placement.definitionBinding.status === "exact",
      ).length,
    },
    placements,
  };
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    parser: {
      name: "OrcaXR source-backed settings schema extractor",
      version: SETTINGS_PARSER_VERSION,
    },
    status: "foundation-partial",
    source: {
      repository: manifest.upstream.repository,
      commit: manifest.upstream.commit,
      tree: manifest.upstream.tree,
      files: [
        { path: PRINT_CONFIG_PATH, blob: snapshot.blob(PRINT_CONFIG_PATH) },
        { path: CONFIG_HEADER_PATH, blob: snapshot.blob(CONFIG_HEADER_PATH) },
        { path: TAB_SOURCE_PATH, blob: snapshot.blob(TAB_SOURCE_PATH) },
        { path: "docs/parity/snapmaker-v2.3.4.json", sha256: manifestSha256 },
      ],
    },
    coverage: schemaCoverage,
    guiLayout: resolvedGuiLayout,
    limitations: [
      "Every source-provided value is resolved for this pin and retains its C++ expression; generation fails closed if a future expression is unsupported.",
      "The exact manifest-backed Tab.cpp inventory provides literal tab, group, and placement order. Dynamic and composite/multi-option placements, custom widgets, and general object/part/layer/plate scopes remain explicitly unresolved and fail closed. Dependency predicates and per-control reset rules remain unresolved and unenforced; three exact project-config writes are retained as narrow scope evidence.",
      "Legacy conversions in handle_legacy are not modeled as aliases unless ConfigOptionDef::aliases declares them.",
      "A commit-pinned runtime ConfigOptionDef dumper remains required to certify effective defaults and enum maps against the compiled engine.",
    ],
    definitions,
  };
}

export { OPTION_TYPES };
