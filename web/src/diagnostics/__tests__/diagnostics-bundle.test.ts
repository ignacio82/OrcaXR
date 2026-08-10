import assert from 'node:assert/strict';

import {
  DiagnosticsRecorder,
  MAX_LOG_ENTRIES,
  buildDiagnosticsBundle,
  describeDiagnosticsBundle,
  serializeDiagnosticsBundle,
  type DiagnosticsInput,
} from '../DiagnosticsBundle';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    appVersion: '1.2.3',
    engine: { commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626', route: 'browser-wasm' },
    browser: { userAgent: 'Chrome/150', language: 'en-GB', hardwareConcurrency: 8, crossOriginIsolated: true },
    capabilities: { actionCount: 152, unavailableCount: 34 },
    log: [],
    ...overrides,
  };
}

test('the bundle records what a support case actually needs', () => {
  const bundle = buildDiagnosticsBundle(
    input({
      xr: { supported: true, sessionActive: false },
      printer: { configured: true, connected: true, capabilities: ['print', 'pause'], jobState: 'printing' },
      performance: { usedHeapMb: 412, totalHeapMb: 2048, uptimeSeconds: 900 },
    }),
  );
  assert.equal(bundle.format, 'orcaxr.diagnostics');
  assert.equal(bundle.appVersion, '1.2.3');
  assert.equal(bundle.engine.route, 'browser-wasm');
  assert.equal(bundle.printer?.jobState, 'printing');
  assert.equal(bundle.capabilities.actionCount, 152);
  assert.equal(bundle.performance?.usedHeapMb, 412);
});

/**
 * The acceptance criterion: known secret and PII patterns must be provably
 * absent from the file that leaves the machine.
 */
test('tokens, keys, and addresses never reach the exported file', () => {
  const recorder = new DiagnosticsRecorder();
  recorder.setSecrets(['TFEopAuNzkX7EZfBnTao9s4JlwmyDHCHmiLs0aOo']);
  recorder.record('error', 'slicer', 'POST http://192.168.1.228:3000/slice failed');
  recorder.record('error', 'printer', 'Authorization: Bearer TFEopAuNzkX7EZfBnTao9s4JlwmyDHCHmiLs0aOo rejected');
  recorder.record('info', 'printer', 'connected', {
    endpoint: 'https://printer.tailnet.ts.net',
    apiKey: 'abcd-1234-secret',
    nested: { access_token: 'zzzz' },
  });

  const serialized = serializeDiagnosticsBundle(
    buildDiagnosticsBundle(
      input({
        log: recorder.snapshot(),
        printer: { configured: true, connected: true },
      }),
    ),
  );

  for (const forbidden of [
    'TFEopAuNzkX7EZfBnTao9s4JlwmyDHCHmiLs0aOo',
    '192.168.1.228',
    'printer.tailnet.ts.net',
    'abcd-1234-secret',
    'zzzz',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not survive into the bundle`);
  }
  // And the entry still says something useful about what went wrong.
  assert.match(serialized, /redacted-url/);
  assert.match(serialized, /failed/);
});

test('model names are withheld unless explicitly asked for', () => {
  const project = {
    plateCount: 1,
    objectCount: 2,
    volumeCount: 3,
    triangleCount: 12_345,
    physicalFilamentCount: 4,
    mixedFilamentCount: 0,
    paintedVolumeCount: 1,
    objectNames: ['Anniversary gift for Sam', 'prototype-v7'],
  };

  const withheld = buildDiagnosticsBundle(input({ project }));
  assert.equal(withheld.project?.objectNames, undefined, 'a model name is the most identifying thing here');
  assert.equal(withheld.project?.triangleCount, 12_345, 'but the shape of the project still travels');
  assert.equal(serializeDiagnosticsBundle(withheld).includes('Anniversary'), false);
  assert.match(withheld.omitted.join(' '), /model and object names/);

  const opted = buildDiagnosticsBundle(input({ project }), { includeModelNames: true });
  assert.deepEqual(opted.project?.objectNames, ['Anniversary gift for Sam', 'prototype-v7']);
  assert.equal(opted.omitted.join(' ').includes('model and object names'), false, 'and the list stays truthful');
});

test('the log is bounded and keeps the end of the session', () => {
  const recorder = new DiagnosticsRecorder();
  for (let index = 0; index < MAX_LOG_ENTRIES + 50; index += 1) recorder.record('info', 'test', `entry ${index}`);
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.length, MAX_LOG_ENTRIES);
  // A crash is usually near the end, so the oldest entries are the ones to drop.
  assert.match(snapshot[snapshot.length - 1].message, /entry 249/);
  assert.equal(
    snapshot.some((entry) => entry.message === 'entry 0'),
    false,
  );
});

test('an injected failure is diagnosable from the bundle alone', () => {
  const recorder = new DiagnosticsRecorder();
  recorder.record('info', 'slice', 'starting plate 1');
  try {
    throw new RangeError('Invalid array length');
  } catch (error) {
    recorder.recordError('slice', error);
  }
  const bundle = buildDiagnosticsBundle(input({ log: recorder.snapshot() }));
  const failure = bundle.log.find((entry) => entry.level === 'error');
  assert.ok(failure, 'the failure is present');
  assert.match(failure.message, /RangeError: Invalid array length/);
  assert.equal(failure.scope, 'slice');
  // Ordering matters for reading a session back: context, then the failure.
  assert.equal(bundle.log[0].message, 'starting plate 1');
});

test('the preview describes the same object that is written', () => {
  const bundle = buildDiagnosticsBundle(
    input({
      printer: { configured: true, connected: false },
      project: {
        plateCount: 2,
        objectCount: 5,
        volumeCount: 7,
        triangleCount: 900,
        physicalFilamentCount: 4,
        mixedFilamentCount: 2,
        paintedVolumeCount: 3,
        objectNames: ['a'],
      },
    }),
  );
  const description = describeDiagnosticsBundle(bundle);
  // Every number quoted in the preview comes from the bundle itself, so the
  // two cannot drift into disagreeing about what is being sent.
  assert.match(description, /OrcaXR 1\.2\.3/);
  assert.match(description, /2 plate\(s\), 5 object\(s\), 900 triangles/);
  assert.match(description, /configured, offline/);
  assert.match(description, /Left out: .*addresses/);
  assert.equal(description.includes('including'), false, 'names were not opted into, so none are announced');
});

test('a recorder with no secrets set still strips pattern-matched ones', () => {
  const recorder = new DiagnosticsRecorder();
  recorder.record('error', 'net', 'x-api-key: hunter2hunter2 was refused by https://host.example');
  const [entry] = recorder.snapshot();
  assert.equal(entry.message.includes('hunter2hunter2'), false);
  assert.equal(entry.message.includes('host.example'), false);
});

console.log(`\nDiagnostics bundle: ${passed} tests passed.`);
