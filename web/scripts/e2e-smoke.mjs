import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { startMoonrakerSimulator } from './moonraker-simulator.mjs';
import { launchBrowser, openReadyPage, startPreview } from './preview-harness.mjs';

async function writeMultiPlateFixture(directory) {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <resources>
    <object id="1" type="model"><components>
      <component objectid="101" p:path="/3D/Objects/alpha.model"/>
      <component objectid="103" p:path="/3D/Objects/alpha.model"/>
    </components></object>
    <object id="2" type="model"><components><component objectid="102" p:path="/3D/Objects/beta.model"/></components></object>
  </resources>
  <build><item objectid="1"/><item objectid="2"/></build>
</model>`;
  const alphaModel = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="101" type="model"><mesh><vertices>
      <vertex x="10" y="15" z="5"/><vertex x="20" y="15" z="5"/>
      <vertex x="10" y="25" z="5"/><vertex x="10" y="15" z="10"/>
    </vertices><triangles>
      <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
      <triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>
    </triangles></mesh></object>
    <object id="103" type="model"><mesh><vertices>
      <vertex x="10" y="15" z="5"/><vertex x="20" y="15" z="5"/>
      <vertex x="10" y="25" z="5"/><vertex x="10" y="15" z="10"/>
    </vertices><triangles>
      <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
      <triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>
    </triangles></mesh></object></resources><build/>
</model>`;
  const betaModel = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="102" type="model"><mesh><vertices>
      <vertex x="135" y="20" z="7"/><vertex x="145" y="20" z="7"/>
      <vertex x="135" y="30" z="7"/><vertex x="135" y="20" z="12"/>
    </vertices><triangles>
      <triangle v1="0" v2="2" v3="1" paint_color="4"/><triangle v1="0" v2="1" v3="3"/>
      <triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>
    </triangles></mesh></object></resources><build/>
</model>`;
  const settings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="1">
    <part id="101"><metadata key="extruder" value="1"/></part>
    <part id="103"><metadata key="extruder" value="1"/></part>
  </object>
  <object id="2"><part id="102"><metadata key="extruder" value="2"/></part></object>
  <plate><metadata key="plater_id" value="1"/><metadata key="plater_name" value="Alpha"/>
    <model_instance><metadata key="object_id" value="1"/><metadata key="instance_id" value="0"/></model_instance>
  </plate>
  <plate><metadata key="plater_id" value="2"/><metadata key="plater_name" value="Beta"/>
    <model_instance><metadata key="object_id" value="2"/><metadata key="instance_id" value="0"/></model_instance>
  </plate>
</config>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="application/octet-stream"/>
</Types>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  const project = JSON.stringify({
    printable_area: ['0x0', '100x0', '100x100', '0x100'],
    filament_colour: ['#ff0000', '#0000ff'],
    filament_type: ['PLA', 'PLA'],
  });
  const bytes = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(relationships),
    '3D/3dmodel.model': strToU8(model),
    '3D/Objects/alpha.model': strToU8(alphaModel),
    '3D/Objects/beta.model': strToU8(betaModel),
    'Metadata/model_settings.config': strToU8(settings),
    'Metadata/project_settings.config': strToU8(project),
  });
  const path = join(directory, 'multi-plate-fixture.3mf');
  await writeFile(path, bytes);
  return path;
}

/** Two named OBJ objects, the second split across two material sections. */
async function writeObjFixture(directory) {
  // Two closed tetrahedra: one large centred target for pointer painting and a
  // second object that proves multi-object structure and material parts.
  const source = [
    'o Wedge',
    'usemtl shell',
    'v -30 -30 0',
    'v 30 -30 0',
    'v 0 30 0',
    'v 0 0 45',
    'f 1 3 2',
    'f 1 2 4',
    'f 2 3 4',
    'f 3 1 4',
    'o Riser',
    'usemtl core',
    'v 60 -10 0',
    'v 80 -10 0',
    'v 70 10 0',
    'v 70 0 18',
    'f 5 7 6',
    'f 5 6 8',
    'f 6 7 8',
    'f 7 5 8',
    '',
  ].join('\n');
  const path = join(directory, 'two-objects.obj');
  await writeFile(path, strToU8(source));
  return path;
}

/** Two-layer G-code with extrusion, travel, and a tool change. */
async function writeGcodeFixture(directory) {
  const source = [
    '; generated by the OrcaXR smoke fixture',
    'M104 S210',
    'G21',
    'G90',
    'M83',
    ';LAYER_CHANGE',
    ';Z:0.2',
    'G1 Z0.2 F600',
    ';TYPE:Outer wall',
    'G1 X20 Y20 F3000',
    'G1 X60 Y20 E2.4 F1200',
    'G1 X60 Y60 E2.4',
    'G1 X20 Y60 E2.4',
    ';LAYER_CHANGE',
    ';Z:0.4',
    'G1 Z0.4 F600',
    'T1',
    ';TYPE:Inner wall',
    'G1 X20 Y20 F3000',
    'G1 X60 Y20 E2.4 F900',
    '',
  ].join('\n');
  const path = join(directory, 'preview-fixture.gcode');
  await writeFile(path, strToU8(source));
  return path;
}

/**
 * Standalone G-code opens read-only in the viewer, and every preview control
 * comes from the projection: modes, the layer window, move filters, and a
 * legend whose entries carry a code plus text.
 */
async function inspectStandaloneGcode(page, fixture) {
  await showInspectorTab(page, 'preview');
  await page.evaluate(() => {
    globalThis.document
      .querySelector('[data-gcode-preview-panel="true"]')
      ?.closest('details')
      ?.setAttribute('open', '');
  });
  const beforeRevision = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().revision);
  const [chooser] = await Promise.all([
    page.waitForFileChooser(),
    page.evaluate(() => globalThis.window.workspace.onRequestOpenGcode?.()),
  ]);
  await chooser.accept([fixture]);
  await page.waitForFunction(() => globalThis.window.workspace.getPreviewState().active === true, { timeout: 30_000 });

  const opened = await page.evaluate(() => globalThis.window.workspace.getPreviewState());
  assert.equal(opened.source.kind, 'file');
  assert.match(opened.source.name, /preview-fixture\.gcode$/);
  assert.equal(opened.view.mode, 'FeatureType');
  assert.ok(opened.legend.length > 0, 'the feature-type legend is populated');
  assert.ok(
    opened.legend.every((entry) => entry.code.length > 0 && entry.accessibleLabel.length > 0),
    'legend entries never rely on colour alone',
  );
  // The fixture's tool change is located for the viewer, but an opened file is
  // not this project's artifact, so nothing here may author into the project.
  assert.deepEqual(
    opened.ticks.map((tick) => [tick.kind, tick.layer]),
    [['tool-change', 2]],
  );
  assert.equal(
    await page.$eval('[data-preview-ticks="true"]', (group) => group.querySelectorAll('[data-preview-tick]').length),
    1,
  );
  assert.equal(await page.$('[data-preview-author-events="true"]'), null);
  assert.equal(
    await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().revision),
    beforeRevision,
    'opening G-code never mutates the canonical project',
  );

  // Switching to a numeric mode reports its unit and range.
  await page.evaluate(() => {
    const select = globalThis.document.querySelector('[data-preview-mode="true"]');
    select.value = 'Feedrate';
    select.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => globalThis.window.workspace.getPreviewState().view.mode === 'Feedrate');
  const speed = await page.evaluate(() => globalThis.window.workspace.getPreviewState());
  assert.equal(speed.range.unit, 'mm/s');
  assert.ok(speed.range.max >= speed.range.min);

  // Single-layer mode collapses the window onto the top layer.
  await page.evaluate(() => {
    const checkbox = globalThis.document.querySelector('[data-preview-single-layer="true"]');
    checkbox.checked = true;
    checkbox.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => globalThis.window.workspace.getPreviewState().view.singleLayer === true);
  const single = await page.evaluate(() => globalThis.window.workspace.getPreviewState());
  assert.equal(single.view.layerRange[0], single.view.layerRange[1]);
  assert.match(single.layerLabel ?? '', /layer/i);

  // Travel starts hidden and can be shown.
  assert.equal(single.view.moveVisibility.travel, false);
  await page.evaluate(() => {
    const travel = globalThis.document.querySelector('[data-preview-move-filter="travel"]');
    travel.checked = true;
    travel.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => globalThis.window.workspace.getPreviewState().view.moveVisibility.travel === true);

  await page.evaluate(() => globalThis.window.workspace.togglePreview());
  await page.waitForFunction(() => globalThis.window.workspace.getPreviewState().active === false);
}

/** Add-instance and fill-bed create shared instances in single commands. */
async function fillPlateWithInstances(page) {
  const before = await page.evaluate(
    () => globalThis.window.workspace.getAutomationSnapshot().placedModelsTotalAllPlates,
  );
  await clickMenuAction(page, 'add_instance');
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getAutomationSnapshot().placedModelsTotalAllPlates === count + 1,
    {},
    before,
  );
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getAutomationSnapshot().placedModelsTotalAllPlates === count,
    {},
    before,
  );

  await clickMenuAction(page, 'fill_bed_with_instances');
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getAutomationSnapshot().placedModelsTotalAllPlates > count,
    {},
    before,
  );
  const filled = await page.evaluate(
    () => globalThis.window.workspace.getAutomationSnapshot().placedModelsTotalAllPlates,
  );
  assert.ok(filled > before + 1, 'filling the bed adds several copies');
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getAutomationSnapshot().placedModelsTotalAllPlates === count,
    {},
    before,
  );
}

/** Mirror and centre run as canonical commands through the Edit menu. */
async function transformImportedModels(page) {
  const instance = await page.evaluate(
    () => globalThis.window.workspace.getCanonicalSummary().selectedInstanceIds[0] ?? null,
  );
  assert.ok(instance, 'the imported model is selected after import');
  const scaleBefore = await page.evaluate((id) => globalThis.window.workspace.getInstanceTransform(id).scale, instance);
  await clickMenuAction(page, 'mirror_x');
  await page.waitForFunction((id) => globalThis.window.workspace.getInstanceTransform(id).scale[0] < 0, {}, instance);
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    ({ id, expected }) => globalThis.window.workspace.getInstanceTransform(id).scale[0] === expected,
    {},
    { id: instance, expected: scaleBefore[0] },
  );

  await clickMenuAction(page, 'center_on_plate');
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getCanonicalSummary().history.undoCount === count,
    {},
    await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history.undoCount),
  );
  await clickMenuAction(page, 'edit_undo');
}

/** Auto-arrange is one canonical command over the real menu action. */
async function arrangeImportedModels(page) {
  const before = await page.evaluate(() =>
    [...globalThis.window.workspace.getObjectsTreeSnapshot().projection.rowsByKey.values()]
      .filter((row) => row.kind === 'instance' && row.entity?.kind === 'instance')
      .map((row) => row.entity.id),
  );
  assert.ok(before.length >= 2, 'the arrange fixture needs at least two instances');
  const undoBefore = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history.undoCount);
  await clickMenuAction(page, 'arrange_all');
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getCanonicalSummary().history.undoCount === count + 1,
    {},
    undoBefore,
  );
  assert.match(
    (await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history.undoLabel)) ?? '',
    /transform/i,
    'arrangement commits one labelled transform command',
  );
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getCanonicalSummary().history.undoCount === count,
    {},
    undoBefore,
  );
}

/** Dropping a file anywhere over the app loads it through the same intake. */
async function dropModelFile(page, fixture) {
  const before = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().objectCount);
  const bytes = Array.from(await readFile(fixture));
  await page.evaluate(
    async ({ name, data }) => {
      const file = new globalThis.File([new Uint8Array(data)], name, { type: 'model/obj' });
      const transfer = new globalThis.DataTransfer();
      transfer.items.add(file);
      globalThis.window.dispatchEvent(new globalThis.DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
      globalThis.window.dispatchEvent(new globalThis.DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    },
    { name: 'dropped.obj', data: bytes },
  );
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getCanonicalSummary().objectCount > count,
    { timeout: 60_000 },
    before,
  );
  assert.equal(
    await page.$eval('[data-file-drop-overlay="true"]', (node) => node.hidden),
    true,
    'the drop affordance clears after the drop',
  );
  await page.evaluate(() => globalThis.window.workspace.undo?.());
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getCanonicalSummary().objectCount === count,
    { timeout: 30_000 },
    before,
  );
}

/**
 * Sweep the viewport until a real pointer gesture lands on the model. The
 * renderer fills the window but the docked chrome covers its edges, so the
 * plate is centred on the visible viewport, not on the canvas.
 */
async function paintAtFirstHit(page) {
  const canvas = await page.$('canvas');
  assert.ok(canvas, 'the workspace canvas exists');
  const viewport = await page.$('#viewport');
  assert.ok(viewport, 'the workspace viewport exists');
  const box = await viewport.boundingBox();
  for (let radius = 0; radius <= 120; radius += 24) {
    for (const [dx, dy] of [
      [0, 0],
      [radius, 0],
      [-radius, 0],
      [0, radius],
      [0, -radius],
    ]) {
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
      await page.mouse.down();
      await page.mouse.up();
      const facets = await page.evaluate(() => globalThis.window.workspace.getPaintedFacetCount?.() ?? 0);
      if (facets > 0) return facets;
    }
  }
  return 0;
}

/**
 * The inspector is tabbed, so a panel that is not on the active tab is hidden.
 * A real user selects the tab before touching the controls inside it; every
 * step below reaches its panel the same way.
 */
async function showInspectorTab(page, tabId) {
  await page.evaluate((id) => {
    const tab = globalThis.document.querySelector(`[data-inspector-tab="${id}"]`);
    if (!tab) throw new Error(`missing inspector tab ${id}`);
    tab.click();
  }, tabId);
}

async function clickPanelControl(page, selector) {
  await page.evaluate((target) => {
    const control = globalThis.document.querySelector(target);
    if (!control) throw new Error(`missing control ${target}`);
    control.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
  }, selector);
  // Panel refresh and the canonical command bus both settle in microtasks.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Smart Paint's consent gate in the production build. No assistant is
 * configured here on purpose: the point is to prove that the panel is mounted
 * and registry-routed, that nothing can be sent before explicit consent and a
 * prompt exist, and that a provider failure is reported honestly while the
 * canonical project stays exactly as it was.
 */
async function smartPaintConsentGate(page) {
  // Smart Paint targets exactly one part, so the flow starts by selecting one.
  await showInspectorTab(page, 'objects');
  const objects = await page.evaluate(() => {
    const snapshot = globalThis.window.workspace.getObjectsTreeSnapshot();
    return [...snapshot.projection.rowsByKey.values()]
      .filter((row) => row.kind === 'object' && row.entity?.kind === 'object')
      .map((row) => ({ key: row.key, id: row.entity.id }));
  });
  assert.ok(objects.length >= 1, 'the Smart Paint gate needs at least one object');
  await page.evaluate((key) => {
    const row = [...globalThis.document.querySelectorAll('[data-objects-row-key]')].find(
      (candidate) => candidate.dataset.objectsRowKey === key,
    );
    row?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
  }, objects[0].key);
  await page.waitForFunction(
    (id) => globalThis.window.workspace.getObjectsTreeSnapshot().selection.primary?.id === id,
    {},
    objects[0].id,
  );

  await showInspectorTab(page, 'filament');
  await page.evaluate(() => {
    globalThis.document.querySelector('[data-smart-paint-panel="true"]')?.closest('details')?.setAttribute('open', '');
  });
  const panel = await page.$('[data-smart-paint-panel="true"]');
  assert.ok(panel, 'the Smart Paint panel is mounted');
  assert.equal(
    await page.evaluate(() => globalThis.window.workspace.getSmartPaintSnapshot().unavailableReason),
    undefined,
    'one selected part puts Smart Paint in scope',
  );

  const askDisabled = () => page.$eval('[data-smart-paint-action="smart-paint-request"]', (button) => button.disabled);
  assert.equal(await askDisabled(), true, 'asking is blocked before consent and a prompt exist');

  const before = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history);

  await page.evaluate(() => {
    const consent = globalThis.document.querySelector('[data-smart-paint-consent-key="geometry"]');
    consent.checked = true;
    consent.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
    const prompt = globalThis.document.querySelector('[data-smart-paint-prompt]');
    prompt.value = 'the top surface';
    prompt.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const snapshot = await page.evaluate(() => globalThis.window.workspace.getSmartPaintSnapshot());
  assert.equal(snapshot.consent.geometry, true, 'consent is recorded canonically, not in the DOM alone');
  assert.equal(snapshot.consent.image, false, 'image consent stays separate and off');
  assert.equal(snapshot.prompt, 'the top surface');
  assert.equal(await askDisabled(), false, 'consent plus a prompt unlocks the request');

  // No API key is configured, so the provider boundary must fail honestly.
  await clickPanelControl(page, '[data-smart-paint-action="smart-paint-request"]');
  await page.waitForFunction(() => globalThis.window.workspace.getSmartPaintSnapshot().busy === false, {
    timeout: 30_000,
  });
  const failed = await page.evaluate(() => globalThis.window.workspace.getSmartPaintSnapshot());
  assert.ok(failed.error, 'an unconfigured assistant reports a reason instead of failing silently');
  assert.equal(failed.preview, undefined, 'a failed request produces no mask');
  assert.deepEqual(
    await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history),
    before,
    'a failed Smart Paint request leaves canonical history untouched',
  );

  await clickPanelControl(page, '[data-smart-paint-action="smart-paint-cancel"]');
}

/**
 * Colour painting through the real surfaces: the registry-routed paint panel
 * configures the stroke and a genuine pointer gesture on the canvas commits
 * canonical facet annotations that undo cleanly.
 */
async function paintImportedModel(page) {
  const paintPanel = await page.$('[data-paint-panel="true"]');
  assert.ok(paintPanel, 'the colour paint panel is mounted');
  // The panel lives in a collapsed inspector section; a user expands it first.
  await showInspectorTab(page, 'filament');
  await page.evaluate(() => {
    globalThis.document.querySelector('[data-paint-panel="true"]')?.closest('details')?.setAttribute('open', '');
  });
  await clickPanelControl(page, '[data-paint-activate="true"]');
  assert.equal(
    await page.$eval('[data-paint-activate="true"]', (button) => button.getAttribute('aria-pressed')),
    'true',
    'activating the paint tool reports pressed state',
  );
  await clickPanelControl(page, '[data-paint-tool="triangle"]');
  const swatches = await page.$$eval('[data-paint-swatch]', (buttons) =>
    buttons.map((button) => ({
      id: button.dataset.paintSwatch,
      disabled: button.disabled,
      label: button.getAttribute('aria-label'),
    })),
  );
  const target = swatches.find((swatch) => swatch.id !== 'default' && !swatch.disabled);
  assert.ok(target, 'at least one paintable filament swatch is offered');
  assert.match(target.label ?? '', /T\d/, 'swatch labels carry a non-colour badge');
  await clickPanelControl(page, `[data-paint-swatch="${target.id}"]`);

  const painted = await paintAtFirstHit(page);
  assert.ok(painted > 0, 'a pointer stroke painted canonical colour facets');

  // Support painting shares the same gesture, panel, and command path.
  await clickPanelControl(page, '[data-paint-channel="support"]');
  await clickPanelControl(page, '[data-paint-channel-state="block"]');
  const supportState = await page.evaluate(() => globalThis.window.workspace.getPaintToolState());
  assert.equal(supportState.channel, 'support');
  assert.equal(supportState.channelState, 'block');
  assert.equal(supportState.active, true, 'switching channel keeps a paint tool active');
  const supportPainted = await paintAtFirstHit(page);
  assert.ok(supportPainted > 0, 'a support stroke painted canonical facets');
  assert.match(
    (await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history.undoLabel)) ?? '',
    /support/i,
  );
  await page.evaluate(() => globalThis.window.workspace.undo?.());
  await clickPanelControl(page, '[data-paint-channel="color"]');

  const historyLabel = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history.undoLabel);
  assert.match(historyLabel ?? '', /paint/i, 'the stroke is one labelled undoable command');
  await page.evaluate(() => globalThis.window.workspace.undo?.());
  await page.waitForFunction(() => (globalThis.window.workspace.getPaintedFacetCount?.() ?? -1) === 0, {
    timeout: 15_000,
  });
  await page.evaluate(() => globalThis.window.workspace.redo?.());
  await page.waitForFunction(() => (globalThis.window.workspace.getPaintedFacetCount?.() ?? 0) > 0, {
    timeout: 15_000,
  });
  await page.evaluate(() => globalThis.window.workspace.undo?.());
  // The rail collapses once a model loads, so drive its action directly.
  await clickPanelControl(page, '#left-toolbar [data-action-id="tool_move"]');
  await page.waitForFunction(() => globalThis.window.__orcaUi.get().activeTool === 'move');
}

/**
 * The preview closes the authoring loop: the artifact's own events appear as
 * located ticks, and the layer on screen supplies the exact height for a new
 * one. Authoring drops the published artifact on purpose — it no longer matches
 * the project — so the preview closing is the assertion, not a surprise.
 */
async function inspectAndAuthorFromPreview(page) {
  await showInspectorTab(page, 'preview');
  await page.evaluate(() => {
    globalThis.document
      .querySelector('[data-gcode-preview-panel="true"]')
      ?.closest('details')
      ?.setAttribute('open', '');
  });
  // A successful slice already opens the preview; only ask for it when it is
  // closed, or the toggle would close the very view under test.
  await page.evaluate(() => {
    if (!globalThis.window.workspace.getPreviewState().active) globalThis.window.workspace.togglePreview();
  });
  await page.waitForFunction(() => globalThis.window.workspace.getPreviewState().active === true, { timeout: 60_000 });

  // The engine's own totals for this artifact, read rather than recomputed.
  const summary = await page.evaluate(() => globalThis.window.workspace.getPreviewState().summary);
  assert.ok(summary, 'the sliced artifact carries the engine totals');
  assert.equal(summary.layerCount, 225);
  assert.ok(summary.estimatedSeconds > 0, 'an estimated print time is reported');
  assert.ok(summary.totalWeightG > 0, 'a total weight is reported');
  assert.equal(summary.perTool.length, 4, 'one row per declared filament');
  assert.deepEqual(
    summary.perTool.filter((tool) => (tool.lengthMm ?? 0) > 0).map((tool) => tool.toolIndex),
    [0, 1],
    'only the two tools this plate uses report filament',
  );
  const totalsText = await page.$eval('[data-preview-summary-totals]', (node) => node.textContent ?? '');
  assert.match(totalsText, /225 layers/);
  assert.match(totalsText, /≈\d/);
  assert.deepEqual(
    await page.$$eval('[data-preview-summary-tool]', (rows) =>
      rows.map((row) => [row.dataset.previewSummaryTool, /PLA/.test(row.textContent ?? '')]),
    ),
    [
      ['0', true],
      ['1', true],
    ],
  );

  const ticks = await page.evaluate(() => globalThis.window.workspace.getPreviewState().ticks);
  const pause = ticks.find((tick) => tick.kind === 'pause');
  assert.ok(pause, `the authored pause appears as a located tick: ${JSON.stringify(ticks)}`);
  // The engine applies an event to the first layer at or above the authored
  // height, and the tick reports the height that layer prints at.
  assert.ok(
    pause.zMm >= 3.4 && pause.zMm < 3.4 + 0.25,
    `the tick sits on the first layer at or above 3.4 mm, got ${pause.zMm}`,
  );
  assert.match(
    await page.$eval('[data-preview-tick="pause"] button', (button) => button.textContent ?? ''),
    /layer \d+ \(3\.4\d mm\)/,
  );

  // Choosing a tick moves the layer window to it.
  await page.evaluate(() => globalThis.document.querySelector('[data-preview-tick="pause"] button').click());
  await page.waitForFunction(
    (layer) => {
      const view = globalThis.window.workspace.getPreviewState().view;
      return view.singleLayer && view.layerRange[0] === layer && view.layerRange[1] === layer;
    },
    { timeout: 30_000 },
    pause.layer,
  );

  const authoring = await page.$eval('[data-preview-author-events="true"]', (group) => ({
    label: group.querySelector('span')?.textContent,
    buttons: [...group.querySelectorAll('[data-preview-author-event]')].map((button) => [
      button.dataset.previewAuthorEvent,
      button.disabled,
    ]),
  }));
  assert.match(authoring.label ?? '', /^At 3\.4\d mm:$/);
  assert.deepEqual(authoring.buttons, [
    ['pause', false],
    ['custom', false],
  ]);

  const before = await page.evaluate(() => globalThis.window.workspace.getLayerEventSnapshot().events.length);
  await page.evaluate(() => globalThis.document.querySelector('[data-preview-author-event="custom"]').click());
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getLayerEventSnapshot().events.length === count + 1,
    { timeout: 30_000 },
    before,
  );
  const authored = await page.evaluate(() =>
    globalThis.window.workspace.getLayerEventSnapshot().events.map((row) => [row.event.type, row.event.topZMm]),
  );
  assert.equal(authored.length, 2);
  assert.ok(
    authored.some(([type, z]) => type === 'custom' && Math.abs(z - pause.zMm) < 0.001),
    `the new event took the layer's own height: ${JSON.stringify(authored)}`,
  );
  // Authoring changed the project, so the artifact it was viewing is gone.
  await page.waitForFunction(() => globalThis.window.__orcaUi.get().gcodeReady === false, { timeout: 30_000 });
  assert.equal(await page.evaluate(() => globalThis.window.workspace.getPreviewState().active), false);

  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (count) => globalThis.window.workspace.getLayerEventSnapshot().events.length === count,
    { timeout: 30_000 },
    before,
  );
}

