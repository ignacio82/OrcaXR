/**
 * G-code console safety and macro discovery (P9.6).
 *
 * The classifier is the part worth testing hardest: a console that called an
 * unrecognised command safe, or that ignored the running job, would be exactly
 * as dangerous as no console at all.
 */
import assert from 'node:assert/strict';

import { MoonrakerTransportError } from '../MoonrakerTypes';
import {
  PrinterConsoleError,
  PrinterConsoleLog,
  assessGcodeCommand,
  buildMacroInvocation,
  extractMacroParameters,
  gcodeCommandName,
  listPrinterMacros,
  recentCommands,
  runGcodeScript,
} from '../PrinterConsole';
import { projectPrintJobSnapshot } from '../PrintJobStatus';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class FakeTransport {
  readonly calls: { path: string; method?: string }[] = [];
  constructor(
    private readonly reply: unknown = {},
    private readonly failure?: Error,
  ) {}
  async request<T>(path: string, options: { method?: string } = {}): Promise<T> {
    this.calls.push({ path, ...(options.method ? { method: options.method } : {}) });
    if (this.failure) throw this.failure;
    return this.reply as T;
  }
}

const job = (state: string) => projectPrintJobSnapshot({ webhooks: { state: 'ready' }, print_stats: { state } }, 0);

await test('reports only what reports, and treats everything unknown as caution', () => {
  assert.equal(assessGcodeCommand('M105').level, 'safe');
  assert.equal(assessGcodeCommand('  get_position  ').level, 'safe');
  assert.equal(assessGcodeCommand('; just a comment').level, 'safe');
  assert.equal(assessGcodeCommand('').level, 'safe');

  // A user macro can contain anything, so it can never be assumed harmless.
  const macro = assessGcodeCommand('LOAD_FILAMENT SPEED=5');
  assert.equal(macro.level, 'caution');
  assert.match(macro.reasons[0], /not a command this console recognises/);
  assert.equal(macro.command, 'LOAD_FILAMENT');
});

await test('names the consequence of each command that moves, heats, or halts', () => {
  const move = assessGcodeCommand('G1 X10 Y10 F3000');
  assert.equal(move.level, 'caution');
  assert.deepEqual(move.reasons, ['Moves the toolhead.']);

  const stop = assessGcodeCommand('M112');
  assert.equal(stop.level, 'dangerous');
  assert.match(stop.reasons[0], /firmware restart/);

  const steppers = assessGcodeCommand('M84');
  assert.equal(steppers.level, 'dangerous');
  assert.match(steppers.reasons[0], /Z axis can drop/);
});

await test('a script takes the level of its riskiest line and lists every command once', () => {
  const script = ['M105', 'G1 Z5', '; park', 'M84', 'M105'].join('\n');
  const assessment = assessGcodeCommand(script);
  assert.equal(assessment.level, 'dangerous');
  assert.equal(assessment.command, 'M84');
  assert.deepEqual(assessment.commands, ['M105', 'G1', 'M84']);
  assert.equal(assessment.reasons.length, 2, 'one reason per distinct consequence');
});

await test('the running job is part of the answer, not the caller’s to remember', () => {
  assert.equal(assessGcodeCommand('G1 X10', job('standby')).level, 'caution');
  const midPrint = assessGcodeCommand('G1 X10', job('printing'));
  assert.equal(midPrint.level, 'dangerous');
  assert.match(midPrint.reasons.at(-1) ?? '', /printing; this runs alongside the job/);
  // A pure query stays safe even mid-print: reading a temperature changes nothing.
  assert.equal(assessGcodeCommand('M105', job('printing')).level, 'safe');
  assert.equal(assessGcodeCommand('G1 X10', job('paused')).level, 'dangerous');
});

