/** Runtime for the generated, bounded project-intent shapes. No domain execution. */
export type IntentShape =
  | {
      readonly kind: "integer" | "wholeNumber" | "number";
      readonly min: number;
      readonly max: number;
    }
  | { readonly kind: "boolean" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | {
      readonly kind: "array";
      readonly items: string;
      readonly min: number;
      readonly max: number;
    }
  | {
      readonly kind: "object";
      readonly fields: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "union";
      readonly variants: Readonly<Record<string, string>>;
    };
export interface IntentLimits {
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
}
export class InvalidProjectIntent extends Error {
  constructor() {
    super("Invalid project command intent");
    this.name = "InvalidProjectIntent";
  }
}
function fail(): never {
  throw new InvalidProjectIntent();
}

/** Capture data properties only, before queueing. No getters, prototypes,
 * sparse arrays, symbols, typed arrays or caller-owned mutable descendants. */
export function captureIntent(
  name: string,
  value: unknown,
  shapes: Readonly<Record<string, IntentShape>>,
  limits: IntentLimits,
): unknown {
  let nodes = limits.maxNodes;
  let bytes = limits.maxBytes;
  function charge(count: number) {
    if ((bytes -= count) < 0) fail();
  }
  function visit(type: string, input: unknown, depth: number): unknown {
    if (--nodes < 0 || depth > limits.maxDepth) fail();
    const shape = shapes[type];
    switch (shape.kind) {
      case "number":
      case "wholeNumber":
      case "integer":
        if (
          typeof input !== "number" ||
          !(shape.kind === "integer"
            ? Number.isSafeInteger(input)
            : shape.kind === "wholeNumber"
              ? Number.isInteger(input)
              : Number.isFinite(input)) ||
          input < shape.min ||
          input > shape.max
        )
          fail();
        charge(JSON.stringify(input).length);
        return input === 0 ? 0 : input;
      case "enum":
        if (typeof input !== "string" || !shape.values.includes(input)) fail();
        charge(input.length + 2);
        return input;
      case "boolean":
        if (typeof input !== "boolean") fail();
        charge(input ? 4 : 5);
        return input;
      case "array": {
        if (
          !Array.isArray(input) ||
          Object.getPrototypeOf(input) !== Array.prototype ||
          Object.getOwnPropertySymbols(input).length
        )
          fail();
        const length = input.length;
        if (
          length < shape.min ||
          length > shape.max ||
          length > nodes ||
          Object.getOwnPropertyNames(input).length !== length + 1
        )
          fail();
        charge(2 + Math.max(0, length - 1));
        const output: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const property = Object.getOwnPropertyDescriptor(
            input,
            String(index),
          );
          if (!property || !("value" in property)) fail();
          output.push(visit(shape.items, property.value, depth + 1));
        }
        return Object.freeze(output);
      }
      case "object":
      case "union": {
        if (
          !input ||
          typeof input !== "object" ||
          Object.getPrototypeOf(input) !== Object.prototype ||
          Object.getOwnPropertySymbols(input).length
        )
          fail();
        const keys = Object.getOwnPropertyNames(input);
        const fields = shape.kind === "object" ? shape.fields : shape.variants;
        if (
          shape.kind === "object"
            ? keys.length !== Object.keys(fields).length
            : keys.length !== 1
        )
          fail();
        charge(2 + Math.max(0, keys.length - 1));
        const output: Record<string, unknown> = {};
        for (const key of keys) {
          if (!Object.hasOwn(fields, key)) fail();
          const property = Object.getOwnPropertyDescriptor(input, key)!;
          if (!("value" in property)) fail();
          charge(key.length + 3);
          output[key] = visit(fields[key], property.value, depth + 1);
        }
        return Object.freeze(output);
      }
    }
    return fail();
  }
  return visit(name, value, 0);
}

/** ASCII wire JSON: all user text is encoded as integer UTF-16 units. Parse
 * before shape conversion to detect duplicate keys and bound nodes/depth. */
export function parseIntentJson(text: string, limits: IntentLimits): unknown {
  if (
    typeof text !== "string" ||
    text.length > limits.maxBytes ||
    /[^\x00-\x7f]/.test(text)
  )
    fail();
  let offset = 0;
  let nodes = limits.maxNodes;
  const numeric = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  function whitespace() {
    while (offset < text.length && " \t\r\n".includes(text[offset])) offset++;
  }
  function string(): string {
    const start = offset;
    if (text[offset++] !== '"') fail();
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          fail();
        }
      }
      if (character.charCodeAt(0) < 32) fail();
      if (character === "\\") offset++;
    }
    fail();
  }
  function read(depth: number): unknown {
    if (--nodes < 0 || depth > limits.maxDepth) fail();
    whitespace();
    const token = text[offset];
    if (token === "{" || token === "[") {
      offset++;
      const object: Record<string, unknown> = {};
      const array: unknown[] = [];
      const close = token === "{" ? "}" : "]";
      whitespace();
      if (text[offset] !== close)
        while (true) {
          whitespace();
          if (token === "{") {
            const key = string();
            if (Object.hasOwn(object, key)) fail();
            whitespace();
            if (text[offset++] !== ":") fail();
            Object.defineProperty(object, key, {
              value: read(depth + 1),
              enumerable: true,
              configurable: true,
              writable: true,
            });
          } else array.push(read(depth + 1));
          whitespace();
          if (text[offset] === close) break;
          if (text[offset++] !== ",") fail();
        }
      offset++;
      return token === "{" ? object : array;
    }
    if (token === '"') return string();
    for (const [word, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(word, offset)) {
        offset += word.length;
        return value;
      }
    }
    numeric.lastIndex = offset;
    const match = numeric.exec(text);
    if (!match) fail();
    offset = numeric.lastIndex;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) fail();
    return number;
  }
  const output = read(0);
  whitespace();
  if (offset !== text.length) fail();
  return output;
}
