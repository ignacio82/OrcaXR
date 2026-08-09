import assert from 'node:assert';
import { MoonrakerTransportError } from '../MoonrakerTypes';
import { parseMoonrakerFilamentSlots, queryMoonrakerFilamentSlots } from '../MoonrakerFilamentSlots';

let passed = 0;
function test(name: string, operation: () => void | Promise<void>) {
  return Promise.resolve(operation()).then(() => {
    passed += 1;
    console.log('  ✓', name);
  });
}

await test('parses bounded loaded Snapmaker slots with normalized safe fields', () => {
  const slots = parseMoonrakerFilamentSlots({
    status: {
      print_task_config: {
        filament_color_rgba: ['ff0000ff', '#00ff00', 'not-a-color'],
        filament_type: ['PLA Matte', 'PETG-CF', ''],
        filament_vendor: ['Maker\u0000', 'Vendor', '<unknown>'],
        filament_exist: [1, 'true', 0],
      },
    },
  });
  assert.deepStrictEqual(slots, [
    { slotIndex: 0, colorHex: '#FF0000', material: 'PLA', vendor: 'Maker' },
    { slotIndex: 1, colorHex: '#00FF00', material: 'PETG', vendor: 'Vendor' },
  ]);
  assert.ok(Object.isFrozen(slots));
  assert.ok(Object.isFrozen(slots[0]));
});

await test('missing presence flags means every described slot is available', () => {
  assert.deepStrictEqual(
    parseMoonrakerFilamentSlots({
      status: { print_task_config: { filament_color_rgba: ['123456'], filament_type: ['PA-CF'] } },
    }),
    [{ slotIndex: 0, colorHex: '#123456', material: 'PA', vendor: '' }],
  );
});

await test('malformed extension payload fails with a bounded typed error', () => {
  assert.throws(
    () => parseMoonrakerFilamentSlots({ status: { print_task_config: { filament_color_rgba: {} } } }),
    (error: unknown) =>
      error instanceof MoonrakerTransportError &&
      error.code === 'invalid_response' &&
      error.operation === 'query_filament_slots' &&
      !error.message.includes('print_task_config'),
  );
});

await test('query uses the typed transport operation and forwards cancellation', async () => {
  const controller = new AbortController();
  let observed: unknown;
  const slots = await queryMoonrakerFilamentSlots(
    {
      async request(path, options) {
        observed = { path, options };
        return { status: { print_task_config: { filament_color_rgba: [] } } } as never;
      },
    },
    controller.signal,
  );
  assert.deepStrictEqual(slots, []);
  assert.deepStrictEqual(observed, {
    path: '/printer/objects/query?print_task_config=&filament_detect=',
    options: { signal: controller.signal, operation: 'query_filament_slots' },
  });
});

/**
 * Captured from a Snapmaker U1 over its Moonraker extension, reduced to the
 * keys this parser reads. Four PLA slots of three different grades, which is
 * the case that shows why the grade cannot be folded into the type.
 */
const SNAPMAKER_U1_RESPONSE = {
  status: {
    print_task_config: {
      filament_vendor: ['Snapmaker', 'Snapmaker', 'Snapmaker', 'Snapmaker'],
      filament_type: ['PLA', 'PLA', 'PLA', 'PLA'],
      filament_sub_type: ['Matte', 'Matte', 'SnapSpeed', 'Matte'],
      filament_color_rgba: ['1E88E5FF', '000000FF', 'E2DEDBFF', 'F8F81CFF'],
      filament_exist: [true, true, true, true],
    },
  },
};

await test('reads a real Snapmaker U1 four-slot response, grade included', () => {
  const slots = parseMoonrakerFilamentSlots(SNAPMAKER_U1_RESPONSE);
  assert.equal(slots.length, 4);
  assert.deepEqual(
    slots.map((slot) => [slot.slotIndex, slot.material, slot.subType, slot.colorHex, slot.vendor]),
    [
      [0, 'PLA', 'Matte', '#1E88E5', 'Snapmaker'],
      [1, 'PLA', 'Matte', '#000000', 'Snapmaker'],
      [2, 'PLA', 'SnapSpeed', '#E2DEDB', 'Snapmaker'],
      [3, 'PLA', 'Matte', '#F8F81C', 'Snapmaker'],
    ],
  );
  // The type stays sliceable; the grade rides alongside it.
  assert.deepEqual(new Set(slots.map((slot) => slot.material)), new Set(['PLA']));
});

await test('a machine that reports no grade simply omits it', () => {
  const slots = parseMoonrakerFilamentSlots({
    status: {
      print_task_config: {
        filament_color_rgba: ['112233FF'],
        filament_type: ['PETG'],
        filament_vendor: ['Generic'],
        filament_exist: [true],
      },
    },
  });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].subType, undefined);
  assert.equal(slots[0].material, 'PETG');
});

console.log(`\nMoonraker filament slots: ${passed} tests passed.`);
