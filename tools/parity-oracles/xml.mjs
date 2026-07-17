const XMLNS_URI = "http://www.w3.org/2000/xmlns/";
const XML_URI = "http://www.w3.org/XML/1998/namespace";

function decodeEntities(value) {
  return value.replace(/&([^;\s]+);/g, (match, entity) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const hexadecimal = /^#x[0-9A-Fa-f]+$/.test(entity);
    const decimal = /^#\d+$/.test(entity);
    if (!hexadecimal && !decimal) {
      throw new Error(
        `Unsupported XML entity ${match}; external entities are forbidden`,
      );
    }
    const codePoint = hexadecimal
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (
      !Number.isSafeInteger(codePoint) ||
      codePoint < 0 ||
      codePoint > 0x10ffff
    ) {
      throw new Error(`Invalid XML character reference ${match}`);
    }
    return String.fromCodePoint(codePoint);
  });
}

function findTagEnd(source, start) {
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  throw new Error("Unterminated XML tag");
}

function parseStartTag(raw) {
  let cursor = 0;
  while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
  const nameMatch = raw.slice(cursor).match(/^([^\s/>]+)/);
  if (!nameMatch) throw new Error(`Malformed XML start tag <${raw}>`);
  const name = nameMatch[1];
  cursor += name.length;
  const attributes = [];
  while (cursor < raw.length) {
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    if (cursor >= raw.length) break;
    const attrMatch = raw.slice(cursor).match(/^([^\s=/>]+)/);
    if (!attrMatch) throw new Error(`Malformed XML attribute in <${raw}>`);
    const attrName = attrMatch[1];
    cursor += attrName.length;
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    if (raw[cursor] !== "=")
      throw new Error(`XML attribute ${attrName} has no value`);
    cursor += 1;
    while (/\s/.test(raw[cursor] ?? "")) cursor += 1;
    const quote = raw[cursor];
    if (quote !== '"' && quote !== "'")
      throw new Error(`XML attribute ${attrName} is not quoted`);
    cursor += 1;
    const valueStart = cursor;
    const valueEnd = raw.indexOf(quote, valueStart);
    if (valueEnd < 0) throw new Error(`Unterminated XML attribute ${attrName}`);
    attributes.push([
      attrName,
      decodeEntities(raw.slice(valueStart, valueEnd)),
    ]);
    cursor = valueEnd + 1;
  }
  return { attributes, name };
}

function splitQualifiedName(name) {
  const colon = name.indexOf(":");
  return colon < 0
    ? { local: name, prefix: "" }
    : { local: name.slice(colon + 1), prefix: name.slice(0, colon) };
}

function expandedName(name, namespaces, isAttribute = false) {
  const { local, prefix } = splitQualifiedName(name);
  if (prefix === "xml") return `{${XML_URI}}${local}`;
  if (prefix === "xmlns" || name === "xmlns") return `{${XMLNS_URI}}${local}`;
  const uri = prefix
    ? namespaces.get(prefix)
    : isAttribute
      ? ""
      : (namespaces.get("") ?? "");
  if (prefix && !uri)
    throw new Error(`Unbound XML namespace prefix ${prefix} in ${name}`);
  return uri ? `{${uri}}${local}` : local;
}

export function localName(expanded) {
  const close = expanded.lastIndexOf("}");
  return close < 0 ? expanded : expanded.slice(close + 1);
}

export function namespaceUri(expanded) {
  return expanded.startsWith("{")
    ? expanded.slice(1, expanded.indexOf("}"))
    : "";
}

/**
 * Small namespace-aware XML parser for package metadata. DTDs and external entities are
 * rejected intentionally; 3MF does not need them and accepting them would make the oracle
 * unsafe for hostile archives.
 */
