/**
 * P6.5 acceptance: two surfaces, one draft/commit state.
 *
 * A desktop field and an XR control disagree about *input* — one is typed text,
 * the other is a stepped or cycled value produced without a keyboard — and that
 * difference is the whole reason a surface is tempted to build its own path to
 * the project. So this drives the shared {@link SettingsDraftEditor} the two
 * ways the two shells drive it, at all five scopes, and then requires that the
 * canonical state and the generated 3MF configs come out byte-for-byte
 * identical. Nothing about the comparison is scoped to one surface's habits:
 * it is the whole project, including `Metadata/project_settings.config` and
 * `Metadata/model_settings.config`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  Bbs3mfProjectSerializer,
  CommandBus,
  InMemoryAssetRepository,
  ProjectStore,
  SelectionStore,
  SetProjectSettingsOverridesCommand,
  SetScopedOverridesCommand,
  canonicalStringify,
  cloneProjectState,
  projectFingerprint,
  projectScopeUpdate,
  readSafeZip,
  scopedOverrideSnapshot,
  scopedOverrideTargets,
  type ConfigMap,
  type ScopedOverrideTarget,
} from '..';
import { EngineOptionCatalog, parseEngineOptionSchema } from '../../settings/generated/loader';
import {
  SettingsDraftEditor,
  applySettingsCommitToConfig,
  decodeSettingsConfig,
  serializeSettingValue,
} from '../../settings/editor';
import { guiSurfaceForScope } from '../../ui/dom/ScopedSettingsPanel';
import { createProjectFixture } from './fixtures';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const catalog = new EngineOptionCatalog(
  parseEngineOptionSchema(
    readFileSync(new URL('../../settings/generated/engine-options.schema.json', import.meta.url), 'utf8'),
  ),
);

/** One sampled setting per scope, chosen because each is legal only there. */
const SAMPLES = [
  { scope: 'project', key: 'sparse_infill_density', value: 33 },
  { scope: 'plate', key: 'spiral_mode', value: false },
  { scope: 'object', key: 'brim_type', value: 'outer_only' },
  { scope: 'part', key: 'wall_loops', value: 5 },
  { scope: 'layerRange', key: 'layer_height', value: 0.14 },
] as const;

function harness() {
  const fixture = createProjectFixture();
  const project = new ProjectStore(cloneProjectState(fixture.state));
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const bus = new CommandBus({ project, selection: new SelectionStore(), assets });
  bus.markCheckpoint();
  return { fixture, project, bus };
}

function targetFor(project: ProjectStore, scope: (typeof SAMPLES)[number]['scope']): ScopedOverrideTarget {
  const option = scopedOverrideTargets(project.getSnapshot().state).find((entry) => entry.scope === scope);
  assert.ok(option, `no ${scope} target in the fixture`);
  return option.target;
}

function definitionFor(key: string) {
  const definitions = catalog.all(key);
  assert.equal(definitions.length, 1, `${key} must have exactly one generated definition`);
  return definitions[0];
}

/**
 * Commit one sampled edit through the shared editor and the canonical command.
 *
 * `raw` is whatever the surface produced: a DOM field hands over the string a
 * person typed; an XR stepper hands over the serialized form of the value it
 * arrived at. Everything after that point is identical by construction, which
 * is exactly the property under test.
 */
function applySample(project: ProjectStore, bus: CommandBus, sample: (typeof SAMPLES)[number], raw: string): void {
  const target = targetFor(project, sample.scope);
  const view = scopedOverrideSnapshot(project.getSnapshot(), target);
  const editor = new SettingsDraftEditor(catalog, {
    mode: 'develop',
    technology: 'fff',
    guiSurface: guiSurfaceForScope(sample.scope),
    ...(sample.scope === 'project' ? {} : { scope: sample.scope }),
    inherited: decodeSettingsConfig(catalog, view.inheritedConfig).values,
    overrides: decodeSettingsConfig(catalog, view.overrides).values,
  });
  const definition = definitionFor(sample.key);
  editor.setDraft(definition.id, raw);
  const overrides = applySettingsCommitToConfig(view.overrides, editor.commit());
  const guard = { sourceRevision: project.getSnapshot().revision, sourceHash: project.getSnapshot().hash };
  if (target.scope === 'project') {
    const update = projectScopeUpdate(project.getSnapshot(), overrides);
    bus.execute(
      new SetProjectSettingsOverridesCommand(guard, {
        inheritedConfig: update.inheritedConfig,
        overrides: update.overrides,
      }),
    );
  } else {
    bus.execute(new SetScopedOverridesCommand(guard, target, overrides));
  }
}

/** What a person types: the same characters the panel puts in the input. */
function typedInput(sample: (typeof SAMPLES)[number]): string {
  return typeof sample.value === 'boolean' ? (sample.value ? '1' : '0') : String(sample.value);
}

/**
 * What a controller produces: no text at all, a value reached by stepping or
 * cycling and then serialized by the same codec the panel uses to display it.
 */
function steppedInput(sample: (typeof SAMPLES)[number]): string {
  return serializeSettingValue(definitionFor(sample.key), sample.value);
}

