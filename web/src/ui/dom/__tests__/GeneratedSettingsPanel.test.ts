import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// @ts-expect-error -- jsdom 29 has no bundled declaration file; production code remains DOM-native.
import { JSDOM } from 'jsdom';

import { EngineOptionCatalog, parseEngineOptionSchema } from '../../../settings/generated/loader';
import {
  GeneratedSettingsPanel,
  type GeneratedSettingsPanelAdapter,
  type GeneratedSettingsPanelApplyRequest,
  type GeneratedSettingsPanelCancelRequest,
  type GeneratedSettingsPanelSnapshot,
} from '../GeneratedSettingsPanel';

const schema = parseEngineOptionSchema(
  readFileSync(new URL('../../../settings/generated/engine-options.schema.json', import.meta.url), 'utf8'),
);
const catalog = new EngineOptionCatalog(schema);

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('loads asynchronously and exposes accessible modes, search, origin badges, and honest availability', async () => {
  const harness = createDocument();
  const pendingCatalog = deferred<EngineOptionCatalog>();
  const adapter = staticAdapter({
    revision: 3,
    sourceHash: 'hash-3',
    inherited: { layer_height: 0.24, wall_loops: 2 },
    overrides: { wall_loops: 3 },
  });
  const panel = new GeneratedSettingsPanel(harness.container, adapter, {
    initialMode: 'simple',
    initialSearch: 'layer height',
    loadCatalog: () => pendingCatalog.promise,
  });

  const mounted = panel.mount();
  assert.match(harness.document.querySelector('[data-settings-schema-status]')?.textContent ?? '', /Loading/);
  assert.equal(harness.document.querySelector('[data-settings-search]')?.hasAttribute('disabled'), true);
  pendingCatalog.resolve(catalog);
  await mounted;

  const form = harness.document.querySelector<HTMLFormElement>('[data-generated-settings-panel]')!;
  assert.ok(form.getAttribute('aria-labelledby'));
  assert.equal(form.querySelectorAll<HTMLInputElement>('[data-settings-mode]').length, 3);
  assert.equal(form.querySelector<HTMLInputElement>('[data-settings-mode="simple"]')?.checked, true);
  assert.ok(form.querySelector('[data-settings-search]')?.getAttribute('aria-controls'));
  assert.match(form.querySelector('[data-settings-schema-status]')?.textContent ?? '', /foundation-partial/);
  assert.equal(origin(form, 'layer_height'), 'inherited');

  search(harness, 'enable support');
  assert.equal(origin(form, 'enable_support'), 'default');
  assert.equal(
    field(form, 'enable_support')?.querySelector('[data-settings-control]')?.getAttribute('type'),
    'checkbox',
  );
  search(harness, 'brim type');
  assert.equal(field(form, 'brim_type')?.querySelector('[data-settings-control]')?.tagName, 'SELECT');
  search(harness, 'wall loops');
  assert.equal(origin(form, 'wall_loops'), 'changed');

  search(harness, 'wall filament');
  assert.equal(field(form, 'wall_filament'), null);
  form.querySelector<HTMLInputElement>('[data-settings-mode="advanced"]')!.click();
  const unsupported = field(form, 'wall_filament')!;
  assert.equal(unsupported.dataset.settingsSupport, 'unavailable');
  assert.equal(unsupported.querySelector<HTMLInputElement>('[data-settings-control]')?.disabled, true);
  assert.match(unsupported.querySelector('[data-settings-unavailable-reason]')?.textContent ?? '', /unimplemented/);
  assert.equal(unsupported.querySelector('[data-settings-availability]')?.textContent, 'Unavailable');

  search(harness, 'machine start gcode');
  assert.equal(field(form, 'machine_start_gcode')?.querySelector('[data-settings-control]')?.tagName, 'TEXTAREA');

  search(harness, 'add line number');
  assert.equal(field(form, 'gcode_add_line_number'), null);
  form.querySelector<HTMLInputElement>('[data-settings-mode="develop"]')!.click();
  assert.ok(field(form, 'gcode_add_line_number'));
  panel.dispose();
  assert.equal(harness.container.childElementCount, 0);
});

