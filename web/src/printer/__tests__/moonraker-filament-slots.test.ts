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

console.log(`\nMoonraker filament slots: ${passed} tests passed.`);
