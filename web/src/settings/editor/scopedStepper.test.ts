/**
 * Traces for the scoped-settings stepper controller (P6.5).
 *
 * P6.5's acceptance is that one draft and one validation serve desktop, touch
 * and XR. The part that was missing was not a rule but a *surface*: XR had no
 * way into a scoped setting at all, and the cross-surface test stood in for it
 * by handing the shared editor the value a stepper would have produced.
 *
 * So these traces drive the real controller — the one the headset panel renders
 * — against the real shipped schema, and check the two properties that decide
 * whether it is one editor or two: the rows it offers come from the same query
 * the DOM panel runs, and a press goes out as the same validated commit the DOM
 * panel sends to the same adapter.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { EngineOptionCatalog, parseEngineOptionSchema } from '../generated/loader';
import { SettingsDraftEditor } from './SettingsDraftEditor';
import { ScopedSettingsStepper, guiSurfaceForScope, type ScopedStepperAdapter } from './scopedStepper';
import type { SettingsValueMap } from './types';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const catalog = new EngineOptionCatalog(
  parseEngineOptionSchema(
    await readFile(resolve(import.meta.dirname, '../generated/engine-options.schema.json'), 'utf8'),
  ),
);

const TARGETS = [
  { id: 'project', scope: 'project' as const, label: 'Project', path: 'Project', overrideCount: 0 },
  { id: 'object:1', scope: 'object' as const, label: 'Cube', path: 'Plate 1 › Cube', overrideCount: 0 },
  { id: 'part:1', scope: 'part' as const, label: 'Body', path: 'Plate 1 › Cube › Body', overrideCount: 0 },
];

/**
 * A stand-in for the canonical project, with the one behaviour that matters:
 * an apply whose guard does not match the snapshot it was prepared against is
 * refused. Everything else — what the commit contains, which keys are legal —
 * is decided by the real editor the controller drives.
 */
