import assert from 'node:assert/strict';

import {
  MAX_MANUAL_CYCLE_TOOL_ID,
  ManualCyclePatternValidationError,
  appendManualCycleQuickToken,
  encodeManualCycleQuickToken,
  normalizeManualCyclePattern,
  parseManualCyclePattern,
  requireManualCyclePattern,
  type ManualCyclePatternIssueCode,
} from '../manualCyclePattern';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('matches the pinned normalize_manual_pattern acceptance and rejection corpus', () => {
  // Exact cases from Snapmaker Orca v2.3.4 commit 9fd12ff, file
  // tests/libslic3r/test_mixed_filament.cpp:725-771.
  const accepted: ReadonlyArray<readonly [string, string]> = [
    ['', ''],
    ['1', '1'],
    ['123456789', '123456789'],
    ['[10]', '[10]'],
    ['[1]', '1'],
    ['[2]', '2'],
    ['[99]', '[99]'],
    ['[11]', '[11]'],
    ['1[10],[11]2', '1[10],[11]2'],
    ['12,21', '12,21'],
  ];
  for (const [input, expected] of accepted) {
    assert.equal(normalizeManualCyclePattern(input), expected, input);
  }

  const rejected = [
    '[100]',
    '[123]',
    '[9999]',
    '0',
    '[0]',
    '[01]',
    '[00]',
    '[',
    ']',
    '[]',
    '[1',
    '1]',
    '1,',
    ',1',
    '1,,2',
    ',',
    'a',
    '(1)',
    ' ',
    '[1a]',
  ];
  for (const input of rejected) assert.equal(normalizeManualCyclePattern(input), '', input);
});

test('accepts explicit slash notation and preserves every group and sequence token', () => {
  const result = requireManualCyclePattern('1/10/2,12/3', {
    availableToolIds: [1, 2, 3, 10, 12],
  });
  assert.equal(result.normalized, '1[10]2,[12]3');
  assert.deepEqual(result.sequence, [1, 10, 2, 12, 3]);
  assert.deepEqual(
    result.groups.map((group) => group.tokens.map((token) => token.toolId)),
    [
      [1, 10, 2],
      [12, 3],
    ],
  );
  assert.deepEqual(
    result.groups.flatMap((group) =>
      group.tokens.map((token) => [token.location.startOffset, token.location.endOffset]),
    ),
    [
      [0, 1],
      [2, 4],
      [5, 6],
      [7, 9],
      [10, 11],
    ],
  );

  const reparsed = requireManualCyclePattern(result.normalized, {
    availableToolIds: [1, 2, 3, 10, 12],
  });
  assert.equal(reparsed.normalized, result.normalized);
  assert.deepEqual(reparsed.sequence, result.sequence);
  assert.deepEqual(
    reparsed.groups.map((group) => group.tokens.map((token) => token.toolId)),
    result.groups.map((group) => group.tokens.map((token) => token.toolId)),
  );

  assert.equal(normalizeManualCyclePattern('1/2'), '12');
  assert.equal(normalizeManualCyclePattern('10/11'), '[10][11]');
  assert.equal(normalizeManualCyclePattern('[10]/2'), '[10]2');
  assert.equal(normalizeManualCyclePattern('12'), '12'); // legacy IDs 1 then 2, never ID 12
  assert.equal(normalizeManualCyclePattern('10'), ''); // legacy 1 then forbidden 0
});

test('reports every unknown physical ID at an exact token location without losing syntax', () => {
  const result = parseManualCyclePattern('1/7/2,10/99', { availableToolIds: [1, 2, 10] });
  assert.equal(result.ok, false);
  assert.equal(result.syntaxValid, true);
  assert.equal(result.normalized, '172,[10][99]');
  assert.deepEqual(result.sequence, [1, 7, 2, 10, 99]);
  assert.deepEqual(
    result.issues.map((issue) => ({
      code: issue.code,
      toolId: issue.toolId,
      start: issue.location.startOffset,
      end: issue.location.endOffset,
      path: issue.location.path,
    })),
    [
      { code: 'unknown-tool-id', toolId: 7, start: 2, end: 3, path: 'groups[0].tokens[1]' },
      { code: 'unknown-tool-id', toolId: 99, start: 9, end: 11, path: 'groups[1].tokens[1]' },
    ],
  );
  assert.throws(
    () => requireManualCyclePattern('1/7/2,10/99', { availableToolIds: [1, 2, 10] }),
    (error: unknown) => {
      assert.ok(error instanceof ManualCyclePatternValidationError);
      assert.deepEqual(
        error.result.issues.map((issue) => issue.toolId),
        [7, 99],
      );
      return true;
    },
  );
});