async function exported(project: ProjectStore, fixtureAsset: ReturnType<typeof createProjectFixture>['asset']) {
  const snapshot = project.getSnapshot();
  const saved = await new Bbs3mfProjectSerializer().serialize({
    state: snapshot.state,
    assets: [fixtureAsset],
    sourceRevision: snapshot.revision,
    sourceHash: projectFingerprint(snapshot.state),
  });
  const files = readSafeZip(saved.bytes);
  return {
    project: files.get('Metadata/project_settings.config')!,
    model: files.get('Metadata/model_settings.config')!,
  };
}

await test('every sampled setting is legal only at the scope it is sampled at', () => {
  for (const sample of SAMPLES) {
    const editor = new SettingsDraftEditor(catalog, {
      mode: 'develop',
      guiSurface: guiSurfaceForScope(sample.scope),
      ...(sample.scope === 'project' ? {} : { scope: sample.scope }),
    });
    const fields = editor.query({ includeUnavailable: true, includeUnknownApplicability: true });
    assert.ok(
      fields.some((field) => field.key === sample.key),
      `${sample.key} should be offered at the ${sample.scope} scope`,
    );
  }
  // The narrower scopes really are narrower: a part cannot take a brim type,
  // and no model scope can take a plate's print sequence.
  const part = new SettingsDraftEditor(catalog, { mode: 'develop', scope: 'part', guiSurface: 'process' });
  assert.equal(
    part.query({ includeUnavailable: true }).some((field) => field.key === 'brim_type'),
    false,
  );
  assert.throws(() => part.setDraft(definitionFor('brim_type').id, 'outer_only'), /cannot be overridden at the part/);
});

await test('typed desktop input and stepped XR input produce the same canonical project', async () => {
  const dom = harness();
  const xr = harness();
  for (const sample of SAMPLES) {
    applySample(dom.project, dom.bus, sample, typedInput(sample));
    applySample(xr.project, xr.bus, sample, steppedInput(sample));
  }

  const domState = dom.project.getSnapshot().state;
  const xrState = xr.project.getSnapshot().state;
  assert.equal(canonicalStringify(domState), canonicalStringify(xrState));
  assert.equal(projectFingerprint(domState), projectFingerprint(xrState));

  const domFiles = await exported(dom.project, dom.fixture.asset);
  const xrFiles = await exported(xr.project, xr.fixture.asset);
  assert.deepEqual(domFiles.project, xrFiles.project);
  assert.deepEqual(domFiles.model, xrFiles.model);

  // The edits actually landed, each at its own scope and nowhere else.
  const decoder = new TextDecoder();
  const projectConfig = JSON.parse(decoder.decode(domFiles.project)) as Record<string, unknown>;
  // A percent option serializes with its unit, and both surfaces reached the
  // same wire form from different inputs — '33' typed and a stepped 33.
  assert.equal(projectConfig.sparse_infill_density, '33%');
  const modelConfig = decoder.decode(domFiles.model);
  assert.match(modelConfig, /key="brim_type" value="outer_only"/);
  assert.match(modelConfig, /key="wall_loops" value="5"/);
  assert.match(modelConfig, /key="spiral_mode" value="0"/);

  for (const sample of SAMPLES) {
    const view = scopedOverrideSnapshot(dom.project.getSnapshot(), targetFor(dom.project, sample.scope));
    assert.ok(
      Object.prototype.hasOwnProperty.call(view.overrides, sample.key),
      `${sample.key} should be stored on the ${sample.scope}`,
    );
  }
});

await test('the same edits undo to the project they started from', () => {
  const { project, bus } = harness();
  const before = canonicalStringify(project.getSnapshot().state);
  for (const sample of SAMPLES) applySample(project, bus, sample, typedInput(sample));
  assert.notEqual(canonicalStringify(project.getSnapshot().state), before);
  for (const _ of SAMPLES) bus.undo();
  assert.equal(canonicalStringify(project.getSnapshot().state), before);
});

await test('a saved project reopens with every scope still overridden', async () => {
  const { fixture, project, bus } = harness();
  for (const sample of SAMPLES) applySample(project, bus, sample, typedInput(sample));
  const snapshot = project.getSnapshot();
  const serializer = new Bbs3mfProjectSerializer();
  const saved = await serializer.serialize({
    state: snapshot.state,
    assets: [fixture.asset],
    sourceRevision: snapshot.revision,
    sourceHash: projectFingerprint(snapshot.state),
  });
  const reopened = await serializer.deserialize(saved.bytes);
  const reopenedStore = new ProjectStore(reopened.state);
  for (const sample of SAMPLES) {
    const view = scopedOverrideSnapshot(reopenedStore.getSnapshot(), targetFor(reopenedStore, sample.scope));
    const stored = (view.overrides as ConfigMap)[sample.key];
    assert.ok(stored !== undefined, `${sample.key} was lost from the ${sample.scope} on reopen`);
  }
});

console.log(`\nScoped settings cross-surface parity: ${passed} tests passed.`);
