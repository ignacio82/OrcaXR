/**
 * The message syntax translators write in, and how it is rendered (P10.4).
 *
 * This is a deliberately small subset of ICU MessageFormat: interpolation,
 * `plural`, `select`, and the three formatters a slicer actually needs
 * (`number`, `unit`, `date`). Small because every construct here is one a
 * translator has to understand and one this code has to get right in twenty
 * languages, and because the alternative — pulling in a full ICU
 * implementation — is a large dependency for a feature whose hard part is
 * organisational, not syntactic.
 *
 * Three properties are load-bearing.
 *
 * **Plural is `Intl.PluralRules`, never `count === 1`.** Russian has three
 * plural categories and Polish four; a hand-rolled English rule renders
 * grammatically wrong text in a way an English-speaking reviewer cannot see.
 *
 * **A malformed message renders as itself, and says so.** Translations arrive
 * from twenty different people; one unbalanced brace must show the operator
 * something rather than throw inside a render and take a panel down with it.
 * The problem is reported through `onProblem` so a test can be strict where the
 * UI cannot afford to be.
 *
 * **Formatting never reaches serialization.** Everything here is locale-
 * dependent by construction, which is exactly what a saved project must not be.
 * `src/project/` may not import this module, and the architecture check
 * enforces that rather than trusting it.
 */

export type MessageValue = string | number | boolean | Date | null | undefined;
export type MessageValues = Readonly<Record<string, MessageValue>>;

export interface FormatProblem {
  readonly code: 'syntax' | 'missing-argument' | 'unknown-format' | 'no-plural-branch';
  readonly message: string;
  /** The message id, when the caller knows it. */
  readonly id?: string;
}

export interface FormatOptions {
  readonly locale: string;
  readonly values?: MessageValues;
  readonly id?: string;
  readonly onProblem?: (problem: FormatProblem) => void;
}

type Node =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'argument'; readonly name: string }
  | { readonly kind: 'number'; readonly name: string; readonly style?: string }
  | { readonly kind: 'unit'; readonly name: string; readonly unit: string }
  | { readonly kind: 'date'; readonly name: string; readonly style: string }
  | { readonly kind: 'time'; readonly name: string; readonly style: string }
  | {
      readonly kind: 'plural';
      readonly name: string;
      readonly offset: number;
      readonly branches: ReadonlyMap<string, readonly Node[]>;
    }
  | { readonly kind: 'select'; readonly name: string; readonly branches: ReadonlyMap<string, readonly Node[]> };

class ParseError extends Error {}

/**
 * Parsed messages are cached by text, not by id: two ids may share a message,
 * and a message is re-rendered on every state change of the panel that shows
 * it. Keyed by the raw text so a locale switch cannot serve a stale parse.
 */
const PARSE_CACHE = new Map<string, readonly Node[] | 'invalid'>();
const PARSE_CACHE_LIMIT = 4096;

const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>();
const DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();
const PLURAL_RULES = new Map<string, Intl.PluralRules>();

/** Render one message. Never throws: a message that cannot be parsed is returned verbatim. */
export function formatMessage(message: string, options: FormatOptions): string {
  const nodes = parseCached(message, options);
  if (nodes === 'invalid') return message;
  return render(nodes, options);
}

/**
 * The argument names a message requires. Used by the catalogue check to refuse
 * a translation that dropped a placeholder — a translated string that silently
 * loses `{count}` is how a dialog ends up saying "objects will be deleted".
 */
export function messageArguments(message: string): readonly string[] {
  const names = new Set<string>();
  let nodes: readonly Node[];
  try {
    nodes = parse(message);
  } catch {
    return Object.freeze([]);
  }
  const walk = (list: readonly Node[]): void => {
    for (const node of list) {
      if (node.kind === 'text') continue;
      names.add(node.name);
      if (node.kind === 'plural' || node.kind === 'select') {
        for (const branch of node.branches.values()) walk(branch);
      }
    }
  };
  walk(nodes);
  return Object.freeze([...names].sort());
}