/**
 * Author a pause through the real panel. The height is what the engine
 * resolves against its own layers, so the assertion after slicing is that the
 * emitted G-code actually pauses — not merely that the project stored a row.
 */
async function authorLayerPause(page) {
  await showInspectorTab(page, 'preview');
  await page.$eval('#layer-event-host', (host) => host.closest('details')?.setAttribute('open', ''));
  await page.waitForSelector('[data-layer-event-panel="true"]');
  assert.equal(
    await page.$eval('[data-layer-event-empty]', (node) => node.textContent),
    'No layer events on this plate.',
  );
  const options = await page.$$eval('[data-layer-event-option]', (nodes) =>
    nodes.map((node) => [node.dataset.layerEventOption, node.disabled]),
  );
  assert.deepEqual(
    options.filter(([, disabled]) => !disabled).map(([type]) => type),
    ['pause', 'custom'],
    'only the event kinds this printer profile can perform are offered',
  );

  await page.evaluate(() => {
    const document = globalThis.document;
    document.querySelector('[data-layer-event-type="true"]').value = 'pause';
    document.querySelector('[data-layer-event-type="true"]').dispatchEvent(new globalThis.Event('change'));
    document.querySelector('[data-layer-event-height="true"]').value = '3.4';
    document.querySelector('[data-layer-event-detail="true"]').value = 'Insert the magnet';
    document.querySelector('[data-layer-event-add="true"]').click();
  });
  await page.waitForFunction(() => globalThis.window.workspace.getLayerEventSnapshot().events.length === 1, {
    timeout: 30_000,
  });
  const authored = await page.evaluate(() => globalThis.window.workspace.getLayerEventSnapshot().events[0]);
  assert.deepEqual(authored.event, { type: 'pause', topZMm: 3.4, message: 'Insert the magnet' });
  assert.match(
    await page.$eval('[data-layer-event-row]', (row) => row.textContent ?? ''),
    /Pause at 3\.40 mm — Insert the magnet/,
  );
  await page.$eval('#layer-event-host', (host) => host.closest('details')?.removeAttribute('open'));
}