await test('expands every Local-Z mode transition atomically and projects child applicability', async () => {
  const harness = createDocument();
  let snapshot: GeneratedSettingsPanelSnapshot = {
    revision: 20,
    sourceHash: 'hash-20',
    inherited: {
      dithering_local_z_mode: false,
      dithering_local_z_whole_objects: false,
      dithering_local_z_infill: false,
      dithering_local_z_direct_multicolor: false,
    },
    overrides: {},
  };
  const applies: GeneratedSettingsPanelApplyRequest[] = [];
  const panel = new GeneratedSettingsPanel(
    harness.container,
    {
      load: () => snapshot,
      apply: (request) => {
        applies.push(request);
        snapshot = {
          revision: 21,
          sourceHash: 'hash-21',
          inherited: snapshot.inherited,
          overrides: request.commit.nextOverrides,
        };
        return snapshot;
      },
      cancel: () => undefined,
    },
    {
      initialMode: 'advanced',
      initialSearch: 'dithering_local_z_',
      loadCatalog: async () => catalog,
    },
  );
  await panel.mount();
  const form = harness.document.querySelector<HTMLFormElement>('[data-generated-settings-panel]')!;
  const children = [
    'dithering_local_z_whole_objects',
    'dithering_local_z_infill',
    'dithering_local_z_direct_multicolor',
  ] as const;

  for (const key of children) {
    assert.equal(control(form, key).disabled, true);
    assert.equal(field(form, key)?.dataset.settingsApplicability, 'not-applicable');
    assert.equal(
      field(form, key)
        ?.querySelector('[data-settings-dependency-state="disabled"]')
        ?.textContent?.includes('Subdivide Mix Layer'),
      true,
    );
  }

  control(form, 'dithering_local_z_mode').click();
  assert.equal(control(form, 'dithering_local_z_mode').checked, true);
  for (const key of children) {
    assert.equal(control(form, key).disabled, false);
    assert.equal(field(form, key)?.dataset.settingsApplicability, 'applicable');
  }
  assert.equal(control(form, 'dithering_local_z_infill').checked, true, 'enabling mode auto-enables infill');

  control(form, 'dithering_local_z_whole_objects').click();
  control(form, 'dithering_local_z_infill').click();
  control(form, 'dithering_local_z_direct_multicolor').click();
  assert.equal(control(form, 'dithering_local_z_whole_objects').checked, true);
  assert.equal(control(form, 'dithering_local_z_infill').checked, false);
  assert.equal(control(form, 'dithering_local_z_direct_multicolor').checked, true);

  control(form, 'dithering_local_z_mode').click();
  assert.equal(control(form, 'dithering_local_z_mode').checked, false);
  for (const key of children) {
    assert.equal(control(form, key).checked, false, `disabling mode must clear ${key}`);
    assert.equal(control(form, key).disabled, true);
  }

  control(form, 'dithering_local_z_mode').click();
  assert.equal(control(form, 'dithering_local_z_mode').checked, true);
  assert.equal(control(form, 'dithering_local_z_whole_objects').checked, false);
  assert.equal(control(form, 'dithering_local_z_infill').checked, true);
  assert.equal(control(form, 'dithering_local_z_direct_multicolor').checked, false);

  form.querySelector<HTMLButtonElement>('[data-settings-apply]')!.click();
  await settle();
  assert.equal(applies.length, 1, 'all explicit and implicit values use one adapter transaction');
  assert.equal(applies[0].expectedRevision, 20);
  assert.equal(applies[0].sourceHash, 'hash-20');
  assert.deepEqual(
    applies[0].commit.changes.map((change) => [change.key, change.action, change.serialized]),
    [
      ['dithering_local_z_direct_multicolor', 'set', '0'],
      ['dithering_local_z_infill', 'set', '1'],
      ['dithering_local_z_mode', 'set', '1'],
      ['dithering_local_z_whole_objects', 'set', '0'],
    ],
  );
  assert.deepEqual(applies[0].commit.nextOverrides, {
    dithering_local_z_direct_multicolor: false,
    dithering_local_z_infill: true,
    dithering_local_z_mode: true,
    dithering_local_z_whole_objects: false,
  });
  assert.match(form.querySelector('[data-settings-operation-status]')?.textContent ?? '', /Applied 4.*atomically/);
  panel.dispose();
});