await test('sends the exact script and refuses an empty or oversized one', async () => {
  const transport = new FakeTransport();
  await runGcodeScript(transport, '  M115  ');
  assert.deepEqual(transport.calls, [{ path: '/printer/gcode/script?script=M115', method: 'POST' }]);

  await assert.rejects(
    () => runGcodeScript(transport, '   '),
    (error: unknown) => error instanceof PrinterConsoleError && error.code === 'empty-script',
  );
  await assert.rejects(
    () => runGcodeScript(transport, 'M105 '.repeat(1200)),
    (error: unknown) => error instanceof PrinterConsoleError && error.code === 'too-long',
  );
  assert.equal(transport.calls.length, 1, 'a refused script never reaches the printer');

  const failing = new FakeTransport({}, new MoonrakerTransportError('http_error', 'gcode_script'));
  await assert.rejects(
    () => runGcodeScript(failing, 'M115'),
    (error: unknown) =>
      error instanceof PrinterConsoleError && error.code === 'send-failed' && /refused M115/.test(error.message),
  );
});

await test('reads macros from the configuration, with the parameters their bodies actually use', async () => {
  const transport = new FakeTransport({
    status: {
      configfile: {
        settings: {
          'gcode_macro load_filament': {
            description: 'Load filament into the hotend',
            gcode: 'M104 S{params.TEMP|default(220)}\nG1 E{params.LENGTH} F{params.SPEED|default(300)|float}',
          },
          'gcode_macro park': { description: 'G-Code macro', gcode: 'G1 X0 Y0' },
          'gcode_macro reset_all': { gcode: 'FIRMWARE_RESTART' },
          'gcode_macro empty': { gcode: '' },
          stepper_x: { position_max: 220 },
        },
      },
    },
  });
  const macros = await listPrinterMacros(transport);
  assert.deepEqual(
    macros.map((macro) => macro.name),
    ['EMPTY', 'LOAD_FILAMENT', 'PARK', 'RESET_ALL'],
  );

  const load = macros.find((macro) => macro.name === 'LOAD_FILAMENT')!;
  assert.equal(load.description, 'Load filament into the hotend');
  assert.deepEqual(load.parameters, [
    { name: 'LENGTH', required: true },
    { name: 'SPEED', defaultValue: '300', required: false },
    { name: 'TEMP', defaultValue: '220', required: false },
  ]);
  assert.equal(load.level, 'caution', 'it heats and moves');

  // A macro whose body restarts the firmware is dangerous however it is named.
  assert.equal(macros.find((macro) => macro.name === 'RESET_ALL')!.level, 'dangerous');
  // Klipper's placeholder description carries no information; it is dropped.
  assert.equal(macros.find((macro) => macro.name === 'PARK')!.description, undefined);
  // An empty body says nothing, which is not the same as saying it is harmless.
  assert.equal(macros.find((macro) => macro.name === 'EMPTY')!.level, 'caution');
});

await test('reports a printer that will not describe itself instead of showing no macros', async () => {
  await assert.rejects(
    () => listPrinterMacros(new FakeTransport({ status: {} })),
    (error: unknown) => error instanceof PrinterConsoleError && error.code === 'macros-unavailable',
  );
  await assert.rejects(
    () => listPrinterMacros(new FakeTransport({}, new MoonrakerTransportError('timeout', 'list_macros'))),
    (error: unknown) => error instanceof PrinterConsoleError && error.code === 'macros-unavailable',
  );
});

await test('extracts bracket and dotted parameter reads, and quotes only what needs it', () => {
  assert.deepEqual(extractMacroParameters("{params['BED_TEMP']|default('60')} {params.X}"), [
    { name: 'BED_TEMP', defaultValue: '60', required: false },
    { name: 'X', required: true },
  ]);
  // A later read with a default relaxes an earlier required one.
  assert.deepEqual(extractMacroParameters('{params.T} {params.T|default(1)}'), [
    { name: 'T', defaultValue: '1', required: false },
  ]);
  assert.equal(buildMacroInvocation('load_filament', { temp: '220', speed: '' }), 'LOAD_FILAMENT TEMP=220');
  assert.equal(buildMacroInvocation('SAY', { text: 'hello world' }), 'SAY TEXT="hello world"');
  assert.equal(gcodeCommandName('  set_pin PIN=led VALUE=1 ; on'), 'SET_PIN');
});