/**
 * The whole multicolor output path in one pass: assign a second filament to a
 * second object through the Objects panel, slice the plate, then send it to a
 * Moonraker printer. Every safety property that guards a real machine is
 * asserted against a real HTTP printer: a tool the printer cannot supply blocks
 * starting, uploading is separate from printing, an existing name is never
 * replaced silently, and the stored bytes match the artifact exactly.
 */
async function sliceAndSendActivePlate(page, printer) {
  const objects = await page.evaluate(() => {
    const snapshot = globalThis.window.workspace.getObjectsTreeSnapshot();
    return [...snapshot.projection.rowsByKey.values()]
      .filter((row) => row.kind === 'object' && row.entity?.kind === 'object')
      .map((row) => ({ key: row.key, id: row.entity.id }));
  });
  assert.ok(objects.length >= 2, 'the multicolor send fixture needs two objects');
  await page.evaluate((key) => {
    const row = [...globalThis.document.querySelectorAll('[data-objects-row-key]')].find(
      (candidate) => candidate.dataset.objectsRowKey === key,
    );
    row?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
  }, objects[1].key);
  await page.waitForFunction(
    (id) => globalThis.window.workspace.getObjectsTreeSnapshot().selection.primary?.id === id,
    {},
    objects[1].id,
  );

  // Every tool slot must start on the same material: the engine refuses to
  // slice filaments whose temperatures are far apart, so a mixed default
  // palette would make two-colour printing impossible out of the box.
  const filaments = await page.evaluate(() =>
    globalThis.window.workspace
      .getFilamentAssignmentSnapshot()
      .options.filter((option) => option.kind === 'physical')
      .map((option) => ({ id: option.id, material: option.material })),
  );
  assert.ok(filaments.length >= 2, 'the printer profile offers at least two filament slots');
  assert.equal(
    new Set(filaments.map((filament) => filament.material)).size,
    1,
    'unrequested filament slots inherit the selected material',
  );
  await page.evaluate((id) => {
    const radio = [...globalThis.document.querySelectorAll('[data-filament-assignment-kind="filament"]')].find(
      (candidate) => candidate.dataset.filamentId === id,
    );
    radio?.click();
    globalThis.document.querySelector('[data-filament-assignment-apply="true"]')?.click();
  }, filaments[1].id);
  await page.waitForFunction(
    ({ id, filamentId }) =>
      globalThis.window.workspace
        .getFilamentAssignmentSnapshot()
        .scopes.some((scope) => scope.objectId === id && scope.localFilamentId === filamentId),
    { timeout: 30_000 },
    { id: objects[1].id, filamentId: filaments[1].id },
  );

  await authorLayerPause(page);

  await page.click('#action-panel [data-action-id="slice_active_plate"]');
  await page.waitForFunction(() => globalThis.window.__orcaUi.get().gcodeReady === true, { timeout: 600_000 });
  const artifact = await page.evaluate(() => {
    const gcode = globalThis.window.workspace.getLastGcode() ?? '';
    const bytes = new globalThis.TextEncoder().encode(gcode);
    let checksum = 5381;
    for (const byte of bytes) checksum = ((checksum * 33) ^ byte) >>> 0;
    return {
      byteLength: bytes.byteLength,
      checksum,
      tools: [...new Set([...gcode.matchAll(/^T(\d+)\b/gm)].map((match) => Number(match[1])))].sort(),
      colours: /^; filament_colour = (.+)$/m.exec(gcode)?.[1].split(';') ?? [],
      types: /^; filament_type = (.+)$/m.exec(gcode)?.[1].split(';') ?? [],
      pauses: (gcode.match(/^;PAUSE_PRINT$/gm) ?? []).length,
      pauseBody: /^;PAUSE_PRINT\n(.+)$/m.exec(gcode)?.[1] ?? '',
    };
  });
  assert.deepEqual(artifact.tools, [0, 1], 'the assigned second filament reaches the G-code as a second tool');
  assert.ok(artifact.colours.length >= 2 && artifact.types.length >= 2, 'the artifact declares its filaments');
  assert.equal(artifact.pauses, 1, 'the authored pause reaches the engine and appears once in the G-code');
  assert.equal(artifact.pauseBody, 'M600', 'the pause emits the body this printer profile declares');

  await showInspectorTab(page, 'printer');
  await page.$eval('#printer-panel', (panel) => panel.closest('details')?.setAttribute('open', ''));
  await page.$eval(
    '#printer-host',
    (input, value) => {
      input.value = value;
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    },
    printer.host,
  );
  assert.equal(await page.$eval('#btn-printer-send', (button) => button.disabled), false);

  // A printer that cannot supply T1 must not be startable, and cancelling must
  // leave the machine untouched.
  printer.setSlots([{ color: artifact.colours[0], material: artifact.types[0] }]);
  await showInspectorTab(page, 'printer');
  await page.click('#btn-printer-send');
  await page.waitForSelector('[data-print-submission-dialog="true"]', { timeout: 60_000 });
  const blocked = await page.$eval('[data-print-submission-dialog="true"]', (overlay) => ({
    notices: [...overlay.querySelectorAll('[data-print-submission-notice]')].map((notice) => ({
      kind: notice.dataset.printSubmissionNotice,
      text: notice.textContent,
    })),
    startDisabled: overlay.querySelector('[data-print-submission-choice="upload-and-print"]').disabled,
    uploadDisabled: overlay.querySelector('[data-print-submission-choice="upload"]').disabled,
  }));
  assert.equal(blocked.startDisabled, true, 'a missing filament slot blocks starting the print');
  assert.equal(blocked.uploadDisabled, false, 'the file can still be stored for later');
  assert.match(blocked.notices.find((notice) => notice.kind === 'blocker')?.text ?? '', /T1/);
  await page.click('[data-print-submission-choice="cancel"]');
  await page.waitForFunction(() => !globalThis.document.querySelector('[data-print-submission-dialog="true"]'));
  assert.equal(printer.stored.size, 0, 'a cancelled send uploads nothing');
  assert.equal(printer.started, null);

  // With both tools loaded, uploading is still a separate decision from
  // starting, and the stored bytes must equal the artifact exactly.
  printer.setSlots(artifact.colours.slice(0, 2).map((color, index) => ({ color, material: artifact.types[index] })));
  await showInspectorTab(page, 'printer');
  await page.click('#btn-printer-send');
  await page.waitForSelector('[data-print-submission-dialog="true"]', { timeout: 60_000 });
  const ready = await page.$eval('[data-print-submission-dialog="true"]', (overlay) => ({
    text: overlay.textContent,
    notices: overlay.querySelectorAll('[data-print-submission-notice]').length,
    focused: globalThis.document.activeElement?.dataset?.printSubmissionChoice,
  }));
  assert.equal(ready.notices, 0, 'a matching printer reports no blockers or warnings');
  assert.match(ready.text, /2 tools \(T0, T1\)/);
  assert.equal(ready.focused, 'upload', 'focus never lands on the button that moves the machine');
  await page.click('[data-print-submission-choice="upload"]');
  await page.waitForFunction(() => /^Uploaded /.test(globalThis.document.getElementById('status-text')?.textContent));
  const [storedName] = [...printer.stored.keys()];
  assert.equal(printer.started, null, 'uploading alone never starts a print');
  assert.equal(checksumOf(printer.stored.get(storedName)), artifact.checksum);
  assert.equal(printer.stored.get(storedName).length, artifact.byteLength);

  // The same plate sent again must not replace the stored file, and starting
  // is what the operator explicitly asked for this time.
  await showInspectorTab(page, 'printer');
  await page.click('#btn-printer-send');
  await page.waitForSelector('[data-print-submission-dialog="true"]', { timeout: 60_000 });
  await page.click('[data-print-submission-choice="upload-and-print"]');
  await page.waitForFunction(() => /^Printing /.test(globalThis.document.getElementById('status-text')?.textContent));
  assert.equal(printer.stored.size, 2, 'the second send picked an unused name');
  assert.notEqual(printer.started, storedName);
  assert.equal(checksumOf(printer.stored.get(printer.started)), artifact.checksum);
  assert.match(
    await page.evaluate(() => globalThis.document.getElementById('status-text').textContent),
    /verified on the printer/,
  );

  await controlRunningPrint(page, printer);
  await inspectAndAuthorFromPreview(page);

  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(() => globalThis.window.workspace.getLayerEventSnapshot().events.length === 0, {
    timeout: 30_000,
  });
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (id) =>
      globalThis.window.workspace
        .getFilamentAssignmentSnapshot()
        .scopes.every((scope) => scope.objectId !== id || scope.localFilamentId === undefined),
    {},
    objects[1].id,
  );
  // Leave the inspector as it was found: later steps click controls by
  // coordinate, and an extra expanded section moves them.
  await page.$eval('#printer-panel', (panel) => panel.closest('details')?.removeAttribute('open'));
}

/**
 * The live job readout and its lifecycle controls, driven the way an operator
 * would: the panel reflects what the machine reports, pause/resume act
 * immediately, and both irreversible commands stop at a confirmation that
 * sends nothing when dismissed.
 */
async function controlRunningPrint(page, printer) {
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-print-job-state]')?.dataset.printJobState === 'printing',
    { timeout: 30_000 },
  );
  const live = await page.evaluate(() => ({
    headline: globalThis.document.querySelector('[data-print-job-state]')?.textContent,
    progress: globalThis.document.querySelector('[data-print-job-progress-label]')?.textContent,
    layer: globalThis.document.querySelector('[data-print-job-field="layer"]')?.textContent,
    nozzle: globalThis.document.querySelector('[data-print-job-field="nozzle"]')?.textContent,
    commands: [...globalThis.document.querySelectorAll('[data-print-job-command]')].map((button) => [
      button.dataset.printJobCommand,
      button.disabled,
    ]),
  }));
  assert.match(live.headline ?? '', /^Printing /);
  assert.match(live.progress ?? '', /%/);
  assert.equal(live.layer, '11 / 98');
  assert.match(live.nozzle ?? '', /219\.6 °C → 220 °C/);
  assert.deepEqual(live.commands, [
    ['pause', false],
    ['resume', true],
    ['cancel', false],
    ['emergency-stop', false],
  ]);

  // A change made at the machine itself must reach this panel: the printer
  // pushes it, nothing here polls for it, and the controls re-derive from it.
  printer.setState({ printState: 'paused' });
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-print-job-state]')?.dataset.printJobState === 'paused',
    { timeout: 30_000 },
  );
  assert.deepEqual(
    await page.$$eval('[data-print-job-command]', (buttons) =>
      buttons.map((button) => [button.dataset.printJobCommand, button.disabled]),
    ),
    [
      ['pause', true],
      ['resume', false],
      ['cancel', false],
      ['emergency-stop', false],
    ],
    'controls follow the machine, not this client',
  );
  printer.setState({ printState: 'printing' });
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-print-job-state]')?.dataset.printJobState === 'printing',
    { timeout: 30_000 },
  );

  const clickCommand = (command) =>
    page.evaluate((target) => {
      globalThis.document.querySelector(`[data-print-job-command="${target}"]`)?.click();
    }, command);

  await clickCommand('pause');
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-print-job-state]')?.dataset.printJobState === 'paused',
    { timeout: 30_000 },
  );
  assert.equal(
    await page.$eval('[data-print-job-command="pause"]', (button) => button.disabled),
    true,
    'a paused job cannot be paused again',
  );
  await clickCommand('resume');
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-print-job-state]')?.dataset.printJobState === 'printing',
    { timeout: 30_000 },
  );
  assert.deepEqual(printer.commands, ['start', 'pause', 'resume']);

  // A dismissed confirmation must leave the machine untouched.
  await clickCommand('emergency-stop');
  await page.waitForSelector('[data-print-job-confirm="true"]', { timeout: 30_000 });
  const stopDialog = await page.$eval('[data-print-job-confirm="true"]', (overlay) => ({
    role: overlay.querySelector('[role="alertdialog"]') !== null,
    consequences: [...overlay.querySelectorAll('[data-print-job-confirm-consequence]')].map((row) => row.textContent),
    focused: globalThis.document.activeElement?.dataset?.printJobConfirmChoice,
  }));
  assert.equal(stopDialog.role, true);
  assert.equal(stopDialog.focused, 'cancel', 'focus never starts on the button that halts the printer');
  assert.ok(
    stopDialog.consequences.some((text) => /firmware/i.test(text)),
    'the dialog states that Klipper stays halted until a firmware restart',
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !globalThis.document.querySelector('[data-print-job-confirm="true"]'));
  assert.deepEqual(printer.commands, ['start', 'pause', 'resume'], 'a dismissed stop sends nothing');

  await clickCommand('cancel');
  await page.waitForSelector('[data-print-job-confirm="true"]', { timeout: 30_000 });
  await page.click('[data-print-job-confirm-choice="cancel"]');
  assert.deepEqual(printer.commands, ['start', 'pause', 'resume'], 'a dismissed cancel sends nothing');

  await clickCommand('cancel');
  await page.waitForSelector('[data-print-job-confirm="true"]', { timeout: 30_000 });
  await page.click('[data-print-job-confirm-choice="confirm"]');
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-print-job-state]')?.dataset.printJobState === 'cancelled',
    { timeout: 30_000 },
  );
  assert.deepEqual(printer.commands, ['start', 'pause', 'resume', 'cancel']);
  assert.equal(
    await page.$eval('[data-print-job-command="cancel"]', (button) => button.disabled),
    true,
    'a finished job offers nothing to cancel',
  );
}