await test('blocks inverted FullSpectrum height bounds before the adapter and commits the valid pair once', async () => {
  const harness = createDocument();
  let snapshot: GeneratedSettingsPanelSnapshot = {
    revision: 30,
    sourceHash: 'hash-30',
    inherited: {
      mixed_filament_height_lower_bound: 0.04,
      mixed_filament_height_upper_bound: 0.16,
    },
    overrides: {},
  };
  const applies: GeneratedSettingsPanelApplyRequest[] = [];
  const panel = new GeneratedSettingsPanel(
    harness.container,
    {
      load: () => snapshot,
      apply: (request) => {
        applies.push(request);
        snapshot = {
          revision: 31,
          sourceHash: 'hash-31',
          inherited: snapshot.inherited,
          overrides: request.commit.nextOverrides,
        };
        return snapshot;
      },
      cancel: () => undefined,
    },
    {
      initialMode: 'advanced',
      initialSearch: 'height bound',
      loadCatalog: async () => catalog,
    },
  );
  await panel.mount();
  const form = harness.document.querySelector<HTMLFormElement>('[data-generated-settings-panel]')!;
  const apply = form.querySelector<HTMLButtonElement>('[data-settings-apply]')!;

  setText(harness, control(form, 'mixed_filament_height_lower_bound'), '0.2');
  assert.equal(apply.disabled, true);
  for (const key of ['mixed_filament_height_lower_bound', 'mixed_filament_height_upper_bound']) {
    assert.equal(control(form, key).getAttribute('aria-invalid'), 'true');
    assert.match(
      field(form, key)?.querySelector('[data-settings-issue-code="full-spectrum-height-bounds-order"]')?.textContent ??
        '',
      /upper height bound.*greater than or equal/i,
    );
  }

  form.dispatchEvent(new harness.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(applies.length, 0, 'invalid cross-field state cannot reach the adapter');
  assert.match(form.querySelector('[data-settings-error]')?.textContent ?? '', /highlighted validation errors/i);

  setText(harness, control(form, 'mixed_filament_height_upper_bound'), '0.25');
  assert.equal(control(form, 'mixed_filament_height_lower_bound').getAttribute('aria-invalid'), 'false');
  assert.equal(control(form, 'mixed_filament_height_upper_bound').getAttribute('aria-invalid'), 'false');
  assert.equal(apply.disabled, false);
  apply.click();
  await settle();

  assert.equal(applies.length, 1);
  assert.deepEqual(
    applies[0].commit.changes.map((change) => [change.key, change.serialized]),
    [
      ['mixed_filament_height_lower_bound', '0.2'],
      ['mixed_filament_height_upper_bound', '0.25'],
    ],
  );
  assert.deepEqual(applies[0].commit.nextOverrides, {
    mixed_filament_height_lower_bound: 0.2,
    mixed_filament_height_upper_bound: 0.25,
  });
  panel.dispose();
});

await test('routes serialized mixed definitions to the structured editor without exposing a raw input', async () => {
  const harness = createDocument();
  const rawDefinitions = 'opaque,serialized,recipe-wire';
  const panel = new GeneratedSettingsPanel(
    harness.container,
    staticAdapter({
      revision: 40,
      sourceHash: 'hash-40',
      inherited: {},
      overrides: { mixed_filament_definitions: rawDefinitions },
    }),
    {
      initialMode: 'advanced',
      initialSearch: 'mixed filament definitions',
      loadCatalog: async () => catalog,
    },
  );
  await panel.mount();
  const form = harness.document.querySelector<HTMLFormElement>('[data-generated-settings-panel]')!;
  const definitions = field(form, 'mixed_filament_definitions')!;

  assert.equal(definitions.dataset.settingsSupport, 'structured-editor-required');
  assert.equal(definitions.querySelector('input, textarea, select'), null);
  assert.equal(
    definitions.querySelector<HTMLOutputElement>('[data-settings-structured-editor-target]')?.value,
    'Use the structured FullSpectrum recipe editor',
  );
  assert.match(
    definitions.querySelector('[data-settings-structured-editor]')?.textContent ?? '',
    /Raw serialized.*disabled/i,
  );
  assert.equal(
    definitions.textContent?.includes(rawDefinitions),
    false,
    'opaque recipe wire must not be rendered as text',
  );
  assert.equal(definitions.querySelector('[data-settings-reset-inherited]'), null);
  assert.equal(definitions.querySelector('[data-settings-reset-default]'), null);
  assert.equal(form.querySelector<HTMLButtonElement>('[data-settings-apply]')?.disabled, true);
  panel.dispose();
});

await test('validates drafts and sends one revision-guarded atomic apply or cancel request', async () => {
  const harness = createDocument();
  let snapshot: GeneratedSettingsPanelSnapshot = {
    revision: 7,
    sourceHash: 'hash-7',
    inherited: { layer_height: 0.24, wall_loops: 2 },
    overrides: { wall_loops: 3 },
  };
  const applies: GeneratedSettingsPanelApplyRequest[] = [];
  const cancels: GeneratedSettingsPanelCancelRequest[] = [];
  let rejectNextApply = false;
  const adapter: GeneratedSettingsPanelAdapter = {
    load: () => snapshot,
    apply: async (request) => {
      applies.push(request);
      if (rejectNextApply) throw new Error('stale settings revision');
      snapshot = {
        revision: snapshot.revision + 1,
        sourceHash: `hash-${snapshot.revision + 1}`,
        inherited: snapshot.inherited,
        overrides: request.commit.nextOverrides,
      };
      return snapshot;
    },
    cancel: async (request) => {
      cancels.push(request);
    },
  };
  const panel = new GeneratedSettingsPanel(harness.container, adapter, {
    initialMode: 'advanced',
    initialSearch: 'wall loops',
    loadCatalog: async () => catalog,
  });
  await panel.mount();
  const form = harness.document.querySelector<HTMLFormElement>('[data-generated-settings-panel]')!;
  const apply = form.querySelector<HTMLButtonElement>('[data-settings-apply]')!;

  setText(harness, control(form, 'wall_loops'), '4.2');
  assert.equal(control(form, 'wall_loops').getAttribute('aria-invalid'), 'true');
  assert.equal(apply.disabled, true);
  apply.click();
  await settle();
  assert.equal(applies.length, 0);

  setText(harness, control(form, 'wall_loops'), '4');
  search(harness, 'layer height');
  setText(harness, control(form, 'layer_height'), '-1');
  assert.equal(apply.disabled, true);
  setText(harness, control(form, 'layer_height'), '0.28');
  assert.equal(apply.disabled, false);
  apply.click();
  await settle();

  assert.equal(applies.length, 1);
  assert.equal(applies[0].expectedRevision, 7);
  assert.equal(applies[0].sourceHash, 'hash-7');
  assert.deepEqual(
    applies[0].commit.changes.map((change) => [change.key, change.action, change.serialized]),
    [
      ['layer_height', 'set', '0.28'],
      ['wall_loops', 'set', '4'],
    ],
  );
  assert.deepEqual(applies[0].commit.nextOverrides, { layer_height: 0.28, wall_loops: 4 });
  assert.match(form.querySelector('[data-settings-operation-status]')?.textContent ?? '', /Applied 2.*atomically/);
  assert.equal(form.querySelector('[data-settings-draft]'), null);

  setText(harness, control(form, 'layer_height'), '0.3');
  form.querySelector<HTMLButtonElement>('[data-settings-cancel]')!.click();
  await settle();
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].expectedRevision, 8);
  assert.equal(cancels[0].sourceHash, 'hash-8');
  assert.deepEqual(cancels[0].draftFieldIds, [catalog.get('layer_height').id]);
  assert.equal(control(form, 'layer_height').value, '0.28');
  assert.match(form.querySelector('[data-settings-operation-status]')?.textContent ?? '', /cancelled/);

  rejectNextApply = true;
  setText(harness, control(form, 'layer_height'), '0.31');
  apply.click();
  await settle();
  assert.equal(applies.length, 2);
  assert.equal(control(form, 'layer_height').value, '0.31');
  assert.ok(field(form, 'layer_height')?.querySelector('[data-settings-draft]'));
  assert.match(form.querySelector('[data-settings-error]')?.textContent ?? '', /No settings were applied.*stale/);
  panel.dispose();
});