/** True when the message parses. Used by the catalogue gate. */
export function isValidMessage(message: string): boolean {
  try {
    parse(message);
    return true;
  } catch {
    return false;
  }
}

function parseCached(message: string, options: FormatOptions): readonly Node[] | 'invalid' {
  const cached = PARSE_CACHE.get(message);
  if (cached !== undefined) {
    if (cached === 'invalid') {
      options.onProblem?.({ code: 'syntax', message: `Message does not parse: ${message}`, id: options.id });
    }
    return cached;
  }
  let parsed: readonly Node[] | 'invalid';
  try {
    parsed = parse(message);
  } catch (error) {
    parsed = 'invalid';
    options.onProblem?.({
      code: 'syntax',
      message: error instanceof Error ? error.message : `Message does not parse: ${message}`,
      id: options.id,
    });
  }
  if (PARSE_CACHE.size >= PARSE_CACHE_LIMIT) PARSE_CACHE.clear();
  PARSE_CACHE.set(message, parsed);
  return parsed;
}

// ---- parsing ---------------------------------------------------------

function parse(message: string): readonly Node[] {
  const state = { text: message, index: 0 };
  const nodes = parseNodes(state, false);
  if (state.index < message.length) throw new ParseError(`Unexpected "}" at ${state.index}`);
  return nodes;
}

interface Cursor {
  readonly text: string;
  index: number;
}

function parseNodes(state: Cursor, nested: boolean): readonly Node[] {
  const nodes: Node[] = [];
  let buffer = '';
  while (state.index < state.text.length) {
    const char = state.text[state.index];
    if (char === "'" && state.text[state.index + 1] === "'") {
      // ICU's escape for a literal apostrophe.
      buffer += "'";
      state.index += 2;
      continue;
    }
    if (char === "'" && (state.text[state.index + 1] === '{' || state.text[state.index + 1] === '}')) {
      // ICU quoting: a `'` before a brace opens a quoted run that ends at the
      // next lone `'` or at the end of the message. Handling only the single
      // brace would leave the run's closing brace to be read as syntax.
      state.index += 1;
      while (state.index < state.text.length) {
        if (state.text[state.index] === "'") {
          if (state.text[state.index + 1] === "'") {
            buffer += "'";
            state.index += 2;
            continue;
          }
          state.index += 1;
          break;
        }
        buffer += state.text[state.index];
        state.index += 1;
      }
      continue;
    }
    if (char === '}') {
      if (!nested) throw new ParseError(`Unmatched "}" at ${state.index}`);
      break;
    }
    if (char === '{') {
      if (buffer) {
        nodes.push({ kind: 'text', value: buffer });
        buffer = '';
      }
      nodes.push(parsePlaceholder(state));
      continue;
    }
    buffer += char;
    state.index += 1;
  }
  if (buffer) nodes.push({ kind: 'text', value: buffer });
  return nodes;
}

function parsePlaceholder(state: Cursor): Node {
  state.index += 1; // consume '{'
  const name = readUntil(state, [',', '}']).trim();
  if (!name) throw new ParseError(`Placeholder without a name at ${state.index}`);
  if (state.text[state.index] === '}') {
    state.index += 1;
    return { kind: 'argument', name };
  }
  state.index += 1; // consume ','
  const type = readUntil(state, [',', '}']).trim();
  if (state.text[state.index] === '}') {
    state.index += 1;
    if (type === 'number') return { kind: 'number', name };
    throw new ParseError(`Placeholder "${name}" has type "${type}" but no argument`);
  }
  state.index += 1; // consume ','
  if (type === 'number') {
    const style = readUntil(state, ['}']).trim();
    expect(state, '}');
    return { kind: 'number', name, style };
  }
  if (type === 'unit') {
    const unit = readUntil(state, ['}']).trim();
    expect(state, '}');
    if (!unit) throw new ParseError(`Unit placeholder "${name}" names no unit`);
    return { kind: 'unit', name, unit };
  }
  if (type === 'date' || type === 'time') {
    const style = readUntil(state, ['}']).trim() || 'medium';
    expect(state, '}');
    return { kind: type, name, style };
  }
  if (type === 'plural' || type === 'selectordinal' || type === 'select') {
    const { branches, offset } = parseBranches(state, type !== 'select');
    expect(state, '}');
    if (type === 'select') return { kind: 'select', name, branches };
    return { kind: 'plural', name, offset, branches };
  }
  throw new ParseError(`Unknown placeholder type "${type}" for "${name}"`);
}