function checksumOf(buffer) {
  let checksum = 5381;
  for (const byte of buffer) checksum = ((checksum * 33) ^ byte) >>> 0;
  return checksum;
}

async function clickMenuAction(page, actionId) {
  await page.$eval(`[data-action-id="${actionId}"]`, (item) => {
    item.closest('.menu-host')?.querySelector('.menu-trigger')?.click();
  });
  await page.click(`[data-action-id="${actionId}"]`);
}

async function setDomInput(page, selector, value) {
  await page.$eval(
    selector,
    (input, nextValue) => {
      input.value = nextValue;
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    },
    value,
  );
}

async function clickVirtualFilamentAction(page, filamentId, action) {
  await page.evaluate(
    ({ filamentId, action }) => {
      const button = [...globalThis.document.querySelectorAll('[data-virtual-filament-action]')].find(
        (candidate) =>
          candidate.dataset.filamentId === filamentId && candidate.dataset.virtualFilamentAction === action,
      );
      button?.click();
    },
    { filamentId, action },
  );
}

const fixtureDirectory = await mkdtemp(join(tmpdir(), 'orcaxr-e2e-'));
const fixturePath = await writeMultiPlateFixture(fixtureDirectory);
const objFixturePath = await writeObjFixture(fixtureDirectory);
const gcodeFixturePath = await writeGcodeFixture(fixtureDirectory);
const printer = await startMoonrakerSimulator();
const { server, url } = await startPreview();
const browser = await launchBrowser();
try {
  const pageErrors = [];
  const policyErrors = [];
  const page = await openReadyPage(browser, url, { width: 1280, height: 720 }, (readyPage) => {
    readyPage.on('pageerror', (error) => pageErrors.push(error.message));
    readyPage.on('console', (message) => {
      if (/Content Security Policy|Refused to (?:load|connect|execute)/i.test(message.text())) {
        policyErrors.push(message.text());
      }
    });
  });

  assert.match(await page.title(), /OrcaXR/i);
  assert.equal(await page.$eval('[data-action-id="slice_active_plate"]', (node) => node.disabled), true);
  assert.match(await page.$eval('[data-action-id="slice_active_plate"]', (node) => node.title), /load|model/i);

  // FullSpectrum auto-pair generation is an explicit, default-off preference.
  // Exercise a <=4 physical-filament library so no confirmation dialog is
  // involved, verify persistence across a real reload, then restore the
  // preference before the rest of the smoke workflow mutates the project.
  const autoPairStorageKey = 'orcaxr.full-spectrum.auto-pairs';
  await page.waitForFunction(
    () => {
      const policy = globalThis.window.workspace?.getFullSpectrumAutoPairPolicySnapshot();
      return policy && policy.physicalCount >= 2 && policy.physicalCount <= 4;
    },
    { timeout: 60_000 },
  );
  const initialAutoPairPreference = await page.evaluate((storageKey) => {
    const checkbox = globalThis.document.getElementById('chk-full-spectrum-auto-pairs');
    const confirmButton = globalThis.document.getElementById('btn-confirm-full-spectrum-auto-pairs');
    return {
      stored: globalThis.localStorage.getItem(storageKey),
      checked: checkbox?.checked,
      status: globalThis.document.getElementById('full-spectrum-auto-pairs-status')?.textContent ?? '',
      confirmDisplay: confirmButton ? globalThis.getComputedStyle(confirmButton).display : '',
      policy: globalThis.window.workspace.getFullSpectrumAutoPairPolicySnapshot(),
    };
  }, autoPairStorageKey);
  assert.equal(initialAutoPairPreference.checked, false, 'auto-pair preference defaults off');
  assert.equal(initialAutoPairPreference.policy.enabled, false, 'canonical auto-pair policy defaults off');
  assert.match(initialAutoPairPreference.status, /off by default/i);
  assert.equal(initialAutoPairPreference.confirmDisplay, 'none');
  assert.deepEqual(JSON.parse(initialAutoPairPreference.stored), { enabled: false });

  await page.$eval('#chk-full-spectrum-auto-pairs', (checkbox) => {
    checkbox.checked = true;
    checkbox.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    (storageKey) => {
      const policy = globalThis.window.workspace.getFullSpectrumAutoPairPolicySnapshot();
      const stored = JSON.parse(globalThis.localStorage.getItem(storageKey) ?? 'null');
      const autoCount = globalThis.window.workspace
        .getVirtualFilamentLibrarySnapshot()
        .mixed.filter((row) => row.filament.fullSpectrum?.originAuto === true).length;
      return (
        policy.enabled &&
        !policy.confirmationRequired &&
        autoCount === policy.projectedPairCount &&
        stored?.enabled === true
      );
    },
    { timeout: 60_000 },
    autoPairStorageKey,
  );

  await page.reload({ waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  await page.waitForFunction(
    (storageKey) => {
      const policy = globalThis.window.workspace?.getFullSpectrumAutoPairPolicySnapshot();
      const checkbox = globalThis.document.getElementById('chk-full-spectrum-auto-pairs');
      const stored = JSON.parse(globalThis.localStorage.getItem(storageKey) ?? 'null');
      if (!policy) return false;
      const autoCount = globalThis.window.workspace
        .getVirtualFilamentLibrarySnapshot()
        .mixed.filter((row) => row.filament.fullSpectrum?.originAuto === true).length;
      return (
        checkbox?.checked === true &&
        policy.enabled &&
        policy.physicalCount >= 2 &&
        policy.physicalCount <= 4 &&
        !policy.confirmationRequired &&
        autoCount === policy.projectedPairCount &&
        stored?.enabled === true
      );
    },
    { timeout: 60_000 },
    autoPairStorageKey,
  );

  await page.$eval('#chk-full-spectrum-auto-pairs', (checkbox) => {
    checkbox.checked = false;
    checkbox.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    (storageKey) => {
      const policy = globalThis.window.workspace.getFullSpectrumAutoPairPolicySnapshot();
      const stored = JSON.parse(globalThis.localStorage.getItem(storageKey) ?? 'null');
      return !policy.enabled && stored?.enabled === false;
    },
    { timeout: 60_000 },
    autoPairStorageKey,
  );
  await page.evaluate(
    ({ storageKey, stored }) => {
      if (stored === null) globalThis.localStorage.removeItem(storageKey);
      else globalThis.localStorage.setItem(storageKey, stored);
    },
    { storageKey: autoPairStorageKey, stored: initialAutoPairPreference.stored },
  );
  await page.reload({ waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const policy = globalThis.window.workspace?.getFullSpectrumAutoPairPolicySnapshot();
      const checkbox = globalThis.document.getElementById('chk-full-spectrum-auto-pairs');
      const autoCount = globalThis.window.workspace
        ?.getVirtualFilamentLibrarySnapshot()
        .mixed.filter((row) => row.filament.fullSpectrum?.originAuto === true).length;
      return policy && !policy.enabled && checkbox?.checked === false && autoCount === 0;
    },
    { timeout: 60_000 },
  );

  const initialHistory = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history);
  assert.equal(
    await page.$eval('[data-action-id="edit_undo"]', (node) => node.disabled),
    initialHistory.undoCount === 0,
  );

  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await page.waitForSelector('#command-palette.open');
  assert.equal(
    await page.$eval('#cmd-list [data-action-id="edit_undo"]', (node) => node.classList.contains('disabled')),
    initialHistory.undoCount === 0,
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !globalThis.document.querySelector('#command-palette.open'));

  // Menus expose keyboard navigation, and informational dialogs own focus,
  // trap Tab/Escape, then restore focus to the menu trigger that opened them.
  await page.$eval('[data-action-id="help_about"]', (item) => {
    const trigger = item.closest('.menu-host')?.querySelector('.menu-trigger');
    trigger?.focus();
    trigger?.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  assert.equal(await page.$eval('[role="menuitem"]:focus', (item) => item.getAttribute('role')), 'menuitem');
  await page.click('[data-action-id="help_about"]');
  await page.waitForSelector('#oxr-modal-overlay [role="dialog"][aria-modal="true"]');
  assert.equal(
    await page.$eval('#oxr-modal-overlay', (overlay) => overlay.contains(globalThis.document.activeElement)),
    true,
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !globalThis.document.getElementById('oxr-modal-overlay'));
  assert.equal(
    await page.evaluate(() => globalThis.document.activeElement?.id),
    'menu-button',
    'closing the dialog returns focus to the control that opens the menu',
  );

  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('resize')));
  const overflow = await page.evaluate(
    () => globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 1, `mobile shell overflows horizontally by ${overflow}px`);

  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluate(() => {
    // Skip the engine's background warm-up: the one slice this smoke performs
    // loads it on demand, and the eager warm-up only slows every other step.
    globalThis.window.workspace.slicerWarmupQueued = true;
  });
  assert.equal(
    await page.$eval('#file-input', (input) => input.accept),
    '.3mf,.stl,.obj,.amf,.amfz,.zip,.gcode,.gco,.g',
    'one picker offers every loadable container',
  );

  // A mesh source imports through the same canonical transaction as a project:
  // OBJ objects become canonical objects and material sections become parts.
  const objectPicker = await page.$('#file-input');
  const [modelChooser] = await Promise.all([
    page.waitForFileChooser(),
    page.evaluate(() => globalThis.window.workspace.onRequestLoadStl?.()),
  ]);
  assert.ok(objectPicker, 'the model picker input exists');
  await modelChooser.accept([objFixturePath]);
  await page.waitForFunction(() => (globalThis.window.workspace?.getCanonicalSummary?.().objectCount ?? 0) === 2, {
    timeout: 30_000,
  });
  const importedModels = await page.evaluate(() => {
    const summary = globalThis.window.workspace.getCanonicalSummary();
    const snapshot = globalThis.window.workspace.getAutomationSnapshot();
    return { objectCount: summary.objectCount, placed: snapshot.placedModelsTotalAllPlates };
  });
  assert.equal(importedModels.objectCount, 2, 'both OBJ objects became canonical objects');
  assert.equal(importedModels.placed, 2, 'both OBJ objects are placed on the active plate');

  await arrangeImportedModels(page);
  await transformImportedModels(page);
  await fillPlateWithInstances(page);
  await inspectStandaloneGcode(page, gcodeFixturePath);
  await paintImportedModel(page);
  await smartPaintConsentGate(page);
  await dropModelFile(page, objFixturePath);
  await sliceAndSendActivePlate(page, printer);

  await page.evaluate(() => globalThis.window.workspace.undo?.());
  await page.waitForFunction(() => (globalThis.window.workspace?.getCanonicalSummary?.().objectCount ?? -1) === 0, {
    timeout: 30_000,
  });

  // A project 3MF goes through File -> Open Project, its dedicated picker,
  // and the explicit import preview. It must not use the STL model picker.
  await page.$eval('[data-action-id="file_open_project"]', (item) => {
    item.closest('.menu-host')?.querySelector('.menu-trigger')?.click();
  });
  const openProject = await page.$('[data-action-id="file_open_project"]');
  assert.ok(openProject, 'Open Project action is available');
  const [projectChooser] = await Promise.all([page.waitForFileChooser(), openProject.click()]);
  await projectChooser.accept([fixturePath]);
  await page.waitForSelector('[data-project-import-preview="true"] [role="dialog"]', { timeout: 60_000 });
  const importPreview = await page.$eval('[data-project-import-preview="true"]', (overlay) => {
    const replace = [...overlay.querySelectorAll('button')].find((button) => button.textContent === 'Replace project');
    const notices = [...overlay.querySelectorAll('[data-notice-id]')];
    return {
      title: overlay.querySelector('#project-import-preview-title')?.textContent,
      summary: overlay.querySelector('#project-import-preview-summary')?.textContent,
      notices: notices.map((notice) => notice.textContent),
      noticesVisible: notices.every((notice) => notice.getClientRects().length > 0),
      requiredAcknowledgements: overlay.querySelectorAll('input[data-acknowledgement-id]').length,
      replaceDisabled: replace?.disabled,
    };
  });
  assert.match(importPreview.title, /^Open .+\?$/i);
  assert.match(importPreview.summary, /2 plate\(s\), 2 object\(s\)/i);
  assert.match(importPreview.summary, /one undoable canonical command/i);
  assert.ok(importPreview.notices.length > 0, 'foreign project import notices are listed');
  assert.equal(importPreview.noticesVisible, true, 'every project import notice is visible');
  assert.equal(importPreview.replaceDisabled, importPreview.requiredAcknowledgements > 0);

  const requiredAcknowledgements = await page.$$('[data-project-import-preview="true"] input[data-acknowledgement-id]');
  for (const acknowledgement of requiredAcknowledgements) await acknowledgement.click();
  assert.equal(
    await page.$eval(
      '[data-project-import-preview="true"]',
      (overlay) =>
        [...overlay.querySelectorAll('button')].find((button) => button.textContent === 'Replace project')?.disabled,
    ),
    false,
  );
  const previewButtons = await page.$$('[data-project-import-preview="true"] button');
  const replaceProject = (
    await Promise.all(
      previewButtons.map(async (button) =>
        (await button.evaluate((node) => node.textContent)) === 'Replace project' ? button : null,
      ),
    )
  ).find(Boolean);
  assert.ok(replaceProject, 'Replace project confirmation is available');
  await replaceProject.click();
  await page.waitForFunction(
    (initialUndoCount) => {
      const snapshot = globalThis.window.workspace?.getAutomationSnapshot?.();
      const summary = globalThis.window.workspace?.getCanonicalSummary?.();
      return (
        snapshot?.placedModelsTotalAllPlates === 2 &&
        snapshot.plates.length === 2 &&
        summary?.history.undoCount === initialUndoCount + 1 &&
        summary.history.redoCount === 0
      );
    },
    { timeout: 60_000 },
    initialHistory.undoCount,
  );

  assert.equal(await page.$eval('[data-action-id="edit_undo"]', (node) => node.disabled), false);
  assert.equal(await page.$eval('[data-action-id="edit_redo"]', (node) => node.disabled), true);

  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (initialUndoCount) => {
      const snapshot = globalThis.window.workspace?.getAutomationSnapshot?.();
      const summary = globalThis.window.workspace?.getCanonicalSummary?.();
      return (
        snapshot?.placedModelsTotalAllPlates === 0 &&
        snapshot.plates.length === 1 &&
        summary?.history.undoCount === initialUndoCount &&
        summary.history.redoCount === 1
      );
    },
    {},
    initialHistory.undoCount,
  );
  assert.equal(
    await page.$eval('[data-action-id="edit_undo"]', (node) => node.disabled),
    initialHistory.undoCount === 0,
  );
  assert.equal(await page.$eval('[data-action-id="edit_redo"]', (node) => node.disabled), false);

  await clickMenuAction(page, 'edit_redo');
  await page.waitForFunction(
    (initialUndoCount) => {
      const snapshot = globalThis.window.workspace?.getAutomationSnapshot?.();
      const summary = globalThis.window.workspace?.getCanonicalSummary?.();
      return (
        snapshot?.placedModelsTotalAllPlates === 2 &&
        snapshot.plates.length === 2 &&
        summary?.history.undoCount === initialUndoCount + 1 &&
        summary.history.redoCount === 0
      );
    },
    {},
    initialHistory.undoCount,
  );
  assert.equal(await page.$eval('[data-action-id="edit_undo"]', (node) => node.disabled), false);
  assert.equal(await page.$eval('[data-action-id="edit_redo"]', (node) => node.disabled), true);

  // The live FullSpectrum library performs a bounded worker Match search and
  // routes every lifecycle change through guarded canonical commands. Saving
  // and reopening the project must preserve the surviving disabled Match row.
  await showInspectorTab(page, 'filament');
  await page.$eval('#virtual-filament-library-host', (host) => {
    const details = host.closest('details');
    if (details) details.open = true;
  });
  const fullSpectrumProfile = await page.evaluate(() => {
    const workspace = globalThis.window.workspace;
    const importedColors = workspace.getVirtualFilamentLibrarySnapshot().physical.map((filament) => filament.color);
    const profileOptions = workspace.getProfileOptions();
    const machine =
      profileOptions.machines.find(
        (candidate) => /Elegoo Centauri Carbon/i.test(candidate) && /0\.4/.test(candidate),
      ) ?? profileOptions.machines[0];
    if (!machine) throw new Error('A compatible browser FullSpectrum machine profile is required');
    const choices = workspace.choicesForMachine(machine);
    const process = choices.processes[0];
    const filament = choices.filaments.find((candidate) => /PLA/i.test(candidate)) ?? choices.filaments[0];
    if (!process || !filament) throw new Error('A compatible browser FullSpectrum profile is required');
    workspace.palette.setFrom(
      importedColors,
      importedColors.map(() => 'PLA'),
    );
    workspace.setProfileByNames(machine, process, filament);
    return workspace.getProfileOptions();
  });
  assert.ok(fullSpectrumProfile.machine && fullSpectrumProfile.process && fullSpectrumProfile.filament);
  assert.deepStrictEqual(
    await page.evaluate(() =>
      globalThis.window.workspace
        .getVirtualFilamentLibrarySnapshot()
        .physical.map((filament) => [filament.material, filament.color.toUpperCase()]),
    ),
    [
      ['PLA', '#FF0000'],
      ['PLA', '#0000FF'],
    ],
  );

  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-virtual-filament-add]')?.disabled === false,
  );
  await page.$eval('[data-virtual-filament-add]', (button) => button.click());
  await page.waitForSelector('[data-virtual-filament-dialog="author"]');
  await setDomInput(page, '[data-virtual-field="name"]', 'E2E searched Match');
  await page.$eval('[data-virtual-mode="match"]', (radio) => {
    radio.checked = true;
    radio.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await setDomInput(page, '[data-virtual-field="match-target"]', '#4000C0');
  await page.waitForFunction(
    () => {
      const candidates = globalThis.document.querySelector('[data-virtual-match-candidates]');
      return (
        candidates?.getAttribute('aria-busy') === 'false' &&
        candidates.querySelector('[data-virtual-match-candidate-choice]')
      );
    },
    { timeout: 60_000 },
  );
  assert.match(
    await page.$eval('[data-virtual-match-candidate]', (candidate) => candidate.textContent ?? ''),
    /Pinned pair search.*predicted #3B00C1.*ΔE2000 0\.48/i,
  );
  await page.click('[data-virtual-match-candidate-choice]');
  assert.equal(await page.$eval('[data-virtual-dialog-action="author-submit"]', (button) => button.disabled), false);
  await page.click('[data-virtual-dialog-action="author-submit"]');
  await page.waitForFunction(
    (name) =>
      !globalThis.document.querySelector('[data-virtual-filament-dialog]') &&
      globalThis.window.workspace
        .getVirtualFilamentLibrarySnapshot()
        .mixed.some((row) => row.filament.name === name && row.filament.distribution.mode === 'match'),
    {},
    'E2E searched Match',
  );
  const searchedMatchId = await page.evaluate(
    (name) =>
      globalThis.window.workspace.getVirtualFilamentLibrarySnapshot().mixed.find((row) => row.filament.name === name)
        .filament.id,
    'E2E searched Match',
  );

  await clickVirtualFilamentAction(page, searchedMatchId, 'edit');
  await page.waitForSelector('[data-virtual-filament-dialog="author"]');
  await setDomInput(page, '[data-virtual-field="name"]', 'E2E edited Match');
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[data-virtual-match-candidates]')?.getAttribute('aria-busy') === 'false' &&
      globalThis.document.querySelector('[data-virtual-dialog-action="author-submit"]')?.disabled === false,
    { timeout: 60_000 },
  );
  await page.click('[data-virtual-dialog-action="author-submit"]');
  await page.waitForFunction(
    ({ id, name }) =>
      globalThis.window.workspace
        .getVirtualFilamentLibrarySnapshot()
        .mixed.some((row) => row.filament.id === id && row.filament.name === name),
    {},
    { id: searchedMatchId, name: 'E2E edited Match' },
  );

  await clickVirtualFilamentAction(page, searchedMatchId, 'duplicate');
  await page.waitForSelector('[data-virtual-filament-dialog="author"]');
  await setDomInput(page, '[data-virtual-field="name"]', 'E2E persisted Match copy');
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[data-virtual-match-candidates]')?.getAttribute('aria-busy') === 'false' &&
      globalThis.document.querySelector('[data-virtual-dialog-action="author-submit"]')?.disabled === false,
    { timeout: 60_000 },
  );
  await page.click('[data-virtual-dialog-action="author-submit"]');
  await page.waitForFunction(
    (name) =>
      !globalThis.document.querySelector('[data-virtual-filament-dialog]') &&
      globalThis.window.workspace.getVirtualFilamentLibrarySnapshot().mixed.some((row) => row.filament.name === name),
    {},
    'E2E persisted Match copy',
  );
  const persistedMatchId = await page.evaluate(
    (name) =>
      globalThis.window.workspace.getVirtualFilamentLibrarySnapshot().mixed.find((row) => row.filament.name === name)
        .filament.id,
    'E2E persisted Match copy',
  );
  assert.notEqual(persistedMatchId, searchedMatchId);

  await clickVirtualFilamentAction(page, persistedMatchId, 'enabled');
  await page.waitForFunction(
    (id) =>
      globalThis.window.workspace.getVirtualFilamentLibrarySnapshot().mixed.find((row) => row.filament.id === id)
        ?.filament.enabled === false,
    {},
    persistedMatchId,
  );
  await clickVirtualFilamentAction(page, searchedMatchId, 'delete');
  await page.waitForSelector('[data-virtual-filament-dialog="delete"]');
  await page.click('[data-virtual-dialog-action="delete-confirm"]');
  await page.waitForFunction(
    (id) =>
      !globalThis.window.workspace.getVirtualFilamentLibrarySnapshot().mixed.some((row) => row.filament.id === id),
    {},
    searchedMatchId,
  );

  await page.evaluate(() => {
    globalThis.__e2eOriginalDownloadFile = globalThis.window.workspace.onDownloadFile;
    globalThis.__e2eSavedProject = undefined;
    globalThis.window.workspace.onDownloadFile = (name, data, mime) => {
      void new globalThis.Blob([data], { type: mime }).arrayBuffer().then((buffer) => {
        globalThis.__e2eSavedProject = {
          name,
          mime,
          bytes: [...new Uint8Array(buffer)],
        };
      });
    };
  });
  await clickMenuAction(page, 'file_save_project');
  await page.waitForFunction(() => globalThis.__e2eSavedProject?.bytes.length > 0, { timeout: 60_000 });
  const savedProject = await page.evaluate(() => globalThis.__e2eSavedProject);
  assert.equal(savedProject.mime, 'model/3mf');
  assert.match(savedProject.name, /\.3mf$/i);
  const savedProjectPath = join(fixtureDirectory, 'full-spectrum-roundtrip.3mf');
  await writeFile(savedProjectPath, Uint8Array.from(savedProject.bytes));
  await page.evaluate(() => {
    globalThis.window.workspace.onDownloadFile = globalThis.__e2eOriginalDownloadFile;
    delete globalThis.__e2eOriginalDownloadFile;
    delete globalThis.__e2eSavedProject;
  });

  await clickVirtualFilamentAction(page, persistedMatchId, 'delete');
  await page.waitForSelector('[data-virtual-filament-dialog="delete"]');
  await page.click('[data-virtual-dialog-action="delete-confirm"]');
  await page.waitForFunction(() => globalThis.window.workspace.getVirtualFilamentLibrarySnapshot().mixed.length === 0);

  await page.$eval('[data-action-id="file_open_project"]', (item) => {
    item.closest('.menu-host')?.querySelector('.menu-trigger')?.click();
  });
  const reopenProject = await page.$('[data-action-id="file_open_project"]');
  const [roundtripChooser] = await Promise.all([page.waitForFileChooser(), reopenProject.click()]);
  await roundtripChooser.accept([savedProjectPath]);
  await page.waitForSelector('[data-project-import-preview="true"] [role="dialog"]', { timeout: 60_000 });
  const roundtripAcknowledgements = await page.$$(
    '[data-project-import-preview="true"] input[data-acknowledgement-id]',
  );
  for (const acknowledgement of roundtripAcknowledgements) await acknowledgement.click();
  await page.$eval('[data-project-import-preview="true"]', (overlay) => {
    const replace = [...overlay.querySelectorAll('button')].find((button) => button.textContent === 'Replace project');
    replace?.click();
  });
  await page.waitForFunction(
    (name) => {
      const rows = globalThis.window.workspace.getVirtualFilamentLibrarySnapshot().mixed;
      return (
        !globalThis.document.querySelector('[data-project-import-preview="true"]') &&
        rows.length === 1 &&
        rows[0].filament.name === name &&
        rows[0].filament.enabled === false &&
        rows[0].filament.distribution.mode === 'match' &&
        rows[0].filament.distribution.targetColor === '#4000C0' &&
        rows[0].hasExactFullSpectrumState
      );
    },
    { timeout: 60_000 },
    'E2E persisted Match copy',
  );
  assert.match(
    await page.$eval('[data-virtual-filament-row]', (row) => row.textContent ?? ''),
    /E2E persisted Match copy.*Match.*Disabled/i,
  );

  // The live Objects panel projects the canonical hierarchy, routes typed
  // selection/rename/reveal through the registry, and observes undo/redo.
  await page.waitForSelector('#objects-panel-host [role="tree"][aria-multiselectable="true"]');
  const objectFixture = await page.evaluate(() => {
    const snapshot = globalThis.window.workspace.getObjectsTreeSnapshot();
    const owningPlate = (source) => {
      let row = source;
      while (row) {
        if (row.entity?.kind === 'plate') return row.entity.id;
        row = row.parentKey ? snapshot.projection.rowsByKey.get(row.parentKey) : undefined;
      }
      return undefined;
    };
    return {
      activePlateId: globalThis.window.workspace.getCanonicalSummary().activePlateId,
      objects: [...snapshot.projection.rowsByKey.values()]
        .filter((row) => row.kind === 'object' && row.entity?.kind === 'object')
        .map((row) => {
          const volumes = row.childrenKeys
            .map((key) => snapshot.projection.rowsByKey.get(key))
            .filter((child) => child?.kind === 'volume' && child.entity?.kind === 'volume')
            .map((child) => ({ key: child.key, id: child.entity.id, label: child.label }));
          return {
            key: row.key,
            id: row.entity.id,
            label: row.label,
            plateId: owningPlate(row),
            volume: volumes[0],
            volumes,
          };
        }),
      instances: [...snapshot.projection.rowsByKey.values()]
        .filter((row) => row.kind === 'instance' && row.entity?.kind === 'instance')
        .map((row) => ({ key: row.key, id: row.entity.id, label: row.label, plateId: owningPlate(row) })),
    };
  });
  assert.equal(objectFixture.objects.length, 2);
  assert.equal(objectFixture.instances.length, 2);
  const localObject = objectFixture.objects.find((object) => object.plateId === objectFixture.activePlateId);
  const remoteObject = objectFixture.objects.find((object) => object.plateId !== objectFixture.activePlateId);
  assert.ok(localObject?.volume && remoteObject?.volume, 'both imported objects expose a volume row');

  await page.$eval(
    '[data-objects-search]',
    (input, value) => {
      input.value = value;
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    },
    localObject.label,
  );
  await page.waitForFunction(
    (key) =>
      [...globalThis.document.querySelectorAll('[data-objects-row-key]')].some(
        (row) => row.dataset.objectsRowKey === key,
      ),
    {},
    localObject.key,
  );
  await page.evaluate((key) => {
    const row = [...globalThis.document.querySelectorAll('[data-objects-row-key]')].find(
      (candidate) => candidate.dataset.objectsRowKey === key,
    );
    row?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
  }, localObject.key);
  await page.waitForFunction(
    (id) => globalThis.window.workspace.getObjectsTreeSnapshot().selection.primary?.id === id,
    {},
    localObject.id,
  );
  await page.waitForFunction(() => {
    const state = globalThis.window.__orcaUi.get();
    return state.hasSelection && !state.hasInstanceSelection;
  });
  assert.equal(await page.$eval('#left-toolbar [data-action-id="tool_move"]', (node) => node.disabled), true);
  assert.equal(
    await page.$eval('#menu-bar-host [data-action-id="edit_delete_selected"]', (node) => node.disabled),
    true,
  );
  assert.equal(await page.$eval('#menu-bar-host [data-action-id="edit_deselect_all"]', (node) => node.disabled), false);

  const beforeRename = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history.undoCount);
  // Keyboard rename needs the row actually on screen, so select its tab first.
  await showInspectorTab(page, 'objects');
  await page.evaluate((key) => {
    const row = [...globalThis.document.querySelectorAll('[data-objects-row-key]')].find(
      (candidate) => candidate.dataset.objectsRowKey === key,
    );
    row?.focus();
  }, localObject.key);
  await page.keyboard.press('F2');
  await page.waitForSelector('[data-objects-rename-input]');
  await page.$eval('[data-objects-rename-input]', (input) => {
    input.value = 'E2E renamed object';
    input.closest('form')?.dispatchEvent(new globalThis.Event('submit', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(
    (key) =>
      globalThis.window.workspace.getObjectsTreeSnapshot().projection.rowsByKey.get(key)?.label ===
      'E2E renamed object',
    {},
    localObject.key,
  );
  assert.equal(
    await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history.undoCount),
    beforeRename + 1,
  );
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    ({ key, label }) =>
      globalThis.window.workspace.getObjectsTreeSnapshot().projection.rowsByKey.get(key)?.label === label,
    {},
    { key: localObject.key, label: localObject.label },
  );
  await clickMenuAction(page, 'edit_redo');
  await page.waitForFunction(
    (key) =>
      globalThis.window.workspace.getObjectsTreeSnapshot().projection.rowsByKey.get(key)?.label ===
      'E2E renamed object',
    {},
    localObject.key,
  );

  await page.$eval(
    '[data-objects-search]',
    (input, value) => {
      input.value = value;
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    },
    remoteObject.volume.label,
  );
  await page.waitForFunction(
    (key) =>
      [...globalThis.document.querySelectorAll('[data-objects-row-key]')].some(
        (row) => row.dataset.objectsRowKey === key,
      ),
    {},
    remoteObject.key,
  );
  await page.evaluate((key) => {
    const row = [...globalThis.document.querySelectorAll('[data-objects-row-key]')].find(
      (candidate) => candidate.dataset.objectsRowKey === key,
    );
    row?.querySelector('[data-objects-action="reveal"]')?.click();
  }, remoteObject.key);
  await page.waitForFunction(
    ({ plateId, objectId }) => {
      const workspace = globalThis.window.workspace;
      const selection = workspace.getObjectsTreeSnapshot().selection;
      return workspace.getCanonicalSummary().activePlateId === plateId && selection.primary?.id === objectId;
    },
    {},
    { plateId: remoteObject.plateId, objectId: remoteObject.id },
  );

  await page.evaluate((key) => {
    const row = [...globalThis.document.querySelectorAll('[data-objects-row-key]')].find(
      (candidate) => candidate.dataset.objectsRowKey === key,
    );
    row?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
  }, remoteObject.key);
  await page.waitForFunction(
    (id) => globalThis.window.workspace.getObjectsTreeSnapshot().selection.primary?.id === id,
    {},
    remoteObject.id,
  );
  await page.evaluate((key) => {
    const row = [...globalThis.document.querySelectorAll('[data-objects-row-key]')].find(
      (candidate) => candidate.dataset.objectsRowKey === key,
    );
    row?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  }, remoteObject.volume.key);
  await page.waitForFunction(
    ({ objectId, volumeId }) => {
      const refs = globalThis.window.workspace.getObjectsTreeSnapshot().selection.refs;
      return refs.length === 2 && refs.some((ref) => ref.id === objectId) && refs.some((ref) => ref.id === volumeId);
    },
    {},
    { objectId: remoteObject.id, volumeId: remoteObject.volume.id },
  );

  const assignmentFixture = await page.evaluate(() => {
    const workspace = globalThis.window.workspace;
    const snapshot = workspace.getFilamentAssignmentSnapshot();
    const target = snapshot.options.find(
      (option) => option.enabled && snapshot.scopes.some((scope) => scope.localFilamentId !== option.id),
    );
    return {
      targetId: target?.id,
      beforeLocalIds: snapshot.scopes.map((scope) => scope.localFilamentId ?? null),
      sourceRevision: snapshot.sourceRevision,
      undoCount: workspace.getCanonicalSummary().history.undoCount,
    };
  });
  assert.ok(assignmentFixture.targetId, 'the imported project exposes a different enabled stable filament');
  await showInspectorTab(page, 'filament');
  await page.$eval('#filament-assignment-host', (host) => {
    const details = host.closest('details');
    if (details) details.open = true;
  });
  await page.$eval(
    '#filament-assignment-host input[data-filament-id]',
    (_input, targetId) => {
      const target = globalThis.document.querySelector(
        `#filament-assignment-host input[data-filament-id="${globalThis.CSS.escape(targetId)}"]`,
      );
      target?.click();
    },
    assignmentFixture.targetId,
  );
  await page.$eval('#filament-assignment-host [data-filament-assignment-apply]', (button) => button.click());
  await page.waitForFunction(
    ({ targetId, sourceRevision }) => {
      const snapshot = globalThis.window.workspace.getFilamentAssignmentSnapshot();
      return (
        snapshot.sourceRevision > sourceRevision &&
        snapshot.scopes.length === 2 &&
        snapshot.scopes.every((scope) => scope.localFilamentId === targetId)
      );
    },
    {},
    { targetId: assignmentFixture.targetId, sourceRevision: assignmentFixture.sourceRevision },
  );
  assert.equal(
    await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history.undoCount),
    assignmentFixture.undoCount + 1,
  );
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (beforeLocalIds) => {
      const scopes = globalThis.window.workspace.getFilamentAssignmentSnapshot().scopes;
      return (
        scopes.length === beforeLocalIds.length &&
        scopes.every((scope, index) => (scope.localFilamentId ?? null) === beforeLocalIds[index])
      );
    },
    {},
    assignmentFixture.beforeLocalIds,
  );
  await clickMenuAction(page, 'edit_redo');
  await page.waitForFunction(
    (targetId) =>
      globalThis.window.workspace
        .getFilamentAssignmentSnapshot()
        .scopes.every((scope) => scope.localFilamentId === targetId),
    {},
    assignmentFixture.targetId,
  );

  // The semantic editor works against the same canonical object graph. The
  // fixture's two-part object makes one non-noop role conversion legal; every
  // height-range lifecycle operation is then asserted from the adapter snapshot.
  const semanticObject = objectFixture.objects.find((object) => object.volumes.length > 1);
  assert.ok(semanticObject?.volume, 'the semantic fixture exposes a two-part object');
  await showInspectorTab(page, 'objects');
  await page.$eval('#semantic-object-editor-host', (host) => {
    const details = host.closest('details');
    if (details) details.open = true;
  });
  await page.$eval(
    '[data-objects-search]',
    (input, value) => {
      input.value = value;
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    },
    semanticObject.volume.id,
  );
  await page.waitForFunction(
    (key) =>
      [...globalThis.document.querySelectorAll('[data-objects-row-key]')].some(
        (row) => row.dataset.objectsRowKey === key,
      ),
    {},
    semanticObject.volume.key,
  );
  await page.evaluate((key) => {
    const row = [...globalThis.document.querySelectorAll('[data-objects-row-key]')].find(
      (candidate) => candidate.dataset.objectsRowKey === key,
    );
    row?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
  }, semanticObject.volume.key);
  await page.waitForFunction(
    (volumeId) => globalThis.window.workspace.getSemanticObjectEditorSnapshot()?.selectedVolume?.id === volumeId,
    {},
    semanticObject.volume.id,
  );
  const semanticRoleFixture = await page.evaluate(() => {
    const workspace = globalThis.window.workspace;
    const snapshot = workspace.getSemanticObjectEditorSnapshot();
    const selected = snapshot?.selectedVolume;
    const target = selected?.roleDecisions.find(
      ({ role, decision }) => role !== selected.role && decision.allowed && !decision.noop,
    );
    return {
      beforeRole: selected?.role,
      targetRole: target?.role,
      volumeId: selected?.id,
      objectId: snapshot?.objectId,
      undoCount: workspace.getCanonicalSummary().history.undoCount,
    };
  });
  assert.ok(
    semanticRoleFixture.targetRole,
    'a distinct semantic role is explicitly allowed by the canonical inspector',
  );
  await page.click(
    `#semantic-object-editor-host [data-volume-role="${semanticRoleFixture.targetRole}"][data-volume-id]`,
  );
  await page.waitForFunction(
    ({ targetRole, undoCount }) => {
      const workspace = globalThis.window.workspace;
      return (
        workspace.getSemanticObjectEditorSnapshot()?.selectedVolume?.role === targetRole &&
        workspace.getCanonicalSummary().history.undoCount === undoCount + 1
      );
    },
    {},
    semanticRoleFixture,
  );
  assert.equal(
    await page.$eval(`#semantic-object-editor-host [data-volume-role="${semanticRoleFixture.targetRole}"]`, (button) =>
      button.getAttribute('aria-pressed'),
    ),
    'true',
  );
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (beforeRole) => globalThis.window.workspace.getSemanticObjectEditorSnapshot()?.selectedVolume?.role === beforeRole,
    {},
    semanticRoleFixture.beforeRole,
  );
  await clickMenuAction(page, 'edit_redo');
  await page.waitForFunction(
    (targetRole) => globalThis.window.workspace.getSemanticObjectEditorSnapshot()?.selectedVolume?.role === targetRole,
    {},
    semanticRoleFixture.targetRole,
  );

  const rangeHistoryStart = await page.evaluate(
    () => globalThis.window.workspace.getCanonicalSummary().history.undoCount,
  );
  await page.$eval('[data-layer-range-input="add-min"]', (input) => {
    input.value = '0';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.$eval('[data-layer-range-input="add-max"]', (input) => {
    input.value = '6';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.click('[data-layer-range-submit="add"]');
  await page.waitForFunction(
    (undoCount) => {
      const workspace = globalThis.window.workspace;
      const snapshot = workspace.getSemanticObjectEditorSnapshot();
      return (
        snapshot?.layerRanges.length === 1 &&
        snapshot.selectedLayerRange?.id === snapshot.layerRanges[0]?.id &&
        snapshot.layerRanges[0]?.minZMm === 0 &&
        snapshot.layerRanges[0]?.maxZMm === 6 &&
        workspace.getCanonicalSummary().history.undoCount === undoCount + 1
      );
    },
    {},
    rangeHistoryStart,
  );
  const originalRangeId = await page.evaluate(
    () => globalThis.window.workspace.getSemanticObjectEditorSnapshot().layerRanges[0].id,
  );

  await page.$eval('[data-layer-range-input="edit-max"]', (input) => {
    input.value = '8';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.click('[data-layer-range-submit="edit"]');
  await page.waitForFunction(
    ({ originalRangeId, rangeHistoryStart }) => {
      const workspace = globalThis.window.workspace;
      const range = workspace
        .getSemanticObjectEditorSnapshot()
        ?.layerRanges.find((candidate) => candidate.id === originalRangeId);
      return (
        range?.minZMm === 0 &&
        range.maxZMm === 8 &&
        workspace.getCanonicalSummary().history.undoCount === rangeHistoryStart + 2
      );
    },
    {},
    { originalRangeId, rangeHistoryStart },
  );

  await page.$eval('[data-layer-range-input="split-z"]', (input) => {
    input.value = '4';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.click('[data-layer-range-submit="split"]');
  await page.waitForFunction(
    ({ originalRangeId, rangeHistoryStart }) => {
      const workspace = globalThis.window.workspace;
      const snapshot = workspace.getSemanticObjectEditorSnapshot();
      return (
        snapshot?.layerRanges.length === 2 &&
        snapshot.layerRanges.some(
          (range) => range.id === originalRangeId && range.minZMm === 0 && range.maxZMm === 4,
        ) &&
        snapshot.layerRanges.some(
          (range) => range.id !== originalRangeId && range.minZMm === 4 && range.maxZMm === 8,
        ) &&
        snapshot.selectedLayerRange?.id !== originalRangeId &&
        workspace.getCanonicalSummary().history.undoCount === rangeHistoryStart + 3
      );
    },
    {},
    { originalRangeId, rangeHistoryStart },
  );
  await page.click('[data-layer-range-merge="previous"]');
  await page.waitForFunction(
    ({ originalRangeId, rangeHistoryStart }) => {
      const workspace = globalThis.window.workspace;
      const snapshot = workspace.getSemanticObjectEditorSnapshot();
      return (
        snapshot?.layerRanges.length === 1 &&
        snapshot.layerRanges[0]?.id === originalRangeId &&
        snapshot.layerRanges[0]?.minZMm === 0 &&
        snapshot.layerRanges[0]?.maxZMm === 8 &&
        snapshot.selectedLayerRange?.id === originalRangeId &&
        workspace.getCanonicalSummary().history.undoCount === rangeHistoryStart + 4
      );
    },
    {},
    { originalRangeId, rangeHistoryStart },
  );

  await page.$eval('[data-layer-range-input="add-min"]', (input) => {
    input.value = '8';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.$eval('[data-layer-range-input="add-max"]', (input) => {
    input.value = '10';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.click('[data-layer-range-submit="add"]');
  await page.waitForFunction(
    ({ originalRangeId, rangeHistoryStart }) => {
      const workspace = globalThis.window.workspace;
      const snapshot = workspace.getSemanticObjectEditorSnapshot();
      return (
        snapshot?.layerRanges.length === 2 &&
        snapshot.selectedLayerRange?.id !== originalRangeId &&
        snapshot.layerRanges.some((range) => range.minZMm === 8 && range.maxZMm === 10) &&
        workspace.getCanonicalSummary().history.undoCount === rangeHistoryStart + 5
      );
    },
    {},
    { originalRangeId, rangeHistoryStart },
  );
  const disposableRangeId = await page.evaluate(
    () => globalThis.window.workspace.getSemanticObjectEditorSnapshot().selectedLayerRange.id,
  );
  await page.click(`[data-layer-range-delete="${disposableRangeId}"]`);
  await page.waitForFunction(
    ({ originalRangeId, disposableRangeId, rangeHistoryStart }) => {
      const workspace = globalThis.window.workspace;
      const snapshot = workspace.getSemanticObjectEditorSnapshot();
      return (
        snapshot?.layerRanges.length === 1 &&
        snapshot.layerRanges[0]?.id === originalRangeId &&
        !snapshot.layerRanges.some((range) => range.id === disposableRangeId) &&
        workspace.getCanonicalSummary().history.undoCount === rangeHistoryStart + 6
      );
    },
    {},
    { originalRangeId, disposableRangeId, rangeHistoryStart },
  );
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (disposableRangeId) =>
      globalThis.window.workspace
        .getSemanticObjectEditorSnapshot()
        ?.layerRanges.some((range) => range.id === disposableRangeId),
    {},
    disposableRangeId,
  );
  await clickMenuAction(page, 'edit_redo');
  await page.waitForFunction(
    (disposableRangeId) =>
      !globalThis.window.workspace
        .getSemanticObjectEditorSnapshot()
        ?.layerRanges.some((range) => range.id === disposableRangeId),
    {},
    disposableRangeId,
  );

  const remoteInstance = objectFixture.instances.find((instance) => instance.plateId === remoteObject.plateId);
  assert.ok(remoteInstance);
  await page.$eval(
    '[data-objects-search]',
    (input, value) => {
      input.value = value;
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    },
    remoteInstance.id,
  );
  await page.waitForFunction(
    (key) =>
      [...globalThis.document.querySelectorAll('[data-objects-row-key]')].some(
        (row) => row.dataset.objectsRowKey === key,
      ),
    {},
    remoteInstance.key,
  );
  await page.evaluate((key) => {
    const row = [...globalThis.document.querySelectorAll('[data-objects-row-key]')].find(
      (candidate) => candidate.dataset.objectsRowKey === key,
    );
    row?.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
  }, remoteInstance.key);
  await page.waitForFunction(
    (id) => {
      const state = globalThis.window.__orcaUi.get();
      return (
        globalThis.window.workspace.getObjectsTreeSnapshot().selection.primary?.id === id && state.hasInstanceSelection
      );
    },
    {},
    remoteInstance.id,
  );
  assert.equal(await page.$eval('#left-toolbar [data-action-id="tool_move"]', (node) => node.disabled), false);
  assert.equal(
    await page.$eval('#menu-bar-host [data-action-id="edit_delete_selected"]', (node) => node.disabled),
    false,
  );

  // Generated settings commit exact wire values into the canonical override
  // map, preserve the inherited raw map, and reset through the same guarded
  // atomic seam. Undo/redo must restore the complete base/override/effective trio.
  await showInspectorTab(page, 'settings');
  await page.waitForSelector('#settings-inspector-host [data-generated-settings-panel="true"]', {
    timeout: 60_000,
  });
  await page.$eval('[data-settings-search]', (input) => {
    input.value = 'layer_height';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.waitForSelector('[data-settings-key="layer_height"][data-settings-support="implemented"]', {
    timeout: 60_000,
  });
  const settingsBefore = await page.evaluate(() => {
    const workspace = globalThis.window.workspace;
    return {
      snapshot: workspace.getProjectSettingsOverrideSnapshot(),
      undoCount: workspace.getCanonicalSummary().history.undoCount,
    };
  });
  assert.equal(Object.hasOwn(settingsBefore.snapshot.overrides, 'layer_height'), false);
  await page.$eval(
    '[data-settings-key="layer_height"] [data-settings-control][data-settings-editable="true"]',
    (control) => {
      control.value = '0.16';
      control.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    },
  );
  assert.equal(await page.$eval('[data-settings-apply]', (button) => button.disabled), false);
  await showInspectorTab(page, 'settings');
  await page.click('[data-settings-apply]');
  await page.waitForFunction(
    ({ sourceRevision, undoCount }) => {
      const workspace = globalThis.window.workspace;
      const snapshot = workspace.getProjectSettingsOverrideSnapshot();
      return (
        snapshot.sourceRevision > sourceRevision &&
        snapshot.overrides.layer_height === '0.16' &&
        snapshot.effectiveConfig.layer_height === '0.16' &&
        workspace.getCanonicalSummary().history.undoCount === undoCount + 1
      );
    },
    {},
    {
      sourceRevision: settingsBefore.snapshot.sourceRevision,
      undoCount: settingsBefore.undoCount,
    },
  );
  await page.waitForFunction(() => {
    const panel = globalThis.document.querySelector('[data-generated-settings-panel]');
    const status = globalThis.document.querySelector('[data-settings-operation-status]');
    return (
      panel?.getAttribute('aria-busy') === 'false' &&
      /Applied 1 setting change atomically/.test(status?.textContent ?? '')
    );
  });
  const settingsApplied = await page.evaluate(() => globalThis.window.workspace.getProjectSettingsOverrideSnapshot());
  assert.deepStrictEqual(settingsApplied.inheritedConfig, settingsBefore.snapshot.inheritedConfig);
  assert.equal(settingsApplied.overrides.layer_height, '0.16');
  assert.equal(settingsApplied.effectiveConfig.layer_height, '0.16');

  assert.equal(
    await page.$eval('[data-settings-key="layer_height"] [data-settings-reset-inherited]', (button) => button.disabled),
    false,
  );
  await page.$eval('[data-settings-key="layer_height"] [data-settings-reset-inherited]', (button) => button.click());
  const settingsResetDraftUi = await page.$eval('[data-settings-key="layer_height"]', (row) => ({
    applyDisabled: globalThis.document.querySelector('[data-settings-apply]')?.disabled,
    conflictVisible: !globalThis.document.querySelector('[data-settings-conflict]')?.hidden,
    controlValue: row.querySelector('[data-settings-control]')?.value,
    draft: row.querySelector('[data-settings-draft]')?.textContent ?? null,
    issues: [...row.querySelectorAll('[data-settings-issue-code]')].map((issue) => issue.textContent),
    origin: row.querySelector('[data-settings-origin]')?.dataset.settingsOrigin,
  }));
  assert.equal(
    settingsResetDraftUi.applyDisabled,
    false,
    `reset-to-inherited did not create an applicable draft: ${JSON.stringify(settingsResetDraftUi)}`,
  );
  await showInspectorTab(page, 'settings');
  await page.click('[data-settings-apply]');
  await page.waitForFunction(
    ({ sourceRevision, undoCount, inheritedHasLayerHeight, inheritedLayerHeight }) => {
      const workspace = globalThis.window.workspace;
      const snapshot = workspace.getProjectSettingsOverrideSnapshot();
      return (
        snapshot.sourceRevision > sourceRevision &&
        !Object.hasOwn(snapshot.overrides, 'layer_height') &&
        Object.hasOwn(snapshot.effectiveConfig, 'layer_height') === inheritedHasLayerHeight &&
        (!inheritedHasLayerHeight || snapshot.effectiveConfig.layer_height === inheritedLayerHeight) &&
        workspace.getCanonicalSummary().history.undoCount === undoCount + 1
      );
    },
    {},
    {
      sourceRevision: settingsApplied.sourceRevision,
      undoCount: settingsBefore.undoCount + 1,
      inheritedHasLayerHeight: Object.hasOwn(settingsBefore.snapshot.inheritedConfig, 'layer_height'),
      inheritedLayerHeight: settingsBefore.snapshot.inheritedConfig.layer_height ?? null,
    },
  );
  await page.waitForFunction(() => {
    const panel = globalThis.document.querySelector('[data-generated-settings-panel]');
    const status = globalThis.document.querySelector('[data-settings-operation-status]');
    return (
      panel?.getAttribute('aria-busy') === 'false' &&
      /Applied 1 setting change atomically/.test(status?.textContent ?? '')
    );
  });
  const settingsReset = await page.evaluate(() => globalThis.window.workspace.getProjectSettingsOverrideSnapshot());
  assert.deepStrictEqual(settingsReset.inheritedConfig, settingsBefore.snapshot.inheritedConfig);
  assert.deepStrictEqual(settingsReset.overrides, settingsBefore.snapshot.overrides);
  assert.deepStrictEqual(settingsReset.effectiveConfig, settingsBefore.snapshot.effectiveConfig);

  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    () => globalThis.window.workspace.getProjectSettingsOverrideSnapshot().overrides.layer_height === '0.16',
  );
  await clickMenuAction(page, 'edit_redo');
  await page.waitForFunction(
    () => !Object.hasOwn(globalThis.window.workspace.getProjectSettingsOverrideSnapshot().overrides, 'layer_height'),
  );
  // The responsive PlateManager owns guarded canonical plate operations. Add
  // starts in the existing plate bar; every subsequent operation is driven
  // through the manager and asserted from canonical summaries/tree IDs.
  await showInspectorTab(page, 'plates');
  await page.$eval('#plate-manager-host', (host) => {
    const details = host.closest('details');
    if (details) details.open = true;
  });
  await page.waitForSelector('#plate-manager-host [data-plate-manager-list="true"]');
  const platesBefore = await page.evaluate(() => {
    const workspace = globalThis.window.workspace;
    const summary = workspace.getCanonicalSummary();
    return {
      plates: summary.plates.map((plate) => ({
        id: plate.id,
        name: plate.name,
        objectCount: plate.objectCount,
        instanceCount: plate.instanceCount,
        modelVolumeCount: plate.modelVolumeCount,
      })),
      undoCount: summary.history.undoCount,
    };
  });
  assert.deepStrictEqual(
    platesBefore.plates.map((plate) => plate.name),
    ['Alpha', 'Beta'],
  );
  await page.click('.plate-add');
  await page.waitForFunction(
    ({ existingIds, undoCount }) => {
      const summary = globalThis.window.workspace.getCanonicalSummary();
      const active = summary.plates.find((plate) => plate.id === summary.activePlateId);
      return (
        summary.plates.length === 3 &&
        active &&
        !existingIds.includes(active.id) &&
        active.objectCount === 0 &&
        active.instanceCount === 0 &&
        summary.history.undoCount === undoCount + 1
      );
    },
    {},
    {
      existingIds: platesBefore.plates.map((plate) => plate.id),
      undoCount: platesBefore.undoCount,
    },
  );
  const addedPlateId = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().activePlateId);
  await page.evaluate((plateId) => {
    const button = [...globalThis.document.querySelectorAll('[data-plate-control="rename"]')].find(
      (candidate) => candidate.dataset.plateId === plateId,
    );
    button?.click();
  }, addedPlateId);
  await page.waitForFunction(
    (plateId) =>
      [...globalThis.document.querySelectorAll('[data-plate-control="rename-input"]')].some(
        (input) => input.dataset.plateId === plateId,
      ),
    {},
    addedPlateId,
  );
  await page.evaluate((plateId) => {
    const input = [...globalThis.document.querySelectorAll('[data-plate-control="rename-input"]')].find(
      (candidate) => candidate.dataset.plateId === plateId,
    );
    input.value = 'E2E scratch plate';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    input.closest('form')?.dispatchEvent(new globalThis.Event('submit', { bubbles: true, cancelable: true }));
  }, addedPlateId);
  await page.waitForFunction(
    ({ plateId, undoCount }) => {
      const summary = globalThis.window.workspace.getCanonicalSummary();
      return (
        summary.plates.find((plate) => plate.id === plateId)?.name === 'E2E scratch plate' &&
        summary.history.undoCount === undoCount + 2
      );
    },
    {},
    { plateId: addedPlateId, undoCount: platesBefore.undoCount },
  );

  const sourcePlateId = platesBefore.plates.find((plate) => plate.name === 'Alpha').id;
  await page.evaluate((plateId) => {
    const button = [...globalThis.document.querySelectorAll('[data-plate-control="primary"]')].find(
      (candidate) => candidate.dataset.plateId === plateId,
    );
    button?.click();
  }, sourcePlateId);
  await page.waitForFunction(
    ({ plateId, undoCount }) => {
      const summary = globalThis.window.workspace.getCanonicalSummary();
      return summary.activePlateId === plateId && summary.history.undoCount === undoCount + 3;
    },
    {},
    { plateId: sourcePlateId, undoCount: platesBefore.undoCount },
  );
  await page.evaluate((plateId) => {
    const button = [...globalThis.document.querySelectorAll('[data-plate-control="duplicate"]')].find(
      (candidate) => candidate.dataset.plateId === plateId,
    );
    button?.click();
  }, sourcePlateId);
  await page.waitForFunction(
    ({ existingIds, sourcePlateId, undoCount }) => {
      const summary = globalThis.window.workspace.getCanonicalSummary();
      const duplicate = summary.plates.find((plate) => !existingIds.includes(plate.id));
      const source = summary.plates.find((plate) => plate.id === sourcePlateId);
      return (
        summary.plates.length === 4 &&
        duplicate &&
        source &&
        duplicate.id === summary.activePlateId &&
        duplicate.objectCount === source.objectCount &&
        duplicate.instanceCount === source.instanceCount &&
        duplicate.modelVolumeCount === source.modelVolumeCount &&
        summary.history.undoCount === undoCount + 4
      );
    },
    {},
    {
      existingIds: [...platesBefore.plates.map((plate) => plate.id), addedPlateId],
      sourcePlateId,
      undoCount: platesBefore.undoCount,
    },
  );
  const duplicatePlateId = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().activePlateId);
  const duplicateGraph = await page.evaluate(
    ({ sourcePlateId, duplicatePlateId }) => {
      const snapshot = globalThis.window.workspace.getObjectsTreeSnapshot();
      const plateIdForRow = (source) => {
        let row = source;
        while (row) {
          if (row.entity?.kind === 'plate') return row.entity.id;
          row = row.parentKey ? snapshot.projection.rowsByKey.get(row.parentKey) : undefined;
        }
        return undefined;
      };
      const collect = (plateId) =>
        [...snapshot.projection.rowsByKey.values()]
          .filter((row) => row.entity && plateIdForRow(row) === plateId)
          .map((row) => `${row.entity.kind}:${row.entity.id}`)
          .sort();
      const source = collect(sourcePlateId);
      const duplicate = collect(duplicatePlateId);
      const shape = (entries) => entries.map((entry) => entry.slice(0, entry.indexOf(':'))).sort();
      return {
        source,
        duplicate,
        sourceShape: shape(source),
        duplicateShape: shape(duplicate),
        overlap: source.filter((entry) => duplicate.includes(entry)),
      };
    },
    { sourcePlateId, duplicatePlateId },
  );
  assert.deepStrictEqual(duplicateGraph.duplicateShape, duplicateGraph.sourceShape);
  assert.deepStrictEqual(duplicateGraph.overlap, [], 'duplicated editable graph IDs are all fresh');

  const reorderFixture = await page.evaluate((plateId) => {
    const summary = globalThis.window.workspace.getCanonicalSummary();
    const ids = summary.plates.map((plate) => plate.id);
    const index = ids.indexOf(plateId);
    const direction = index < ids.length - 1 ? 'move-later' : 'move-earlier';
    const swapIndex = direction === 'move-later' ? index + 1 : index - 1;
    const expected = [...ids];
    [expected[index], expected[swapIndex]] = [expected[swapIndex], expected[index]];
    return { direction, expected };
  }, duplicatePlateId);
  await page.evaluate(
    ({ plateId, direction }) => {
      const button = [...globalThis.document.querySelectorAll(`[data-plate-control="${direction}"]`)].find(
        (candidate) => candidate.dataset.plateId === plateId,
      );
      button?.click();
    },
    { plateId: duplicatePlateId, direction: reorderFixture.direction },
  );
  await page.waitForFunction(
    ({ expected, undoCount }) => {
      const summary = globalThis.window.workspace.getCanonicalSummary();
      return (
        summary.plates.every((plate, index) => plate.id === expected[index]) &&
        summary.history.undoCount === undoCount + 5
      );
    },
    {},
    { expected: reorderFixture.expected, undoCount: platesBefore.undoCount },
  );

  await page.evaluate((plateId) => {
    const checkbox = [...globalThis.document.querySelectorAll('[data-plate-control="printable"]')].find(
      (candidate) => candidate.dataset.plateId === plateId,
    );
    checkbox?.click();
  }, duplicatePlateId);
  await page.waitForFunction(
    ({ plateId, undoCount }) => {
      const summary = globalThis.window.workspace.getCanonicalSummary();
      return (
        summary.plates.find((plate) => plate.id === plateId)?.printable === false &&
        summary.history.undoCount === undoCount + 6
      );
    },
    {},
    { plateId: duplicatePlateId, undoCount: platesBefore.undoCount },
  );

  const betaPlateId = platesBefore.plates.find((plate) => plate.name === 'Beta').id;
  await page.evaluate((plateId) => {
    const button = [...globalThis.document.querySelectorAll('[data-plate-control="primary"]')].find(
      (candidate) => candidate.dataset.plateId === plateId,
    );
    button?.click();
  }, betaPlateId);
  await page.waitForFunction(
    ({ plateId, undoCount }) => {
      const summary = globalThis.window.workspace.getCanonicalSummary();
      return summary.activePlateId === plateId && summary.history.undoCount === undoCount + 7;
    },
    {},
    { plateId: betaPlateId, undoCount: platesBefore.undoCount },
  );

  await page.evaluate((plateId) => {
    const button = [...globalThis.document.querySelectorAll('[data-plate-control="delete"]')].find(
      (candidate) => candidate.dataset.plateId === plateId,
    );
    button?.click();
  }, addedPlateId);
  await page.waitForFunction(
    ({ plateId, undoCount }) => {
      const summary = globalThis.window.workspace.getCanonicalSummary();
      return !summary.plates.some((plate) => plate.id === plateId) && summary.history.undoCount === undoCount + 8;
    },
    {},
    { plateId: addedPlateId, undoCount: platesBefore.undoCount },
  );
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (plateId) => globalThis.window.workspace.getCanonicalSummary().plates.some((plate) => plate.id === plateId),
    {},
    addedPlateId,
  );
  await clickMenuAction(page, 'edit_redo');
  await page.waitForFunction(
    (plateId) => !globalThis.window.workspace.getCanonicalSummary().plates.some((plate) => plate.id === plateId),
    {},
    addedPlateId,
  );
  await page.evaluate((plateId) => {
    const button = [...globalThis.document.querySelectorAll('[data-plate-control="delete"]')].find(
      (candidate) => candidate.dataset.plateId === plateId,
    );
    button?.click();
  }, duplicatePlateId);
  await page.waitForFunction(
    ({ expectedIds, undoCount }) => {
      const summary = globalThis.window.workspace.getCanonicalSummary();
      return (
        summary.plates.length === expectedIds.length &&
        summary.plates.every((plate, index) => plate.id === expectedIds[index]) &&
        summary.history.undoCount === undoCount + 9
      );
    },
    {},
    {
      expectedIds: platesBefore.plates.map((plate) => plate.id),
      undoCount: platesBefore.undoCount,
    },
  );

  const imported = await page.evaluate(async () => {
    const workspace = globalThis.window.workspace;
    const plates = [];
    for (const plate of workspace.getPlates()) {
      workspace.setActivePlate(plate.id);
      await new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)));
      const geometries = workspace.printerGeometries();
      const bounds = {
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity,
      };
      for (const geometry of geometries) {
        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        bounds.minX = Math.min(bounds.minX, box.min.x);
        bounds.minY = Math.min(bounds.minY, box.min.y);
        bounds.minZ = Math.min(bounds.minZ, box.min.z);
        bounds.maxX = Math.max(bounds.maxX, box.max.x);
        bounds.maxY = Math.max(bounds.maxY, box.max.y);
        bounds.maxZ = Math.max(bounds.maxZ, box.max.z);
        geometry.dispose();
      }
      const allModels = workspace.plates.flatMap((candidate) =>
        candidate.models.map((model) => ({ plateId: candidate.id, visible: model.viewer.visible })),
      );
      plates.push({
        label: plate.label,
        count: plate.count,
        bounds,
        activeVisible: allModels.filter((model) => model.plateId === plate.id && model.visible).length,
        inactiveVisible: allModels.filter((model) => model.plateId !== plate.id && model.visible).length,
      });
    }
    return plates;
  });
  assert.deepStrictEqual(
    imported.map(({ label, count }) => ({ label, count })),
    [
      { label: 'Alpha', count: 1 },
      { label: 'Beta', count: 1 },
    ],
  );
  const roundBounds = (bounds) =>
    Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.round(value)]));
  assert.deepStrictEqual(roundBounds(imported[0].bounds), {
    minX: 10,
    minY: 15,
    minZ: 5,
    maxX: 20,
    maxY: 25,
    maxZ: 10,
  });
  assert.deepStrictEqual(roundBounds(imported[1].bounds), {
    minX: 15,
    minY: 20,
    minZ: 7,
    maxX: 25,
    maxY: 30,
    maxZ: 12,
  });
  assert.deepStrictEqual(
    await page.evaluate(() => globalThis.window.workspace.palette.list().map((slot) => slot.color.toLowerCase())),
    ['#ff0000', '#0000ff'],
  );
  assert.ok(imported.every((plate) => plate.activeVisible === plate.count && plate.inactiveVisible === 0));

  assert.deepStrictEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join('\n')}`);
  assert.deepStrictEqual(policyErrors, [], `CSP violations: ${policyErrors.join('\n')}`);
  console.log(
    'Production E2E smoke passed (canonical import/history, Objects/filament assignment, semantic roles/ranges, generated settings, guarded plate management, a Smart Paint consent gate that sends nothing and changes nothing without consent, an authored layer pause that reaches the sliced G-code and comes back as a located preview tick beside the engine totals, and a multicolor slice sent to a live Moonraker printer then paused, resumed, and cancelled from its live job panel).',
  );
} finally {
  await browser.close();
  await server.close();
  await printer.close();
  await rm(fixtureDirectory, { recursive: true, force: true });
}