await test('refreshes clean snapshots and preserves a dirty draft behind an explicit revision conflict', async () => {
  const harness = createDocument();
  let snapshot: GeneratedSettingsPanelSnapshot = {
    revision: 1,
    sourceHash: 'hash-1',
    inherited: { layer_height: 0.2 },
    overrides: {},
  };
  let notifyAuthorityChanged: (() => void) | undefined;
  let loadCount = 0;
  let unsubscribed = false;
  const adapter: GeneratedSettingsPanelAdapter = {
    load: () => {
      loadCount += 1;
      return snapshot;
    },
    subscribe: (listener) => {
      notifyAuthorityChanged = listener;
      return () => {
        unsubscribed = true;
      };
    },
    apply: () => {
      throw new Error('apply was not expected');
    },
    cancel: () => undefined,
  };
  const panel = new GeneratedSettingsPanel(harness.container, adapter, {
    initialSearch: 'layer height',
    loadCatalog: async () => catalog,
  });
  await panel.mount();
  const form = harness.document.querySelector<HTMLFormElement>('[data-generated-settings-panel]')!;
  assert.equal(control(form, 'layer_height').value, '0.2');

  snapshot = {
    revision: 2,
    sourceHash: 'hash-2',
    inherited: { layer_height: 0.25 },
    overrides: {},
  };
  notifyAuthorityChanged?.();
  await settle();
  assert.equal(loadCount, 2);
  assert.equal(control(form, 'layer_height').value, '0.25');
  assert.match(form.querySelector('[data-settings-operation-status]')?.textContent ?? '', /refreshed/);

  setText(harness, control(form, 'layer_height'), '0.3');
  snapshot = {
    revision: 3,
    sourceHash: 'hash-3',
    inherited: { layer_height: 0.28 },
    overrides: {},
  };
  notifyAuthorityChanged?.();
  await settle();
  assert.equal(loadCount, 2, 'a dirty draft is not overwritten by an authority notification');
  assert.equal(control(form, 'layer_height').value, '0.3');
  assert.equal(form.querySelector<HTMLElement>('[data-settings-conflict]')?.hidden, false);
  assert.match(form.querySelector('[data-settings-conflict-message]')?.textContent ?? '', /draft is preserved/i);
  assert.equal(form.querySelector<HTMLButtonElement>('[data-settings-apply]')?.disabled, true);

  form.querySelector<HTMLButtonElement>('[data-settings-conflict-reload]')!.click();
  await settle();
  assert.equal(loadCount, 3);
  assert.equal(control(form, 'layer_height').value, '0.28');
  assert.equal(form.querySelector<HTMLElement>('[data-settings-conflict]')?.hidden, true);
  assert.equal(form.querySelector('[data-settings-draft]'), null);
  assert.match(form.querySelector('[data-settings-operation-status]')?.textContent ?? '', /Discarded.*reloaded/);

  panel.dispose();
  assert.equal(unsubscribed, true);
});

