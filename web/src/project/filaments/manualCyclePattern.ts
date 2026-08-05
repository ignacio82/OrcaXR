/**
 * Headless manual Cycle-pattern grammar for Snapmaker OrcaSlicer v2.3.4.
 *
 * Canonical engine behavior is pinned at commit
 * 9fd12ffb2b1b80c9fb4c14564754d2ec1573a626:
 * - `MixedFilament.cpp:1913-1970` (`normalize_manual_pattern`)
 * - `MixedFilament.cpp:632-713` (groups, tokens, and physical-ID mapping)
 * - `MixedFilamentDialog.cpp:974-997` (quick-token append behavior)
 *
 * The engine's persisted canonical syntax is compact digits for IDs 1-9 and
 * `[N]` for IDs 10-99. Its tokenizer comment also documents slash-delimited
 * token entry, while the pinned implementation accepts only the bracket form.
 * OrcaXR therefore accepts slash-delimited decimal input as an authoring
 * notation and deterministically emits the exact bracket syntax consumed by
 * the pinned engine. Commas and token order are never collapsed or averaged.
 */

export const MAX_MANUAL_CYCLE_TOOL_ID = 99;

export type ManualCyclePatternIssueCode =
  | 'empty-pattern'
  | 'empty-group'
  | 'empty-token'
  | 'unexpected-character'
  | 'unclosed-bracket'
  | 'empty-bracket-token'
  | 'non-decimal-tool-id'
  | 'zero-tool-id'
  | 'leading-zero-tool-id'
  | 'tool-id-out-of-range'
  | 'unknown-tool-id';

export interface ManualCyclePatternLocation {
  /** UTF-16 source offset, inclusive. The grammar is ASCII. */
  readonly startOffset: number;
  /** UTF-16 source offset, exclusive. */
  readonly endOffset: number;
  readonly groupIndex: number;
  readonly tokenIndex?: number;
  readonly path: string;
}

export interface ManualCyclePatternIssue {
  readonly code: ManualCyclePatternIssueCode;
  readonly message: string;
  readonly location: ManualCyclePatternLocation;
  readonly raw?: string;
  readonly toolId?: number;
}

export interface ManualCyclePatternToken {
  /** One-based physical filament ID in the transient engine namespace. */
  readonly toolId: number;
  readonly raw: string;
  /** Exact token form accepted by the pinned engine. */
  readonly canonical: string;
  readonly location: ManualCyclePatternLocation;
}

export interface ManualCyclePatternGroup {
  readonly index: number;
  readonly raw: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly tokens: readonly ManualCyclePatternToken[];
}

export interface ManualCyclePatternParseOptions {
  /**
   * Optional one-based physical IDs available to this project. When supplied,
   * every syntactically valid but absent ID produces an `unknown-tool-id`
   * issue at that exact token. Stable project IDs remain outside this wire
   * grammar and are mapped by the eventual transient engine adapter.
   */
  readonly availableToolIds?: Iterable<number>;
}

export interface ManualCyclePatternParseResult {
  readonly ok: boolean;
  /** True when the text can be encoded for the engine, even if an ID is unknown. */
  readonly syntaxValid: boolean;
  readonly input: string;
  /** Empty on malformed syntax; otherwise exact pinned-engine syntax. */
  readonly normalized: string;
  readonly groups: readonly ManualCyclePatternGroup[];
  /** Flattened IDs in exact source order; group boundaries remain in `groups`. */
  readonly sequence: readonly number[];
  readonly issues: readonly ManualCyclePatternIssue[];
}

export class ManualCyclePatternValidationError extends Error {
  constructor(readonly result: ManualCyclePatternParseResult) {
    super(
      result.issues.length === 1
        ? result.issues[0].message
        : `Manual cycle pattern has ${result.issues.length} validation issues`,
    );
    this.name = 'ManualCyclePatternValidationError';
  }
}