test('pinpoints malformed groups, brackets, decimal tokens, and slash separators', () => {
  const cases: ReadonlyArray<readonly [string, ManualCyclePatternIssueCode, number, number, string]> = [
    [',1', 'empty-group', 0, 1, 'groups[0]'],
    ['1,', 'empty-group', 1, 2, 'groups[1]'],
    ['1,,2', 'empty-group', 2, 3, 'groups[1]'],
    ['/1', 'empty-token', 0, 1, 'groups[0].tokens[0]'],
    ['1/', 'empty-token', 1, 2, 'groups[0].tokens[1]'],
    ['1//2', 'empty-token', 2, 3, 'groups[0].tokens[1]'],
    ['[]', 'empty-bracket-token', 0, 2, 'groups[0].tokens[0]'],
    ['[1a]', 'non-decimal-tool-id', 0, 4, 'groups[0].tokens[0]'],
    ['[1', 'unclosed-bracket', 0, 2, 'groups[0].tokens[0]'],
    ['1]', 'unexpected-character', 1, 2, 'groups[0].tokens[1]'],
    ['0', 'zero-tool-id', 0, 1, 'groups[0].tokens[0]'],
    ['[01]', 'leading-zero-tool-id', 0, 4, 'groups[0].tokens[0]'],
    ['[100]', 'tool-id-out-of-range', 0, 5, 'groups[0].tokens[0]'],
    ['01/2', 'leading-zero-tool-id', 0, 2, 'groups[0].tokens[0]'],
    ['100/2', 'tool-id-out-of-range', 0, 3, 'groups[0].tokens[0]'],
    ['1/a', 'non-decimal-tool-id', 2, 3, 'groups[0].tokens[1]'],
    ['1 2', 'unexpected-character', 1, 2, 'groups[0].tokens[1]'],
  ];

  for (const [input, code, start, end, path] of cases) {
    const result = parseManualCyclePattern(input);
    assert.equal(result.ok, false, input);
    assert.equal(result.syntaxValid, false, input);
    assert.equal(result.normalized, '', input);
    const issue = result.issues.find((candidate) => candidate.code === code);
    assert.ok(issue, `${input}: missing ${code}`);
    assert.deepEqual(
      [issue.location.startOffset, issue.location.endOffset, issue.location.path],
      [start, end, path],
      input,
    );
    assert.ok(issue.message.length > 10, `${input}: issue should be actionable`);
  }
});

test('exhaustively round-trips all encodable IDs and every slash-delimited pair', () => {
  const available = Array.from({ length: MAX_MANUAL_CYCLE_TOOL_ID }, (_, index) => index + 1);
  for (const toolId of available) {
    const canonical = toolId <= 9 ? String(toolId) : `[${toolId}]`;
    assert.equal(encodeManualCycleQuickToken(toolId), canonical);
    const parsed = requireManualCyclePattern(canonical, { availableToolIds: available });
    assert.deepEqual(parsed.sequence, [toolId]);
    assert.equal(parsed.normalized, canonical);
  }

  for (const left of available) {
    for (const right of available) {
      const parsed = requireManualCyclePattern(`${left}/${right}`, { availableToolIds: available });
      assert.deepEqual(parsed.sequence, [left, right]);
      const canonical = `${encodeManualCycleQuickToken(left)}${encodeManualCycleQuickToken(right)}`;
      assert.equal(parsed.normalized, canonical);
      assert.deepEqual(requireManualCyclePattern(canonical, { availableToolIds: available }).sequence, [left, right]);
    }
  }
});

test('mirrors quick-button append tokens and rejects unencodable API inputs', () => {
  assert.equal(appendManualCycleQuickToken('', 1), '1');
  assert.equal(appendManualCycleQuickToken('12', 3), '123');
  assert.equal(appendManualCycleQuickToken('12', 10), '12[10]');
  assert.equal(appendManualCycleQuickToken('1,', 99), '1,[99]');
  for (const invalid of [0, 100, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => encodeManualCycleQuickToken(invalid), RangeError);
  }
  assert.throws(() => parseManualCyclePattern('12', { availableToolIds: [0, 1, 2] }), RangeError);
  assert.throws(() => parseManualCyclePattern('12', { availableToolIds: [1, 100] }), RangeError);
});

console.log(`\nManual Cycle-pattern parser: ${passed} tests passed.`);
