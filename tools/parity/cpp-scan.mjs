import { createHash } from "node:crypto";

export function lineNumberAt(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1)
    if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Replace comments with spaces while retaining strings, offsets, and line breaks. */
export function stripCppComments(source) {
  const out = [...source];
  let mode = "code";
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];
    if (mode === "line") {
      if (c === "\n") mode = "code";
      else out[i] = " ";
      continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 1;
        mode = "code";
      } else if (c !== "\n") out[i] = " ";
      continue;
    }
    if (mode === "string") {
      if (c === "\\") {
        i += 1;
      } else if (c === quote) {
        mode = "code";
      }
      continue;
    }
    if (c === "/" && n === "/") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 1;
      mode = "line";
    } else if (c === "/" && n === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 1;
      mode = "block";
    } else if (c === '"' || c === "'") {
      quote = c;
      mode = "string";
    }
  }
  if (mode === "block") throw new Error("Unterminated C++ block comment");
  return out.join("");
}

export function findMatching(source, openOffset, open = "(", close = ")") {
  let depth = 0;
  let quote = "";
  for (let i = openOffset; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === open) {
      depth += 1;
    } else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(
    `Unbalanced ${open}${close} beginning at offset ${openOffset}`,
  );
}

export function splitTopLevel(source, separator = ",") {
  const values = [];
  let start = 0;
  let quote = "";
  const stack = [];
  const pairs = { "(": ")", "[": "]", "{": "}", "<": ">" };
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (stack.at(-1) === c) stack.pop();
    else if (c === separator && stack.length === 0) {
      values.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  values.push(source.slice(start).trim());
  return values;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findCalls(source, callee) {
  const clean = stripCppComments(source);
  const pattern = new RegExp(`\\b${escapeRegExp(callee)}\\s*\\(`, "g");
  const calls = [];
  for (const match of clean.matchAll(pattern)) {
    const open = clean.indexOf("(", match.index + callee.length);
    const close = findMatching(clean, open);
    const next = clean.slice(close + 1).match(/^\s*(.)/s)?.[1] ?? "";
    // Ignore declarations and definitions of helper functions with the same name.
    if (next === "{") continue;
    calls.push({
      callee,
      start: match.index,
      end: close + 1,
      line: lineNumberAt(source, match.index),
      args: splitTopLevel(source.slice(open + 1, close)),
      text: source.slice(match.index, close + 1),
    });
    pattern.lastIndex = close + 1;
  }
  return calls;
}

const DEFINITION_CACHE = new Map();

function definitionCandidates(source) {
  const cached = DEFINITION_CACHE.get(source);
  if (cached) return cached;
  const clean = stripCppComments(source);
  const pattern =
    /^\s*(?:[\w:<>,~*&]+\s+)?([A-Za-z_~]\w*(?:::[A-Za-z_~]\w*)+)\s*\(/gm;
  const candidates = [];
  for (const match of clean.matchAll(pattern)) {
    const open = clean.indexOf("(", match.index);
    let close;
    try {
      close = findMatching(clean, open);
    } catch {
      continue;
    }
    const tail = clean.slice(close + 1, Math.min(clean.length, close + 1200));
    const brace = tail.indexOf("{");
    const semicolon = tail.indexOf(";");
    if (brace < 0 || (semicolon >= 0 && semicolon < brace)) continue;
    candidates.push({ start: match.index, symbol: match[1] });
  }
  DEFINITION_CACHE.set(source, candidates);
  return candidates;
}

export function symbolAt(source, offset) {
  let symbol = "<global>";
  for (const candidate of definitionCandidates(source)) {
    if (candidate.start > offset) break;
    symbol = candidate.symbol;
  }
  return symbol;
}

function decodeCppString(raw) {
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** First literal in a translated/plain C++ label expression, or null for runtime labels. */
export function literalString(expression) {
  if (!expression) return null;
  const translated = expression.match(/(?:_L|L)\(\s*"((?:\\.|[^"\\])*)"\s*\)/s);
  if (translated) return decodeCppString(translated[1]);
  const wide = expression.match(/L"((?:\\.|[^"\\])*)"/s);
  if (wide) return decodeCppString(wide[1]);
  const plain = expression.match(/"((?:\\.|[^"\\])*)"/s);
  return plain ? decodeCppString(plain[1]) : null;
}

export function normalizedExpression(expression) {
  return String(expression ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

export function shortHash(value, length = 12) {
  return createHash("sha256")
    .update(String(value))
    .digest("hex")
    .slice(0, length);
}

export function sourceLine(source, line) {
  return source.split("\n")[line - 1]?.trim() ?? "";
}

export function extractEnum(source, enumName) {
  const clean = stripCppComments(source);
  // A semicolon terminates a forward declaration; never scan through one to a later brace.
  const pattern = new RegExp(
    `\\benum(?:\\s+class)?\\s+${escapeRegExp(enumName)}(?:\\s*:[^{;]+)?\\s*\\{`,
    "m",
  );
  const match = pattern.exec(clean);
  if (!match) throw new Error(`Stale upstream symbol: enum ${enumName}`);
  const open = clean.indexOf("{", match.index);
  const close = findMatching(clean, open, "{", "}");
  const body = source.slice(open + 1, close);
  const cleanBody = clean.slice(open + 1, close);
  const values = [];
  let start = 0;
  let quote = "";
  let depth = 0;
  for (let i = 0; i <= cleanBody.length; i += 1) {
    const c = cleanBody[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if ("([{<".includes(c)) depth += 1;
    else if (")]}>".includes(c)) depth -= 1;
    else if ((c === "," || i === cleanBody.length) && depth === 0) {
      const raw = body.slice(start, i).trim();
      const cleaned = stripCppComments(raw).trim();
      const name = cleaned.match(/^([A-Za-z_]\w*)/)?.[1];
      if (name) {
        const localOffset = body.indexOf(raw, start);
        values.push({
          name,
          valueExpression:
            normalizedExpression(cleaned.split("=").slice(1).join("=")) || null,
          line: lineNumberAt(source, open + 1 + localOffset),
        });
      }
      start = i + 1;
    }
  }
  return { name: enumName, line: lineNumberAt(source, match.index), values };
}