function fakeAuthority(initial: SettingsValueMap = {}) {
  const listeners = new Set<() => void>();
  const store = { revision: 1, overrides: { ...initial } as SettingsValueMap, applies: 0 };
  const snapshot = () => ({
    revision: store.revision,
    sourceHash: `hash-${store.revision}`,
    inherited: {} as SettingsValueMap,
    overrides: store.overrides,
  });
  const adapter: ScopedStepperAdapter = {
    load: () => snapshot(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply: (request) => {
      if (request.expectedRevision !== store.revision || request.sourceHash !== `hash-${store.revision}`) {
        throw new Error('stale settings guard');
      }
      store.applies += 1;
      store.revision += 1;
      store.overrides = request.commit.nextOverrides;
      for (const listener of [...listeners]) listener();
      return snapshot();
    },
  };
  return { store, adapter };
}

function controllerFor(authority: ReturnType<typeof fakeAuthority>) {
  const errors: unknown[] = [];
  const stepper = new ScopedSettingsStepper({
    loadCatalog: async () => catalog,
    listTargets: () => TARGETS,
    adapterFor: (id) => {
      assert.ok(
        TARGETS.some((target) => target.id === id),
        `adapterFor asked for an unknown target ${id}`,
      );
      return authority.adapter;
    },
    onChange: () => {},
    onError: (error) => errors.push(error),
  });
  return { stepper, errors };
}

async function ready(stepper: ScopedSettingsStepper) {
  stepper.getView();
  await stepper.whenIdle();
  // The first idle only guarantees the load; the authority's own notification
  // queues one more pass, and a test that read between the two would see rows
  // that are correct but not final.
  await stepper.whenIdle();
  return stepper.getView();
}

await test('the rows are the DOM panel’s own query, minus what no surface supports', async () => {
  const authority = fakeAuthority();
  const { stepper } = controllerFor(authority);
  const view = await ready(stepper);
  assert.equal(view.status, 'ready');

  const editor = new SettingsDraftEditor(catalog, {
    mode: 'simple',
    technology: 'fff',
    guiSurface: guiSurfaceForScope('project'),
  });
  const fields = editor.query({ includeUnavailable: true, includeUnknownApplicability: true });
  const supported = fields.filter((field) => field.support.status === 'implemented');
  assert.deepEqual(
    view.rows.map((row) => row.fieldId),
    supported.map((field) => field.id),
    'every supported field the panel shows has a row, in the same order',
  );
  assert.equal(view.unavailable, fields.length - supported.length);
  assert.ok(view.unavailable > 0, 'the count of unsupported settings is reported rather than hidden');
});

await test('a row that cannot be stepped says why instead of disappearing', async () => {
  const { stepper } = controllerFor(fakeAuthority());
  const view = await ready(stepper);
  const refused = view.rows.filter((row) => !row.steppable);
  assert.ok(refused.length > 0, 'the project scope has settings no stepper can reach');
  for (const row of refused) {
    assert.ok(row.reason && row.reason.length > 0, `${row.key} refuses without saying why`);
  }
  // And the value is still readable: knowing what a setting is set to is the
  // reason to reach for a screen, so hiding it would hide the decision.
  assert.ok(refused.some((row) => row.value.length > 0));
});

await test('a press commits through the adapter and the new value comes back', async () => {
  const authority = fakeAuthority();
  const { stepper, errors } = controllerFor(authority);
  const before = await ready(stepper);
  const row = before.rows.find((entry) => entry.steppable && entry.key === 'sparse_infill_density');
  assert.ok(row, 'sparse infill density is steppable at the project scope');

  stepper.step(row.fieldId, 1);
  await stepper.whenIdle();
  await stepper.whenIdle();

  assert.deepEqual(errors, []);
  assert.equal(authority.store.applies, 1, 'exactly one canonical apply per press');
  assert.equal(authority.store.revision, 2);
  const after = stepper.getView();
  const updated = after.rows.find((entry) => entry.fieldId === row.fieldId);
  assert.ok(updated);
  assert.notEqual(updated.value, row.value, 'the row shows the value the press produced');
  assert.equal(updated.overridden, true, 'the node now stores the setting rather than inheriting it');
  // The guard moved with the project: a second press is prepared against the
  // revision the first one wrote, not the one the panel first loaded.
  stepper.step(row.fieldId, 1);
  await stepper.whenIdle();
  await stepper.whenIdle();
  assert.deepEqual(errors, []);
  assert.equal(authority.store.applies, 2);
});

await test('pressing a refused row reports the reason and writes nothing', async () => {
  const authority = fakeAuthority();
  const { stepper } = controllerFor(authority);
  const before = await ready(stepper);
  const refused = before.rows.find((entry) => !entry.steppable);
  assert.ok(refused);
  stepper.step(refused.fieldId, 1);
  await stepper.whenIdle();
  assert.equal(authority.store.applies, 0, 'a refusal is not a silent no-op that still commits');
  assert.ok(stepper.getView().message, 'the surface is told why the press did nothing');
});

await test('cycling the target changes the scope, and the scope decides the rows', async () => {
  const authority = fakeAuthority();
  const { stepper } = controllerFor(authority);
  const project = await ready(stepper);
  assert.equal(project.scope, 'project');

  stepper.cycleTarget(1);
  await stepper.whenIdle();
  await stepper.whenIdle();
  const object = stepper.getView();
  assert.equal(object.scope, 'object');
  assert.equal(object.targetLabel, 'Plate 1 › Cube');

  stepper.cycleTarget(1);
  await stepper.whenIdle();
  await stepper.whenIdle();
  const part = stepper.getView();
  assert.equal(part.scope, 'part');
  // A part is genuinely narrower: the engine reads no brim setting from one, so
  // the surface cannot offer a control that would do nothing.
  assert.ok(project.rows.some((row) => row.key === 'brim_type'));
  assert.equal(
    part.rows.some((row) => row.key === 'brim_type'),
    false,
  );
  assert.ok(part.rows.length > 0 && part.rows.length < project.rows.length);

  // And it wraps, so a controller with two buttons can reach every node.
  stepper.cycleTarget(1);
  await stepper.whenIdle();
  await stepper.whenIdle();
  assert.equal(stepper.getView().scope, 'project');
});

await test('a stale guard is refused rather than applied to whatever is current', async () => {
  const authority = fakeAuthority();
  const { stepper, errors } = controllerFor(authority);
  const view = await ready(stepper);
  const row = view.rows.find((entry) => entry.steppable);
  assert.ok(row);
  // Someone else commits between the load and the press.
  authority.store.revision += 1;
  stepper.step(row.fieldId, 1);
  await stepper.whenIdle();
  assert.equal(authority.store.applies, 0);
  assert.equal(errors.length, 1);
  assert.match(String((errors[0] as Error).message), /stale/);
  assert.equal(stepper.getView().status, 'error');
});

console.log(`\nScoped settings stepper: ${passed} tests passed.`);
