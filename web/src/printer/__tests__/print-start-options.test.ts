/**
 * Pre-print option tests (run: npx tsx print-start-options.test.ts).
 *
 * The point of these is that the app never claims a capability the printer did
 * not report, never runs a command the printer did not name, and never
 * confuses "this machine cannot" with "nobody asked it yet".
 */
import assert from 'node:assert';
import {
  PRINTER_GCODE_HELP_PATH,
  PRINTER_OBJECTS_PATH,
  SERVER_INFO_PATH,
  TIMELAPSE_SETTINGS_PATH,
  applyPrintStartOptions,
  assessPrintStartOptions,
  parseGcodeCommands,
  parsePrinterObjects,
  parseServerComponents,
  queryPrintStartOptions,
  PrintStartOptionError,
  type PrintStartOption,
} from '../PrintStartOptions';

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  const result = fn();
  if (result instanceof Promise) {
    pending.push(
      result.then(() => {
        passed++;
        console.log('  ✓', name);
      }),
    );
    return;
  }
  passed++;
  console.log('  ✓', name);
}
const pending: Promise<void>[] = [];

const option = (options: readonly PrintStartOption[], id: string) => options.find((o) => o.id === id)!;

// ---- assessment -----------------------------------------------------------

test('an unqueried printer is unknown, not incapable', () => {
  const options = assessPrintStartOptions({});
  for (const entry of options) {
    assert.equal(entry.available, false, `${entry.id} must not be offered before the printer answers`);
    assert.match(entry.reason, /Connect the printer/, `${entry.id} must say why it cannot tell`);
  }
});

test('a bed_mesh section offers levelling and names the command it will run', () => {
  const options = assessPrintStartOptions({ objects: ['bed_mesh', 'extruder', 'toolhead'] });
  const leveling = option(options, 'bed-leveling');
  assert.equal(leveling.available, true);
  assert.equal(leveling.command, 'BED_MESH_CALIBRATE');
  assert.match(leveling.detail, /BED_MESH_CALIBRATE/);
});

test('a printer that only reports G29 runs G29, not the command it never named', () => {
  const options = assessPrintStartOptions({ objects: ['toolhead'], commands: ['G28', 'G29'] });
  const leveling = option(options, 'bed-leveling');
  assert.equal(leveling.available, true);
  assert.equal(leveling.command, 'G29');
});

test('a printer with neither a mesh nor a command is refused in its own terms', () => {
  const options = assessPrintStartOptions({ objects: ['toolhead', 'extruder'], commands: ['G28'] });
  const leveling = option(options, 'bed-leveling');
  assert.equal(leveling.available, false);
  assert.match(leveling.reason, /reports no bed_mesh/);
  assert.equal(leveling.command, undefined);
});

test('timelapse follows the component list, both ways', () => {
  const without = option(assessPrintStartOptions({ components: ['file_manager', 'klippy_apis'] }), 'timelapse');
  assert.equal(without.available, false);
  assert.match(without.reason, /no timelapse component/);
  const with_ = option(assessPrintStartOptions({ components: ['file_manager', 'timelapse'] }), 'timelapse');
  assert.equal(with_.available, true);
});

test('one query answering does not decide the other', () => {
  // Objects answered, components did not: levelling is decided, timelapse is not.
  const options = assessPrintStartOptions({ objects: ['bed_mesh'] });
  assert.equal(option(options, 'bed-leveling').available, true);
  assert.equal(option(options, 'timelapse').available, false);
  assert.match(option(options, 'timelapse').reason, /Connect the printer/);
});

test('nothing is ticked by default: a send does what was asked and no more', () => {
  for (const entry of assessPrintStartOptions({ objects: ['bed_mesh'], components: ['timelapse'] })) {
    assert.equal(entry.defaultEnabled, false, `${entry.id} must not opt the operator in`);
  }
});

// ---- parsing --------------------------------------------------------------

test('malformed payloads read as unknown rather than as empty', () => {
  for (const payload of [null, undefined, 42, 'nope', {}, { result: {} }, { result: { objects: 'no' } }]) {
    assert.equal(parsePrinterObjects(payload), undefined);
  }
  assert.deepEqual([...(parsePrinterObjects({ result: { objects: ['bed_mesh', 7] } }) ?? [])], ['bed_mesh']);
  assert.equal(parseServerComponents({ result: { components: null } }), undefined);
  assert.deepEqual([...(parseServerComponents({ result: { components: ['timelapse'] } }) ?? [])], ['timelapse']);
  assert.equal(parseGcodeCommands({ result: [] }), undefined);
  assert.deepEqual([...(parseGcodeCommands({ result: { G29: 'level', G28: 'home' } }) ?? [])], ['G29', 'G28']);
});

