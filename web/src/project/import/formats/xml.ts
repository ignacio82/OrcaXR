import { MalformedModelSourceError, type ModelImportFormat, type ModelImportLimits } from './types';

export interface XmlElement {
  readonly name: string;
  readonly localName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly selfClosing: boolean;
  readonly depth: number;
}

export interface XmlHandlers {
  onOpen?(element: XmlElement): void;
  onClose?(localName: string, depth: number): void;
  onText?(text: string, parentLocalName: string): void;
}

/**
 * Minimal bounded XML scanner for mesh containers. It deliberately supports no
 * DTD, external entity, or processing instruction beyond the declaration, so a
 * hostile document cannot expand, fetch, or recurse; depth is capped and every
 * malformed construct fails closed with the source path in the message.
 */
export function scanXml(
  text: string,
  path: string,
  limits: ModelImportLimits,
  format: ModelImportFormat,
  handlers: XmlHandlers,
): void {
  const stack: string[] = [];
  let cursor = 0;
  let rootCount = 0;

  const fail: (message: string, reason?: 'invalid-syntax' | 'limit-exceeded') => never = (
    message,
    reason = 'invalid-syntax',
  ) => {
    throw new MalformedModelSourceError(`${path}: ${message}`, reason, format);
  };

  while (cursor < text.length) {
    const open = text.indexOf('<', cursor);
    if (open < 0) {
      if (text.slice(cursor).trim() && stack.length > 0) fail('text after the final element');
      break;
    }
    if (open > cursor) {
      const raw = text.slice(cursor, open);
      if (stack.length === 0) {
        if (raw.trim()) fail('text outside the root element');
      } else if (handlers.onText && raw.trim()) {
        handlers.onText(decodeXmlText(raw, path, format), stack[stack.length - 1]);
      }
    }

    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      if (end < 0) fail('unterminated processing instruction');
      cursor = end + 2;
      continue;
    }
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end < 0) fail('unterminated comment');
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      if (end < 0) fail('unterminated CDATA section');
      if (handlers.onText && stack.length > 0) {
        const raw = text.slice(open + 9, end);
        if (raw.trim()) handlers.onText(raw, stack[stack.length - 1]);
      }
      cursor = end + 3;
      continue;
    }
    if (text.startsWith('<!', open)) fail('document type declarations and entities are not supported');

    const end = findTagEnd(text, open + 1, () => fail('unterminated tag'));
    const source = text.slice(open + 1, end);
    if (source.startsWith('/')) {
      const name = source.slice(1).trim();
      const current = stack.pop();
      if (!current || current !== localNameOf(name)) fail(`mismatched closing tag </${name}>`);
      handlers.onClose?.(current, stack.length);
      cursor = end + 1;
      continue;
    }

    const element = parseOpeningTag(source, stack.length, path, format);
    if (stack.length === 0) {
      rootCount += 1;
      if (rootCount > 1) fail('multiple root elements');
    }
    if (!element.selfClosing) {
      if (stack.length + 1 > limits.maxXmlDepth)
        fail(`nesting deeper than ${limits.maxXmlDepth} elements`, 'limit-exceeded');
      stack.push(element.localName);
    }
    handlers.onOpen?.(element);
    if (element.selfClosing) handlers.onClose?.(element.localName, stack.length);
    cursor = end + 1;
  }

  if (stack.length > 0) fail(`unclosed element <${stack[stack.length - 1]}>`);
  if (rootCount !== 1) fail('exactly one root element is required');
}

function parseOpeningTag(source: string, depth: number, path: string, format: ModelImportFormat): XmlElement {
  const fail: (message: string) => never = (message) => {
    throw new MalformedModelSourceError(`${path}: ${message}`, 'invalid-syntax', format);
  };
  let cursor = 0;
  const skipSpace = (): void => {
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  };
  skipSpace();
  const nameStart = cursor;
  while (cursor < source.length && !/[\s/]/.test(source[cursor])) cursor += 1;
  const name = source.slice(nameStart, cursor);
  if (!/^[A-Za-z_][\w.:-]*$/.test(name)) fail(`invalid element name "${name}"`);

  const attributes: Record<string, string> = {};
  let selfClosing = false;
  while (cursor < source.length) {
    skipSpace();
    if (cursor >= source.length) break;
    if (source[cursor] === '/') {
      cursor += 1;
      skipSpace();
      if (cursor !== source.length) fail('characters after a self-closing marker');
      selfClosing = true;
      break;
    }
    const attributeStart = cursor;
    while (cursor < source.length && !/[\s=]/.test(source[cursor])) cursor += 1;
    const attributeName = source.slice(attributeStart, cursor);
    if (!/^[A-Za-z_][\w.:-]*$/.test(attributeName)) fail(`invalid attribute name "${attributeName}"`);
    if (attributeName in attributes) fail(`duplicate attribute "${attributeName}"`);
    skipSpace();
    if (source[cursor] !== '=') fail(`attribute "${attributeName}" has no value`);
    cursor += 1;
    skipSpace();
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") fail(`attribute "${attributeName}" is not quoted`);
    const valueEnd = source.indexOf(quote, cursor + 1);
    if (valueEnd < 0) fail(`attribute "${attributeName}" is unterminated`);
    attributes[localNameOf(attributeName)] = decodeXmlText(source.slice(cursor + 1, valueEnd), path, format);
    cursor = valueEnd + 1;
  }
  return Object.freeze({
    name,
    localName: localNameOf(name),
    attributes: Object.freeze(attributes),
    selfClosing,
    depth,
  });
}

function findTagEnd(text: string, start: number, fail: () => never): number {
  let quote = '';
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return fail();
}

function localNameOf(name: string): string {
  const colon = name.indexOf(':');
  return (colon < 0 ? name : name.slice(colon + 1)).toLowerCase();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});

export function decodeXmlText(value: string, path: string, format: ModelImportFormat): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);?/g, (match, body: string) => {
    if (!match.endsWith(';')) {
      throw new MalformedModelSourceError(`${path}: unterminated XML entity`, 'invalid-syntax', format);
    }
    if (body.startsWith('#')) {
      const codePoint = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
        throw new MalformedModelSourceError(`${path}: invalid numeric XML entity`, 'invalid-syntax', format);
      }
      return String.fromCodePoint(codePoint);
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined) {
      throw new MalformedModelSourceError(`${path}: undeclared XML entity "&${body};"`, 'invalid-syntax', format);
    }
    return named;
  });
}