function parseBranches(
  state: Cursor,
  allowOffset: boolean,
): { branches: ReadonlyMap<string, readonly Node[]>; offset: number } {
  const branches = new Map<string, readonly Node[]>();
  let offset = 0;
  for (;;) {
    skipSpace(state);
    if (state.index >= state.text.length) throw new ParseError('Unterminated branch list');
    if (state.text[state.index] === '}') break;
    let key = readUntil(state, ['{', '}']).trim();
    if (!key) throw new ParseError('Branch without a key');
    // `offset:N` is not a branch — it sits in front of the first one, so it
    // arrives here glued to that branch's key and has to be split back off.
    if (allowOffset && key.startsWith('offset:')) {
      const [head, ...rest] = key.split(/\s+/);
      const parsed = Number.parseInt(head.slice('offset:'.length), 10);
      if (!Number.isFinite(parsed)) throw new ParseError(`Bad plural offset "${head}"`);
      offset = parsed;
      key = rest.join(' ').trim();
      if (!key) {
        // `offset:1` on its own line; the next read picks up the first branch.
        continue;
      }
    }
    if (/\s/.test(key)) throw new ParseError(`Branch key "${key}" contains whitespace`);
    expect(state, '{');
    branches.set(key, parseNodes(state, true));
    expect(state, '}');
  }
  if (branches.size === 0) throw new ParseError('Branch list is empty');
  return { branches, offset };
}

function readUntil(state: Cursor, stops: readonly string[]): string {
  const start = state.index;
  while (state.index < state.text.length && !stops.includes(state.text[state.index])) state.index += 1;
  if (state.index >= state.text.length) throw new ParseError(`Expected one of ${stops.join('')} before the end`);
  return state.text.slice(start, state.index);
}

function expect(state: Cursor, char: string): void {
  if (state.text[state.index] !== char) throw new ParseError(`Expected "${char}" at ${state.index}`);
  state.index += 1;
}

function skipSpace(state: Cursor): void {
  while (state.index < state.text.length && /\s/.test(state.text[state.index])) state.index += 1;
}

// ---- rendering -------------------------------------------------------

function render(nodes: readonly Node[], options: FormatOptions): string {
  let out = '';
  for (const node of nodes) out += renderNode(node, options);
  return out;
}

function renderNode(node: Node, options: FormatOptions): string {
  if (node.kind === 'text') return node.value;
  const values = options.values ?? {};
  const raw = Object.prototype.hasOwnProperty.call(values, node.name) ? values[node.name] : undefined;
  if (raw === undefined || raw === null) {
    options.onProblem?.({
      code: 'missing-argument',
      message: `Message needs "${node.name}"`,
      id: options.id,
    });
    // The name, in braces, rather than an empty gap: an operator who reports
    // "it says {count}" has told us which message and which argument.
    return `{${node.name}}`;
  }

  switch (node.kind) {
    case 'argument':
      return raw instanceof Date ? formatDate(raw, 'medium', options.locale) : String(raw);
    case 'number':
      return numberFormat(options.locale, node.style).format(toNumber(raw));
    case 'unit':
      return unitFormat(options.locale, node.unit).format(toNumber(raw));
    case 'date':
      return formatDate(toDate(raw), node.style, options.locale);
    case 'time':
      return formatTime(toDate(raw), node.style, options.locale);
    case 'select': {
      const branch = node.branches.get(String(raw)) ?? node.branches.get('other');
      if (!branch) {
        options.onProblem?.({
          code: 'no-plural-branch',
          message: `No branch for "${String(raw)}" and no "other"`,
          id: options.id,
        });
        return String(raw);
      }
      return render(branch, options);
    }
    case 'plural': {
      const value = toNumber(raw);
      const adjusted = value - node.offset;
      const exact = node.branches.get(`=${value}`);
      if (exact) return render(exact, options).replaceAll('#', formatPluralNumber(adjusted, options.locale));
      const category = pluralRules(options.locale).select(adjusted);
      const branch = node.branches.get(category) ?? node.branches.get('other');
      if (!branch) {
        options.onProblem?.({
          code: 'no-plural-branch',
          message: `No "${category}" branch and no "other"`,
          id: options.id,
        });
        return String(raw);
      }
      return render(branch, options).replaceAll('#', formatPluralNumber(adjusted, options.locale));
    }
  }
}