// ---- querying -------------------------------------------------------------

test('a query reads the real Moonraker endpoints', async () => {
  const seen: string[] = [];
  const transport = {
    async request<T>(path: string): Promise<T> {
      seen.push(path);
      if (path === PRINTER_OBJECTS_PATH) return { result: { objects: ['bed_mesh'] } } as T;
      if (path === PRINTER_GCODE_HELP_PATH) return { result: { BED_MESH_CALIBRATE: 'probe' } } as T;
      if (path === SERVER_INFO_PATH) return { result: { components: ['timelapse'] } } as T;
      throw new Error(`unexpected ${path}`);
    },
  };
  const options = await queryPrintStartOptions(transport);
  assert.deepEqual(seen.sort(), [PRINTER_GCODE_HELP_PATH, PRINTER_OBJECTS_PATH, SERVER_INFO_PATH].sort());
  assert.equal(option(options, 'bed-leveling').available, true);
  assert.equal(option(options, 'timelapse').available, true);
});

test('one endpoint failing leaves that capability unknown and the others intact', async () => {
  const transport = {
    async request<T>(path: string): Promise<T> {
      if (path === SERVER_INFO_PATH) throw new Error('404');
      if (path === PRINTER_OBJECTS_PATH) return { result: { objects: ['bed_mesh'] } } as T;
      return { result: {} } as T;
    },
  };
  const options = await queryPrintStartOptions(transport);
  assert.equal(option(options, 'bed-leveling').available, true);
  assert.equal(option(options, 'timelapse').available, false);
  assert.match(option(options, 'timelapse').reason, /Connect the printer/);
});

// ---- applying -------------------------------------------------------------

test('choosing both writes the setting first and waits for the probe last', async () => {
  const calls: { path: string; method?: string; timeoutMs?: number | null }[] = [];
  const transport = {
    async request<T>(path: string, options?: { method?: string; timeoutMs?: number | null }): Promise<T> {
      calls.push({
        path,
        ...(options?.method ? { method: options.method } : {}),
        ...(options && 'timeoutMs' in options ? { timeoutMs: options.timeoutMs } : {}),
      });
      return {} as T;
    },
  };
  const phases: string[] = [];
  await applyPrintStartOptions(transport, {
    options: assessPrintStartOptions({ objects: ['bed_mesh'], components: ['timelapse'] }),
    enabled: ['bed-leveling', 'timelapse'],
    onPhase: (phase) => phases.push(phase),
  });
  assert.deepEqual(phases, ['timelapse', 'leveling'], 'the setting is written before the machine moves');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, `${TIMELAPSE_SETTINGS_PATH}?enabled=true`);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[1].path, /^\/printer\/gcode\/script\?script=BED_MESH_CALIBRATE$/);
  assert.equal(calls[1].method, 'POST');
  assert.ok((calls[1].timeoutMs ?? 0) > 60_000, 'a mesh probe legitimately takes minutes');
});

test('choosing nothing touches the printer at all', async () => {
  let called = 0;
  const transport = {
    async request<T>(): Promise<T> {
      called++;
      return {} as T;
    },
  };
  await applyPrintStartOptions(transport, {
    options: assessPrintStartOptions({ objects: ['bed_mesh'], components: ['timelapse'] }),
    enabled: [],
  });
  assert.equal(called, 0);
});

test('an option the printer never offered is refused, not attempted', async () => {
  let called = 0;
  const transport = {
    async request<T>(): Promise<T> {
      called++;
      return {} as T;
    },
  };
  await assert.rejects(
    () =>
      applyPrintStartOptions(transport, {
        // A machine with no probe and no timelapse component.
        options: assessPrintStartOptions({ objects: ['toolhead'], components: ['file_manager'] }),
        enabled: ['bed-leveling'],
      }),
    (error: unknown) => error instanceof PrintStartOptionError && error.optionId === 'bed-leveling',
  );
  assert.equal(called, 0, 'a refused option must not reach the machine');
});

test('a refusal from the printer is reported as the printer put it', async () => {
  const transport = {
    async request<T>(): Promise<T> {
      throw new Error('Klipper is shut down');
    },
  };
  await assert.rejects(
    () =>
      applyPrintStartOptions(transport, {
        options: assessPrintStartOptions({ components: ['timelapse'] }),
        enabled: ['timelapse'],
      }),
    (error: unknown) => error instanceof PrintStartOptionError && /Klipper is shut down/.test((error as Error).message),
  );
});

await Promise.all(pending);
console.log(`\nPre-print options: ${passed} tests passed.`);
