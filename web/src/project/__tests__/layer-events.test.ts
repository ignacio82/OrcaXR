import assert from 'node:assert/strict';

import { CommandBus } from '../history/commandBus';
import { ProjectStore } from '../store';
import { SelectionStore } from '../selection';
import { InMemoryAssetRepository } from '../assets';
import { entityId, type CustomGcodeId } from '../domain/ids';
import {
  AddLayerEventCommand,
  DeleteLayerEventCommand,
  EditLayerEventCommand,
  plateLayerEvents,
} from '../layerEventCommands';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness() {
  const fixture = createProjectFixture();
  const project = new ProjectStore(fixture.state);
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection: new SelectionStore(), assets });
  return { bus, project, plateId: fixture.state.plates[0].id };
}

const id = (suffix: string) => entityId<'custom-gcode'>(`import:test:${suffix}`) as CustomGcodeId;

test('adds a pause as one reversible command bound to an exact height', () => {
  const { bus, project, plateId } = harness();
  bus.execute(
    new AddLayerEventCommand({
      id: id('pause'),
      plateId,
      type: 'pause',
      topZMm: 4.2,
      message: 'Insert the magnet',
    }),
  );
  const [event] = plateLayerEvents(project.getSnapshot().state, plateId);
  assert.deepEqual(event.layerEvent, { type: 'pause', topZMm: 4.2, message: 'Insert the magnet' });
  assert.equal(event.scope, 'plate');
  assert.equal(event.trigger, 'before-layer');
  assert.equal(event.code, '', 'a pause takes its body from the printer profile');

  bus.undo();
  assert.deepEqual(project.getSnapshot().state.customGcode, []);
  bus.redo();
  assert.equal(plateLayerEvents(project.getSnapshot().state, plateId).length, 1);
});

test('keeps events in print order regardless of authoring order', () => {
  const { bus, project, plateId } = harness();
  for (const [suffix, topZMm] of [
    ['third', 9],
    ['first', 1.2],
    ['second', 4],
  ] as const) {
    bus.execute(new AddLayerEventCommand({ id: id(suffix), plateId, type: 'pause', topZMm }));
  }
  assert.deepEqual(
    plateLayerEvents(project.getSnapshot().state, plateId).map((entry) => entry.layerEvent?.topZMm),
    [1.2, 4, 9],
  );
});

test('refuses a second event at the same height on one plate', () => {
  const { bus, plateId } = harness();
  bus.execute(new AddLayerEventCommand({ id: id('one'), plateId, type: 'pause', topZMm: 2 }));
  assert.throws(
    () => bus.execute(new AddLayerEventCommand({ id: id('two'), plateId, type: 'custom', topZMm: 2, code: 'M117' })),
    /One layer event per height/,
  );
});

test('validates each event type instead of emitting something the engine ignores', () => {
  const { bus, plateId } = harness();
  assert.throws(
    () => bus.execute(new AddLayerEventCommand({ id: id('empty'), plateId, type: 'custom', topZMm: 3 })),
    /needs G-code to emit/,
  );
  assert.throws(
    () => bus.execute(new AddLayerEventCommand({ id: id('tool'), plateId, type: 'tool-change', topZMm: 3 })),
    /1-based tool/,
  );
  assert.throws(
    () => bus.execute(new AddLayerEventCommand({ id: id('floor'), plateId, type: 'pause', topZMm: 0 })),
    /height must be above the plate/,
  );
});

test('edits one field at a time and reverts to the exact previous event', () => {
  const { bus, project, plateId } = harness();
  bus.execute(new AddLayerEventCommand({ id: id('edit'), plateId, type: 'custom', topZMm: 3, code: 'M117 first' }));
  bus.execute(new EditLayerEventCommand(id('edit'), { topZMm: 5.5 }));
  const edited = plateLayerEvents(project.getSnapshot().state, plateId)[0];
  assert.equal(edited.layerEvent?.topZMm, 5.5);
  assert.equal(edited.code, 'M117 first', 'an untouched field survives the edit');

  bus.execute(new EditLayerEventCommand(id('edit'), { type: 'pause', code: '' }));
  assert.equal(plateLayerEvents(project.getSnapshot().state, plateId)[0].layerEvent?.type, 'pause');
  bus.undo();
  assert.equal(plateLayerEvents(project.getSnapshot().state, plateId)[0].code, 'M117 first');
  bus.undo();
  assert.equal(plateLayerEvents(project.getSnapshot().state, plateId)[0].layerEvent?.topZMm, 3);
});

test('deletes exactly one event and restores it on undo', () => {
  const { bus, project, plateId } = harness();
  bus.execute(new AddLayerEventCommand({ id: id('keep'), plateId, type: 'pause', topZMm: 2 }));
  bus.execute(new AddLayerEventCommand({ id: id('drop'), plateId, type: 'pause', topZMm: 6 }));
  bus.execute(new DeleteLayerEventCommand(id('drop')));
  assert.deepEqual(
    plateLayerEvents(project.getSnapshot().state, plateId).map((entry) => entry.id),
    [id('keep')],
  );
  bus.undo();
  assert.equal(plateLayerEvents(project.getSnapshot().state, plateId).length, 2);
  assert.throws(() => bus.execute(new DeleteLayerEventCommand(id('missing'))), /Unknown layer event/);
});

console.log(`\nCanonical layer events: ${passed} tests passed.`);