function formatPluralNumber(value: number, locale: string): string {
  return numberFormat(locale, undefined).format(value);
}

function toNumber(value: MessageValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toDate(value: MessageValue): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  return new Date(String(value));
}

/**
 * `style` is a small named set rather than arbitrary options, because the
 * caller supplying options would put presentation decisions in twenty
 * translated files where nobody reviews them.
 */
function numberFormat(locale: string, style: string | undefined): Intl.NumberFormat {
  const key = `${locale} n ${style ?? ''}`;
  const cached = NUMBER_FORMATS.get(key);
  if (cached) return cached;
  const options: Intl.NumberFormatOptions = {};
  switch (style) {
    case 'integer':
      options.maximumFractionDigits = 0;
      break;
    case 'percent':
      options.style = 'percent';
      break;
    case 'precise':
      options.minimumFractionDigits = 2;
      options.maximumFractionDigits = 2;
      break;
    case 'compact':
      options.notation = 'compact';
      break;
    default:
      // Millimetres and rates read wrong with more than two decimals and wrong
      // with a hard two, so the default is "up to two".
      options.maximumFractionDigits = 2;
      break;
  }
  const format = new Intl.NumberFormat(locale, options);
  NUMBER_FORMATS.set(key, format);
  return format;
}

function unitFormat(locale: string, unit: string): Intl.NumberFormat {
  const key = `${locale} u ${unit}`;
  const cached = NUMBER_FORMATS.get(key);
  if (cached) return cached;
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: 2,
    });
  } catch {
    // An unsupported unit must not take the panel down. The number still
    // renders; the unit is appended verbatim so nothing is lost silently.
    format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  }
  NUMBER_FORMATS.set(key, format);
  return format;
}

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions, key: string): Intl.DateTimeFormat {
  const cacheKey = `${locale} ${key}`;
  const cached = DATE_FORMATS.get(cacheKey);
  if (cached) return cached;
  const format = new Intl.DateTimeFormat(locale, options);
  DATE_FORMATS.set(cacheKey, format);
  return format;
}

function formatDate(value: Date, style: string, locale: string): string {
  const dateStyle = (['full', 'long', 'medium', 'short'].includes(style) ? style : 'medium') as 'medium';
  return dateFormat(locale, { dateStyle }, `d:${dateStyle}`).format(value);
}

function formatTime(value: Date, style: string, locale: string): string {
  const timeStyle = (['full', 'long', 'medium', 'short'].includes(style) ? style : 'medium') as 'medium';
  return dateFormat(locale, { timeStyle }, `t:${timeStyle}`).format(value);
}

function pluralRules(locale: string): Intl.PluralRules {
  const cached = PLURAL_RULES.get(locale);
  if (cached) return cached;
  const rules = new Intl.PluralRules(locale);
  PLURAL_RULES.set(locale, rules);
  return rules;
}

/** Test seam: formatter caches are global, and a locale-stub test must reset them. */
export function resetFormatCaches(): void {
  PARSE_CACHE.clear();
  NUMBER_FORMATS.clear();
  DATE_FORMATS.clear();
  PLURAL_RULES.clear();
}