/** Parse, canonicalize, and optionally validate one-based physical IDs. */
export function parseManualCyclePattern(
  input: string,
  options: ManualCyclePatternParseOptions = {},
): ManualCyclePatternParseResult {
  const available = availableToolSet(options.availableToolIds);
  const issues: ManualCyclePatternIssue[] = [];
  const groups: MutableGroup[] = [];

  if (input.length === 0) {
    issues.push(makeIssue('empty-pattern', 'Enter at least one physical filament ID.', 0, 0, 0));
    return finish(input, groups, issues);
  }

  let groupStart = 0;
  let groupIndex = 0;
  for (let offset = 0; offset <= input.length; offset += 1) {
    if (offset < input.length && input[offset] !== ',') continue;
    const raw = input.slice(groupStart, offset);
    const group: MutableGroup = {
      index: groupIndex,
      raw,
      startOffset: groupStart,
      endOffset: offset,
      tokens: [],
    };
    groups.push(group);
    if (raw.length === 0) {
      const atEnd = offset === input.length;
      const start = atEnd ? Math.max(0, offset - 1) : offset;
      issues.push(
        makeIssue(
          'empty-group',
          'Each comma-separated perimeter group must contain at least one filament token.',
          start,
          atEnd ? offset : offset + 1,
          groupIndex,
        ),
      );
    } else if (raw.includes('/')) {
      parseSlashGroup(group, available, issues);
    } else {
      parseCompactGroup(group, available, issues);
    }
    groupStart = offset + 1;
    groupIndex += 1;
  }

  return finish(input, groups, issues);
}

/**
 * Engine-style normalization. Like `normalize_manual_pattern`, malformed and
 * empty input returns `''`; use `parseManualCyclePattern` when a UI needs the
 * exact reason and location.
 */
export function normalizeManualCyclePattern(input: string): string {
  return parseManualCyclePattern(input).normalized;
}

/** Parse a pattern or throw one error carrying every source-located issue. */
export function requireManualCyclePattern(
  input: string,
  options: ManualCyclePatternParseOptions = {},
): ManualCyclePatternParseResult {
  const result = parseManualCyclePattern(input, options);
  if (!result.ok) throw new ManualCyclePatternValidationError(result);
  return result;
}

/** Canonical quick-button token from the pinned dialog's append behavior. */
export function encodeManualCycleQuickToken(toolId: number): string {
  assertEncodableToolId(toolId);
  return canonicalToolToken(toolId);
}

/** Append exactly one quick-button token without rewriting prior user text. */
export function appendManualCycleQuickToken(input: string, toolId: number): string {
  return `${input}${encodeManualCycleQuickToken(toolId)}`;
}

interface MutableGroup {
  readonly index: number;
  readonly raw: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly tokens: ManualCyclePatternToken[];
}

function parseCompactGroup(
  group: MutableGroup,
  available: ReadonlySet<number> | undefined,
  issues: ManualCyclePatternIssue[],
): void {
  let localOffset = 0;
  let tokenIndex = 0;
  while (localOffset < group.raw.length) {
    const start = group.startOffset + localOffset;
    const character = sourceCharacter(group.raw, localOffset);
    if (character >= '1' && character <= '9') {
      addToken(group, character, start, start + 1, tokenIndex, available, issues);
      localOffset += 1;
      tokenIndex += 1;
      continue;
    }
    if (character === '0') {
      issues.push(
        makeIssue(
          'zero-tool-id',
          'Filament IDs are one-based; replace 0 with an ID from 1 to 99.',
          start,
          start + 1,
          group.index,
          tokenIndex,
          character,
          0,
        ),
      );
      localOffset += 1;
      tokenIndex += 1;
      continue;
    }
    if (character === '[') {
      const close = group.raw.indexOf(']', localOffset + 1);
      if (close < 0) {
        issues.push(
          makeIssue(
            'unclosed-bracket',
            'Close this multi-digit filament token with ].',
            start,
            group.endOffset,
            group.index,
            tokenIndex,
            group.raw.slice(localOffset),
          ),
        );
        break;
      }
      const raw = group.raw.slice(localOffset, close + 1);
      parseExplicitToken(raw, start, group.index, tokenIndex, available, issues, group.tokens);
      localOffset = close + 1;
      tokenIndex += 1;
      continue;
    }

    const width = character.length;
    issues.push(
      makeIssue(
        'unexpected-character',
        `Unexpected ${JSON.stringify(character)}; use digits, [N], slash separators, or commas.`,
        start,
        start + width,
        group.index,
        tokenIndex,
        character,
      ),
    );
    localOffset += width;
    tokenIndex += 1;
  }
}