await test('preserves expanded Local-Z drafts across authority conflict and discards them only on explicit reload', async () => {
  const harness = createDocument();
  let snapshot: GeneratedSettingsPanelSnapshot = {
    revision: 50,
    sourceHash: 'hash-50',
    inherited: {
      dithering_local_z_mode: false,
      dithering_local_z_infill: false,
    },
    overrides: {},
  };
  let notifyAuthorityChanged: (() => void) | undefined;
  let loadCount = 0;
  const applies: GeneratedSettingsPanelApplyRequest[] = [];
  const panel = new GeneratedSettingsPanel(
    harness.container,
    {
      load: () => {
        loadCount += 1;
        return snapshot;
      },
      subscribe: (listener) => {
        notifyAuthorityChanged = listener;
        return () => undefined;
      },
      apply: (request) => {
        applies.push(request);
        return snapshot;
      },
      cancel: () => undefined,
    },
    {
      initialMode: 'advanced',
      initialSearch: 'dithering_local_z_',
      loadCatalog: async () => catalog,
    },
  );
  await panel.mount();
  const form = harness.document.querySelector<HTMLFormElement>('[data-generated-settings-panel]')!;

  control(form, 'dithering_local_z_mode').click();
  assert.equal(control(form, 'dithering_local_z_mode').checked, true);
  assert.equal(control(form, 'dithering_local_z_infill').checked, true);
  assert.equal(control(form, 'dithering_local_z_infill').disabled, false);

  snapshot = {
    revision: 51,
    sourceHash: 'hash-51',
    inherited: {
      dithering_local_z_mode: false,
      dithering_local_z_infill: false,
    },
    overrides: {},
  };
  notifyAuthorityChanged?.();
  await settle();

  assert.equal(loadCount, 1);
  assert.equal(control(form, 'dithering_local_z_mode').checked, true);
  assert.equal(control(form, 'dithering_local_z_infill').checked, true);
  assert.equal(control(form, 'dithering_local_z_infill').disabled, false);
  assert.equal(form.querySelector<HTMLElement>('[data-settings-conflict]')?.hidden, false);
  assert.equal(form.querySelector<HTMLButtonElement>('[data-settings-apply]')?.disabled, true);
  form.dispatchEvent(new harness.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(applies.length, 0);

  form.querySelector<HTMLButtonElement>('[data-settings-conflict-reload]')!.click();
  await settle();
  assert.equal(loadCount, 2);
  assert.equal(control(form, 'dithering_local_z_mode').checked, false);
  assert.equal(control(form, 'dithering_local_z_infill').checked, false);
  assert.equal(control(form, 'dithering_local_z_infill').disabled, true);
  assert.equal(form.querySelector('[data-settings-draft]'), null);
  panel.dispose();
});

interface DocumentHarness {
  readonly dom: any;
  readonly document: Document;
  readonly container: HTMLElement;
}

function createDocument(): DocumentHarness {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', {
    url: 'https://example.test/',
  });
  const document = dom.window.document as Document;
  return { dom, document, container: document.querySelector<HTMLElement>('#host')! };
}

function staticAdapter(snapshot: GeneratedSettingsPanelSnapshot): GeneratedSettingsPanelAdapter {
  return {
    load: () => snapshot,
    apply: () => {
      throw new Error('apply was not expected');
    },
    cancel: () => undefined,
  };
}

function search(harness: DocumentHarness, value: string): void {
  const input = harness.document.querySelector<HTMLInputElement>('[data-settings-search]')!;
  input.value = value;
  input.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

function field(root: ParentNode, key: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-settings-key="${key}"]`);
}

function control(root: ParentNode, key: string): HTMLInputElement {
  return field(root, key)!.querySelector<HTMLInputElement>('[data-settings-control]')!;
}

function origin(root: ParentNode, key: string): string | undefined {
  return field(root, key)?.querySelector<HTMLElement>('[data-settings-origin]')?.dataset.settingsOrigin;
}

function setText(harness: DocumentHarness, input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

console.log(`\nGenerated settings DOM panel: ${passed} tests passed.`);