await test('the transcript redacts on the way in and stays bounded', () => {
  const log = new PrinterConsoleLog(3, () => ['super-secret-key']);
  log.append('sent', 'M117 key super-secret-key');
  assert.match(log.entries[0].text, /<redacted>/);
  assert.equal(log.entries[0].text.includes('super-secret-key'), false);

  log.appendNotification('notify_gcode_response', ['ok T:210']);
  log.appendNotification('notify_gcode_response', ['!! Must home axis first']);
  log.appendNotification('notify_status_update', [{}]);
  assert.deepEqual(
    log.entries.map((entry) => entry.kind),
    ['sent', 'received', 'error'],
  );
  log.append('sent', 'M105');
  assert.equal(log.entries.length, 3, 'the oldest entry is dropped at the limit');
  assert.equal(log.entries[0].kind, 'received');
});

await test('recent commands are for retyping: newest first, no repeats, sent only', () => {
  const log = new PrinterConsoleLog();
  log.append('sent', 'M105');
  log.append('received', 'ok');
  log.append('sent', 'G28');
  log.append('sent', 'M105');
  assert.deepEqual(recentCommands(log.entries), ['M105', 'G28']);
  assert.deepEqual(recentCommands(log.entries, 1), ['M105']);
});

await test('names the command Klipper runs, line numbers and glued parameters included', () => {
  // Each of these halts or frees the machine; they used to read as unknown.
  for (const line of ['N10 M112', 'n10 m112 ; stop', 'M112X', 'M112*45', 'M84E', '1 M112', 'M 112']) {
    const name = gcodeCommandName(line);
    assert.equal(assessGcodeCommand(line).level, 'dangerous', `${line} → ${name}`);
  }
  assert.equal(gcodeCommandName('G1X10Y10'), 'G1');
  assert.equal(gcodeCommandName('PRINT_START2 BED=60'), 'PRINT_START2');
  // A line Klipper reads no command from stays unknown, never safe.
  assert.equal(gcodeCommandName('123'), '123');
  assert.equal(assessGcodeCommand('N10').level, 'caution');
});

await test('a script with text no URL can spell is refused before anything is sent', async () => {
  const transport = new FakeTransport();
  // It used to read "The printer refused M117 (request failed)." though nothing left.
  await assert.rejects(
    () => runGcodeScript(transport, 'M117 x\uD800'),
    (error: unknown) => error instanceof PrinterConsoleError && error.code === 'invalid-script',
  );
  assert.deepEqual(transport.calls, []);
});

await test('macro values arrive exactly as typed, or are refused', () => {
  // `#` began a comment and `\` an escape; both used to be sent bare.
  assert.equal(buildMacroInvocation('M', { a: 'x#y' }), 'M A="x#y"');
  assert.equal(buildMacroInvocation('M', { a: 'c:\\dir' }), 'M A="c:\\\\dir"');
  assert.equal(buildMacroInvocation('M', { a: 'say "hi"' }), 'M A="say \\"hi\\""');
  const refused: Record<string, string>[] = [{ a: 'x;y' }, { a: 'x\ny' }, { 'a b': '1' }, { 'a=b': '1' }, { '': '1' }];
  for (const values of refused) {
    assert.throws(
      () => buildMacroInvocation('M', values),
      (error: unknown) => error instanceof PrinterConsoleError && error.code === 'invalid-macro',
      JSON.stringify(values),
    );
  }
});

await test('macros sharing a name list in section order, whatever the reply’s key order', async () => {
  const bodies: Record<string, string> = { 'gcode_macro foo': 'M84', 'gcode_macro FOO': 'G28' };
  const listed = (sections: string[]) =>
    listPrinterMacros(
      new FakeTransport({
        status: {
          configfile: {
            settings: Object.fromEntries(sections.map((section) => [section, { gcode: bodies[section] }])),
          },
        },
      }),
    );
  const forward = await listed(['gcode_macro foo', 'gcode_macro FOO']);
  const backward = await listed(['gcode_macro FOO', 'gcode_macro foo']);
  assert.deepEqual(forward, backward);
  assert.deepEqual(
    forward.map((macro) => macro.level),
    ['caution', 'dangerous'],
  );
});

console.log(`\nPrinter console: ${passed} tests passed.`);