function parseSlashGroup(
  group: MutableGroup,
  available: ReadonlySet<number> | undefined,
  issues: ManualCyclePatternIssue[],
): void {
  let segmentStart = 0;
  let tokenIndex = 0;
  for (let localOffset = 0; localOffset <= group.raw.length; localOffset += 1) {
    if (localOffset < group.raw.length && group.raw[localOffset] !== '/') continue;
    const raw = group.raw.slice(segmentStart, localOffset);
    if (raw.length === 0) {
      const atEnd = localOffset === group.raw.length;
      const absolute = group.startOffset + localOffset;
      const start = atEnd ? Math.max(group.startOffset, absolute - 1) : absolute;
      issues.push(
        makeIssue(
          'empty-token',
          'Each slash must separate two decimal filament IDs.',
          start,
          atEnd ? absolute : absolute + 1,
          group.index,
          tokenIndex,
        ),
      );
    } else {
      parseExplicitToken(
        raw,
        group.startOffset + segmentStart,
        group.index,
        tokenIndex,
        available,
        issues,
        group.tokens,
      );
    }
    segmentStart = localOffset + 1;
    tokenIndex += 1;
  }
}

function parseExplicitToken(
  raw: string,
  startOffset: number,
  groupIndex: number,
  tokenIndex: number,
  available: ReadonlySet<number> | undefined,
  issues: ManualCyclePatternIssue[],
  tokens: ManualCyclePatternToken[],
): void {
  const bracketed = raw.startsWith('[') && raw.endsWith(']');
  const digits = bracketed ? raw.slice(1, -1) : raw;
  const endOffset = startOffset + raw.length;
  if (bracketed && digits.length === 0) {
    issues.push(
      makeIssue(
        'empty-bracket-token',
        'Put a filament ID between [ and ].',
        startOffset,
        endOffset,
        groupIndex,
        tokenIndex,
        raw,
      ),
    );
    return;
  }
  if (!/^[0-9]+$/.test(digits)) {
    issues.push(
      makeIssue(
        'non-decimal-tool-id',
        'Filament tokens must contain only ASCII decimal digits.',
        startOffset,
        endOffset,
        groupIndex,
        tokenIndex,
        raw,
      ),
    );
    return;
  }
  if (digits.length > 1 && digits.startsWith('0')) {
    issues.push(
      makeIssue(
        'leading-zero-tool-id',
        'Filament IDs cannot contain leading zeroes.',
        startOffset,
        endOffset,
        groupIndex,
        tokenIndex,
        raw,
        Number(digits),
      ),
    );
    return;
  }
  const toolId = Number(digits);
  if (toolId === 0) {
    issues.push(
      makeIssue(
        'zero-tool-id',
        'Filament IDs are one-based; replace 0 with an ID from 1 to 99.',
        startOffset,
        endOffset,
        groupIndex,
        tokenIndex,
        raw,
        toolId,
      ),
    );
    return;
  }
  if (digits.length > 2 || toolId > MAX_MANUAL_CYCLE_TOOL_ID) {
    issues.push(
      makeIssue(
        'tool-id-out-of-range',
        `Filament ${digits} cannot be encoded; the pinned engine supports IDs 1 to 99.`,
        startOffset,
        endOffset,
        groupIndex,
        tokenIndex,
        raw,
        toolId,
      ),
    );
    return;
  }
  addParsedToken(tokens, raw, toolId, startOffset, endOffset, groupIndex, tokenIndex, available, issues);
}