export function parseXml(input, sourceName = "<xml>") {
  const source = String(input)
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const document = { children: [], name: "#document" };
  const stack = [{ node: document, namespaces: new Map([["xml", XML_URI]]) }];
  let cursor = 0;
  const appendText = (value, cdata = false) => {
    const decoded = cdata ? value : decodeEntities(value);
    if (!decoded) return;
    const children = stack.at(-1).node.children;
    if (children.at(-1)?.type === "text") children.at(-1).text += decoded;
    else children.push({ text: decoded, type: "text" });
  };

  try {
    while (cursor < source.length) {
      const open = source.indexOf("<", cursor);
      if (open < 0) {
        appendText(source.slice(cursor));
        break;
      }
      appendText(source.slice(cursor, open));
      if (source.startsWith("<!--", open)) {
        const end = source.indexOf("-->", open + 4);
        if (end < 0) throw new Error("Unterminated XML comment");
        cursor = end + 3;
        continue;
      }
      if (source.startsWith("<![CDATA[", open)) {
        const end = source.indexOf("]]>", open + 9);
        if (end < 0) throw new Error("Unterminated XML CDATA section");
        appendText(source.slice(open + 9, end), true);
        cursor = end + 3;
        continue;
      }
      if (/^<!DOCTYPE\b/i.test(source.slice(open, open + 12))) {
        throw new Error("XML DOCTYPE declarations are forbidden");
      }
      if (source.startsWith("<?", open)) {
        const end = source.indexOf("?>", open + 2);
        if (end < 0) throw new Error("Unterminated XML processing instruction");
        cursor = end + 2;
        continue;
      }
      if (source.startsWith("</", open)) {
        const end = findTagEnd(source, open + 2);
        const rawName = source.slice(open + 2, end).trim();
        if (stack.length === 1)
          throw new Error(`Unexpected closing tag </${rawName}>`);
        const current = stack.pop();
        const closing = expandedName(rawName, current.namespaces);
        if (closing !== current.node.name) {
          throw new Error(
            `Closing tag </${rawName}> does not match ${current.node.name}`,
          );
        }
        cursor = end + 1;
        continue;
      }
      if (source.startsWith("<!", open))
        throw new Error("Unsupported XML declaration");

      const end = findTagEnd(source, open + 1);
      let raw = source.slice(open + 1, end);
      const selfClosing = /\/\s*$/.test(raw);
      if (selfClosing) raw = raw.replace(/\/\s*$/, "");
      const parsed = parseStartTag(raw);
      const parentNamespaces = stack.at(-1).namespaces;
      const namespaces = new Map(parentNamespaces);
      for (const [name, value] of parsed.attributes) {
        if (name === "xmlns") namespaces.set("", value);
        else if (name.startsWith("xmlns:"))
          namespaces.set(name.slice(6), value);
      }
      const attributes = {};
      for (const [name, value] of parsed.attributes) {
        if (name === "xmlns" || name.startsWith("xmlns:")) continue;
        const expanded = expandedName(name, namespaces, true);
        if (Object.hasOwn(attributes, expanded))
          throw new Error(`Duplicate XML attribute ${expanded}`);
        attributes[expanded] = value;
      }
      const node = {
        attributes,
        children: [],
        name: expandedName(parsed.name, namespaces),
        type: "element",
      };
      stack.at(-1).node.children.push(node);
      if (!selfClosing) stack.push({ namespaces, node });
      cursor = end + 1;
    }
    if (stack.length !== 1)
      throw new Error(`Unclosed XML element ${stack.at(-1).node.name}`);
    const roots = document.children.filter((child) => child.type === "element");
    if (roots.length !== 1)
      throw new Error(`Expected one XML root element, found ${roots.length}`);
    if (
      document.children.some(
        (child) => child.type === "text" && child.text.trim(),
      )
    ) {
      throw new Error("Non-whitespace text exists outside the XML root");
    }
    return roots[0];
  } catch (error) {
    throw new Error(`${sourceName}: ${error.message}`, { cause: error });
  }
}

const NUMERIC_ATTRIBUTES = new Set([
  "x",
  "y",
  "z",
  "v1",
  "v2",
  "v3",
  "id",
  "objectid",
  "pindex",
  "pid",
  "min_z",
  "max_z",
  "instance_id",
  "object_id",
  "plate_id",
]);

function canonicalNumber(value) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(value))
    return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return Object.is(number, -0) ? "0" : String(number);
}

function canonicalAttribute(name, value) {
  const local = localName(name);
  if (local === "transform") {
    return value.trim().split(/\s+/).map(canonicalNumber).join(" ");
  }
  return NUMERIC_ATTRIBUTES.has(local) ? canonicalNumber(value.trim()) : value;
}

/** Convert parsed XML to a prefix-independent, attribute-order-independent JSON value. */
export function canonicalXml(node) {
  const attributes = Object.fromEntries(
    Object.entries(node.attributes)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([name, value]) => [name, canonicalAttribute(name, value)]),
  );
  const hasElements = node.children.some((child) => child.type === "element");
  const children = [];
  for (const child of node.children) {
    if (child.type === "element") {
      children.push(canonicalXml(child));
    } else {
      const text = child.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      if (hasElements && !text.trim()) continue;
      const normalized = hasElements ? text : text.trim();
      if (normalized) children.push(normalized);
    }
  }
  return { attributes, children, name: node.name };
}

export function childElements(node, wantedLocalName = null) {
  return node.children.filter(
    (child) =>
      child.type === "element" &&
      (wantedLocalName === null || localName(child.name) === wantedLocalName),
  );
}

export function descendants(node, predicate = () => true) {
  const result = [];
  const visit = (current, path) => {
    if (predicate(current)) result.push({ node: current, path });
    const counts = new Map();
    for (const child of childElements(current)) {
      const local = localName(child.name);
      const occurrence = counts.get(local) ?? 0;
      counts.set(local, occurrence + 1);
      visit(child, `${path}/${local}[${occurrence}]`);
    }
  };
  visit(node, `/${localName(node.name)}[0]`);
  return result;
}

export function attribute(node, wantedLocalName) {
  const pair = Object.entries(node.attributes).find(
    ([name]) => localName(name) === wantedLocalName,
  );
  return pair?.[1] ?? null;
}

export function textContent(node) {
  return node.children
    .map((child) => (child.type === "text" ? child.text : textContent(child)))
    .join("");
}