function addToken(
  group: MutableGroup,
  raw: string,
  startOffset: number,
  endOffset: number,
  tokenIndex: number,
  available: ReadonlySet<number> | undefined,
  issues: ManualCyclePatternIssue[],
): void {
  addParsedToken(group.tokens, raw, Number(raw), startOffset, endOffset, group.index, tokenIndex, available, issues);
}

function addParsedToken(
  tokens: ManualCyclePatternToken[],
  raw: string,
  toolId: number,
  startOffset: number,
  endOffset: number,
  groupIndex: number,
  tokenIndex: number,
  available: ReadonlySet<number> | undefined,
  issues: ManualCyclePatternIssue[],
): void {
  const location = makeLocation(startOffset, endOffset, groupIndex, tokenIndex);
  tokens.push(
    Object.freeze({
      toolId,
      raw,
      canonical: canonicalToolToken(toolId),
      location,
    }),
  );
  if (available && !available.has(toolId)) {
    issues.push(
      Object.freeze({
        code: 'unknown-tool-id',
        message: `Filament ${toolId} is not available in this project.`,
        location,
        raw,
        toolId,
      }),
    );
  }
}

function finish(
  input: string,
  mutableGroups: readonly MutableGroup[],
  mutableIssues: readonly ManualCyclePatternIssue[],
): ManualCyclePatternParseResult {
  const issues = Object.freeze([...mutableIssues]);
  const syntaxValid = !issues.some((issue) => issue.code !== 'unknown-tool-id');
  const groups = Object.freeze(
    mutableGroups.map((group) =>
      Object.freeze({
        index: group.index,
        raw: group.raw,
        startOffset: group.startOffset,
        endOffset: group.endOffset,
        tokens: Object.freeze([...group.tokens]),
      }),
    ),
  );
  const sequence = Object.freeze(groups.flatMap((group) => group.tokens.map((token) => token.toolId)));
  const normalized = syntaxValid
    ? groups.map((group) => group.tokens.map((token) => token.canonical).join('')).join(',')
    : '';
  return Object.freeze({
    ok: syntaxValid && issues.length === 0,
    syntaxValid,
    input,
    normalized,
    groups,
    sequence,
    issues,
  });
}

function makeIssue(
  code: ManualCyclePatternIssueCode,
  message: string,
  startOffset: number,
  endOffset: number,
  groupIndex: number,
  tokenIndex?: number,
  raw?: string,
  toolId?: number,
): ManualCyclePatternIssue {
  return Object.freeze({
    code,
    message,
    location: makeLocation(startOffset, endOffset, groupIndex, tokenIndex),
    ...(raw !== undefined ? { raw } : {}),
    ...(toolId !== undefined ? { toolId } : {}),
  });
}

function makeLocation(
  startOffset: number,
  endOffset: number,
  groupIndex: number,
  tokenIndex?: number,
): ManualCyclePatternLocation {
  return Object.freeze({
    startOffset,
    endOffset,
    groupIndex,
    ...(tokenIndex !== undefined ? { tokenIndex } : {}),
    path: tokenIndex === undefined ? `groups[${groupIndex}]` : `groups[${groupIndex}].tokens[${tokenIndex}]`,
  });
}

function availableToolSet(values: Iterable<number> | undefined): ReadonlySet<number> | undefined {
  if (values === undefined) return undefined;
  const available = new Set<number>();
  for (const toolId of values) {
    assertEncodableToolId(toolId);
    available.add(toolId);
  }
  return available;
}

function assertEncodableToolId(toolId: number): void {
  if (!Number.isSafeInteger(toolId) || toolId < 1 || toolId > MAX_MANUAL_CYCLE_TOOL_ID) {
    throw new RangeError(`Manual cycle filament ID must be a safe integer from 1 to ${MAX_MANUAL_CYCLE_TOOL_ID}`);
  }
}

function canonicalToolToken(toolId: number): string {
  return toolId <= 9 ? String(toolId) : `[${toolId}]`;
}

function sourceCharacter(value: string, offset: number): string {
  return String.fromCodePoint(value.codePointAt(offset)!);
}
