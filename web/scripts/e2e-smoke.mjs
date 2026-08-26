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

/**
 * The shell holds together at every size it claims to support (P10.1).
 *
 * P10.1 defines its breakpoints by available space rather than by device
 * names, so this walks the sizes that bracket them — phone portrait and
 * landscape, tablet, desktop — plus the CSS-pixel budget a browser at 200%
 * zoom leaves, which is the case a device-name breakpoint always misses.
 *
 * Two properties are checked at each. Nothing may overflow horizontally,
 * because a shell that scrolls sideways has lost its layout rather than
 * adapted it. And the palette must offer the same catalog it offers with
 * room to spare: progressive disclosure is allowed to move a control, never
 * to strand it, and the palette is the documented safety net for exactly
 * that. The widest layout is walked first so it sets that reference — this
 * compares the shell against itself, which is the strongest statement
 * available without a test-only handle on the registry.
 */
async function surviveEveryViewport(page) {
  const viewports = [
    { label: 'desktop', width: 1280, height: 720 },
    { label: 'tablet portrait', width: 820, height: 1180 },
    { label: 'phone landscape', width: 844, height: 390 },
    { label: 'phone portrait', width: 390, height: 844 },
    { label: '200% zoom on a laptop', width: 640, height: 360 },
  ];

  // The reference is the widest layout: whatever the palette offers with room
  // to spare is what every narrower one has to keep offering.
  let catalogSize = null;

  for (const viewport of viewports) {
    await page.setViewport({ width: viewport.width, height: viewport.height });
    await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('resize')));

    const overflow = await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 1, `${viewport.label} overflows horizontally by ${overflow}px`);

    // The palette is the reachability guarantee, so it has to open and to
    // list the whole catalog at every size — not a size-trimmed subset.
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await page.waitForSelector('#command-palette.open', { timeout: 30_000 });
    const listed = await page.$$eval('#cmd-list [data-action-id]', (rows) => rows.length);
    assert.ok(listed > 0, `${viewport.label} lists no actions in the palette`);
    catalogSize ??= listed;
    assert.equal(
      listed,
      catalogSize,
      `${viewport.label} offers ${listed} actions where a wider layout offers ${catalogSize}`,
    );

    const paletteOverflow = await page.evaluate(
      () => globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth,
    );
    assert.ok(paletteOverflow <= 1, `${viewport.label} overflows with the palette open by ${paletteOverflow}px`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !globalThis.document.querySelector('#command-palette.open'));

    // An open menu has to be *hit-testable*, not merely laid out. A clipping
    // ancestor — `overflow` anything but `visible` on the bar, a stacking
    // context above it — leaves every row with a correct box, `visibility:
    // visible`, and nothing painted, so a click silently lands on whatever is
    // behind the strip. That shipped once; this is the check that would have
    // caught it, at every width and in every section rather than only in the
    // handful of rows the flow below happens to press.
    const buried = await page.evaluate(() => {
      const covered = [];
      // Below the menu-bar breakpoint the whole bar sits behind the hamburger,
      // which is the first thing an operator presses.
      const bar = globalThis.document.getElementById('menu-bar-host');
      const hidden = bar && globalThis.getComputedStyle(bar).display === 'none';
      if (hidden) globalThis.document.getElementById('menu-button')?.click();
      for (const host of globalThis.document.querySelectorAll('.menu-host')) {
        const trigger = host.querySelector('.menu-trigger');
        const wasOpen = host.classList.contains('open');
        if (!wasOpen) trigger?.click();
        // The first row *and* the last one. A long section that runs past the
        // bottom of the window hides its tail behind an invisible fold: the
        // rows keep their boxes and report themselves visible, and nobody can
        // see or press them. That is how a shipped tool went missing.
        const rows = [...host.querySelectorAll('.menu-dropdown [role="menuitem"]')];
        for (const row of [rows[0], rows.at(-1)].filter(Boolean)) {
          // Scrolling to an item is a legitimate way to reach it; being clipped
          // by an ancestor is not, and survives this call unchanged.
          row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const rect = row.getBoundingClientRect();
          const top = globalThis.document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          if (rect.width < 1 || rect.height < 1) {
            covered.push(`${trigger?.textContent}: no box`);
          } else if (top !== row && !row.contains(top)) {
            covered.push(
              `${trigger?.textContent} "${row.textContent?.trim().slice(0, 24)}": ` +
                `${top ? `${top.tagName}.${top.className}` : 'nothing'} is on top`,
            );
          }
        }
        if (!wasOpen) host.classList.remove('open');
      }
      if (hidden) globalThis.document.getElementById('menu-button')?.click();
      return covered;
    });
    assert.deepEqual(buried, [], `${viewport.label} buries an open menu behind the layout`);
  }

  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('resize')));
  console.log(`[e2e] shell holds its layout and all ${catalogSize} palette actions at every supported size`);
}

/**
 * The G-code window, in a browser that has a real viewport (P11.2).
 *
 * Its virtualization is unit-tested against jsdom, which reports a zero client
 * height — so what those traces prove is that the overscan is bounded, not that
 * the viewport arithmetic works. This is the part only a real browser can
 * answer: that a program of thousands of lines puts a handful of rows on the
 * page, that scrolling changes which ones, and that the count beside them is
 * still the whole program.
 */
async function readTheProgramInABrowser(page, artifact) {
  // The listing lives in the Preview inspector tab beside the G-code preview,
  // inside a section an operator opens. A panel in a hidden tab or a closed
  // `<details>` has no height, so the window has nothing to measure against
  // until both are open — which is exactly the state a real reader is in.
  await page.evaluate(() => {
    const sidebar = globalThis.document.querySelector('#param-sidebar');
    sidebar?.classList.remove('collapsed');
    const tab = globalThis.document.querySelector('[data-view-tab="preview"]');
    if (tab instanceof globalThis.HTMLElement) tab.click();
    const host = globalThis.document.querySelector('#gcode-panel-host');
    host?.closest('.oxr-card')?.classList.remove('folded');
    const section = host?.closest('details');
    if (section) section.open = true;
  });
  await page.waitForSelector('#gcode-panel-host [data-gcode-scroller]', { timeout: 30_000 });

  const initial = await page.$$eval('#gcode-panel-host [data-gcode-line]', (rows) =>
    rows.map((row) => Number(row.dataset.gcodeLine)),
  );
  assert.ok(initial.length > 0, 'the window renders rows once a program exists');
  assert.ok(
    initial.length < 400,
    `a program of ${artifact.byteLength} bytes must not put every line on the page (${initial.length} rows)`,
  );
  assert.equal(initial[0], 1, 'and it starts at the first line');

  // The count is of the program, not of what is rendered — the distinction the
  // whole window is built around.
  const status = await page.$eval('#gcode-panel-host [data-gcode-status]', (node) => node.textContent ?? '');
  const reported = Number(/^([\d,]+) lines/.exec(status)?.[1].replace(/,/g, '') ?? '0');
  assert.ok(reported > initial.length * 4, `the status reports the whole program (${reported} lines)`);

  const geometry = await page.$eval('#gcode-panel-host [data-gcode-scroller]', (node) => {
    node.scrollTop = Math.floor(node.scrollHeight / 2);
    node.dispatchEvent(new Event('scroll'));
    return {
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      scrollTop: node.scrollTop,
      offsetParent: node.offsetParent !== null,
    };
  });
  assert.ok(geometry.scrollTop > 0, `the listing must be scrollable to be readable (${JSON.stringify(geometry)})`);
  const scrolled = await page.$$eval('#gcode-panel-host [data-gcode-line]', (rows) =>
    rows.map((row) => Number(row.dataset.gcodeLine)),
  );
  assert.ok(scrolled[0] > initial[0], 'scrolling moves the window rather than re-rendering the same rows');
  assert.ok(scrolled.length < 400, 'and the window stays bounded wherever it is');

  console.log('[e2e] sliced program read in a windowed viewer that never renders the whole file');
}

/**
 * Two View gaps that used to render as UNAVAILABLE (P11.2).
 *
 * Both are scene changes rather than panel changes, so this asserts the
 * scene: an outline mesh exists on exactly the selected instance and is
 * removed when the toggle goes off, and the navigator reports its state
 * through the workspace rather than through a checkbox that could lie.
 */
async function toggleViewOverlays(page) {
  const selected = await page.evaluate(
    () => globalThis.window.workspace.getCanonicalSummary().selectedInstanceIds[0] ?? null,
  );
  assert.ok(selected, 'a model is selected to outline');

  const countOutlines = () =>
    page.evaluate(() => {
      let found = 0;
      globalThis.window.workspace.traverse((node) => {
        if (node.name === 'selectionOutline') found += 1;
      });
      return found;
    });

  assert.equal(await countOutlines(), 0, 'nothing is outlined before the toggle');
  await clickMenuAction(page, 'view_show_outline');
  await page.waitForFunction(() => globalThis.window.workspace.isSelectionOutlineOn() === true, {
    timeout: 30_000,
  });
  assert.equal(await countOutlines(), 1, 'exactly the selected instance is outlined');

  // The outline follows the selection rather than sticking to what was
  // selected when it was switched on.
  await clickMenuAction(page, 'edit_deselect_all');
  await page.waitForFunction(() => globalThis.window.workspace.getCanonicalSummary().selectedInstanceIds.length === 0, {
    timeout: 30_000,
  });
  assert.equal(await countOutlines(), 0, 'deselecting removes the outline');
  await clickMenuAction(page, 'edit_select_all');
  await page.waitForFunction(() => globalThis.window.workspace.getCanonicalSummary().selectedInstanceIds.length > 0, {
    timeout: 30_000,
  });
  assert.ok((await countOutlines()) > 0, 'reselecting brings it back');

  await clickMenuAction(page, 'view_show_outline');
  await page.waitForFunction(() => globalThis.window.workspace.isSelectionOutlineOn() === false, {
    timeout: 30_000,
  });
  assert.equal(await countOutlines(), 0, 'switching it off disposes every outline');

  await clickMenuAction(page, 'view_show_navigator');
  await page.waitForFunction(() => globalThis.window.workspace.isNavigatorOn() === true, { timeout: 30_000 });
  await clickMenuAction(page, 'view_show_navigator');
  await page.waitForFunction(() => globalThis.window.workspace.isNavigatorOn() === false, { timeout: 30_000 });

  // Neither action reports itself as unavailable any more.
  const badges = await page.evaluate(() =>
    ['view_show_outline', 'view_show_navigator'].map((id) => {
      const item = globalThis.document.querySelector(`[data-action-id="${id}"]`);
      return [id, item?.textContent?.includes('UNAVAILABLE') ?? false];
    }),
  );
  assert.deepEqual(badges, [
    ['view_show_outline', false],
    ['view_show_navigator', false],
  ]);
  console.log('[e2e] selection outline follows the selection, and the navigator toggles');
}

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
/**
 * Put the panel a test needs on screen, the way an operator would.
 *
 * The shell has four workspaces — Prepare, Preview, Device, Project — and the
 * Prepare sidebar is a stack of cards that fold. So reaching a panel is two
 * moves: select the workspace that holds it, then unfold its card. The names
 * here are the panel groups the tests ask for, mapped to where the shell now
 * keeps them.
 */
const PANEL_HOME = {
  objects: { view: 'prepare', card: 'objects' },
  settings: { view: 'prepare', card: 'printer' },
  filament: { view: 'prepare', card: 'filament' },
  preview: { view: 'preview', card: 'preview' },
  printer: { view: 'device', card: null },
  plates: { view: 'project', card: null },
};

async function showInspectorTab(page, panelId) {
  await page.evaluate(
    (id, homes) => {
      const home = homes[id];
      if (!home) throw new Error(`unknown panel group ${id}`);
      const tab = globalThis.document.querySelector(`[data-view-tab="${home.view}"]`);
      if (!tab) throw new Error(`missing workspace tab ${home.view}`);
      tab.click();
      // Every card in the sidebar is unfolded: a test that opens one panel
      // routinely reads another beside it, and a folded card has no box.
      for (const card of globalThis.document.querySelectorAll('#param-scroll .oxr-card')) {
        card.classList.remove('folded');
      }
    },
    panelId,
    PANEL_HOME,
  );
  // The card fold/unfold and the view switch both settle synchronously, but the
  // panels inside them mount from a microtask.
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/**
 * Set this browser up from nothing: install a printer, author a preset over a
 * system base, and move the whole setup through a bundle (P6.4).
 *
 * The acceptance criterion is that clean browser storage can be configured
 * without developer tools, so this drives the shipped controls and then reads
 * the answer back out of the catalog everything else slices against. The
 * export/import half is the part unit tests cannot reach: it goes through a
 * real Blob, a real file picker, and a real reload.
 */
async function configurePrinterLibrary(page, directory) {
  await showInspectorTab(page, 'settings');
  await page.$eval('#preset-library-details', (details) => details.setAttribute('open', ''));
  await page.waitForSelector('[data-preset-library-panel="true"]', { timeout: 60_000 });

  const before = await page.evaluate(() => ({
    machines: globalThis.window.workspace.getProfileOptions().machineOptions.length,
    variants: [...globalThis.document.querySelectorAll('[data-preset-library-variant]')].map((box) => ({
      id: box.dataset.presetLibraryVariant,
      checked: box.checked,
    })),
  }));
  assert.ok(before.machines > 1, 'an unconfigured browser still offers every printer the catalog ships');
  assert.equal(
    before.variants.some((variant) => variant.checked),
    false,
    'nothing is installed before setup',
  );
  assert.ok(
    before.variants.some((variant) => variant.id === 'Snapmaker/Snapmaker U1/0.4'),
    `the U1 is offered: ${JSON.stringify(before.variants.map((variant) => variant.id))}`,
  );

  // Install one nozzle. The picker narrows to exactly it, while the 0.2 and 0.6
  // profiles stay in the catalog they inherit through — hidden, not dropped.
  await page.$eval('[data-preset-library-variant="Snapmaker/Snapmaker U1/0.4"]', (box) => box.click());
  await page.waitForFunction(
    () => {
      const options = globalThis.window.workspace.getProfileOptions();
      return options.machineOptions.length === 1 && options.machine === 'Snapmaker U1 (0.4 nozzle)';
    },
    { timeout: 60_000 },
  );

  // A second machine is additive: installing one printer never uninstalls another.
  await page.$eval('[data-preset-library-variant="Elegoo/Elegoo Centauri Carbon/0.4"]', (box) => box.click());
  await page.waitForFunction(() => globalThis.window.workspace.getProfileOptions().machineOptions.length === 2, {
    timeout: 60_000,
  });

  await page.reload({ waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('#app-boot.ready', { timeout: 60_000 });
  await page.waitForFunction(() => globalThis.window.workspace?.getProfileOptions().machineOptions.length === 2, {
    timeout: 60_000,
  });
  await showInspectorTab(page, 'settings');
  await page.$eval('#preset-library-details', (details) => details.setAttribute('open', ''));
  await page.waitForSelector('[data-preset-library-variant="Snapmaker/Snapmaker U1/0.4"]', { timeout: 60_000 });
  assert.equal(
    await page.$eval('[data-preset-library-variant="Snapmaker/Snapmaker U1/0.4"]', (box) => box.checked),
    true,
    'the installation survived a real reload',
  );

  // Author a filament preset over a system base, changing one value. The field
  // is seeded with the inherited value, so what is typed is what is compared.
  const draft = await page.evaluate(() => {
    const base = globalThis.document.querySelector('[data-preset-library-draft-base]');
    return { base: base?.value ?? '', options: base ? base.options.length : 0 };
  });
  assert.ok(draft.options > 0, 'the installed printer offers filament bases');
  const presetName = 'E2E Dry Box PLA';
  await page.$eval(
    '[data-preset-library-draft-name]',
    (input, value) => {
      input.value = value;
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    },
    presetName,
  );
  await page.$eval('[data-preset-library-add-override]', (button) => button.click());
  await page.waitForSelector('[data-preset-library-override]', { timeout: 30_000 });
  const seeded = await page.$eval('[data-preset-library-override-value]', (input) => input.value);
  assert.ok(seeded.length > 0, 'the override field is seeded with the value the base already holds');
  await page.$eval('[data-preset-library-override-value]', (input) => {
    input.value = '77';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.$eval('[data-preset-library-create]', (button) => button.click());
  await page.waitForSelector(`[data-preset-library-preset="filament/${presetName}"]`, { timeout: 30_000 });

  const authored = await page.evaluate((name) => {
    const row = globalThis.document.querySelector(`[data-preset-library-preset="filament/${name}"]`);
    return {
      provenance: row?.querySelector('[data-preset-library-provenance]')?.textContent ?? '',
      offered: globalThis.window.workspace.getProfileOptions().filamentOptions.some((option) => option.name === name),
    };
  }, presetName);
  assert.equal(authored.offered, true, 'the authored preset is selectable for the installed printer');
  assert.match(authored.provenance, /^from .+ · v1\.0\.0 · All rights reserved/, authored.provenance);

  // A name a system preset already owns is refused, and nothing is written.
  await page.$eval(
    '[data-preset-library-draft-name]',
    (input, value) => {
      input.value = value;
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    },
    draft.base,
  );
  await page.$eval('[data-preset-library-create]', (button) => button.click());
  await page.waitForSelector('[data-preset-library-issue="duplicate-preset-name"]', { timeout: 30_000 });
  assert.deepEqual(
    await page.$$eval('[data-preset-library-preset]', (rows) => rows.map((row) => row.dataset.presetLibraryPreset)),
    [`filament/${presetName}`],
    'the refused draft wrote nothing',
  );

  // Export: the bytes leave through a Blob, so capture the Blob rather than
  // the object URL the shell revokes as soon as the click returns.
  await page.evaluate(() => {
    const createObjectURL = globalThis.URL.createObjectURL.bind(globalThis.URL);
    globalThis.URL.createObjectURL = (blob) => {
      if (blob.type === 'application/json') globalThis.__presetBundleBlob = blob;
      return createObjectURL(blob);
    };
    const click = globalThis.HTMLAnchorElement.prototype.click;
    globalThis.HTMLAnchorElement.prototype.click = function patched() {
      if (this.download === 'orcaxr-presets.json') return;
      return click.call(this);
    };
  });
  await page.$eval('[data-preset-library-export]', (button) => button.click());
  const bundleText = await page.evaluate(async () => globalThis.__presetBundleBlob?.text());
  assert.ok(bundleText, 'the export produced a bundle');
  const bundle = JSON.parse(bundleText);
  assert.equal(bundle.format, 'orcaxr.preset-bundle');
  assert.deepEqual(bundle.installed, [
    { vendor: 'Elegoo', model: 'Elegoo Centauri Carbon', variants: ['0.4'] },
    { vendor: 'Snapmaker', model: 'Snapmaker U1', variants: ['0.4'] },
  ]);
  assert.equal(bundle.customPresets.length, 1);
  assert.equal(bundle.customPresets[0].name, presetName);
  assert.ok(bundle.engine.commit.length > 0, 'the bundle names the engine it was made against');

  // Delete it, then bring it back from the bundle through the real file picker.
  await page.evaluate(() => {
    globalThis.window.confirm = () => true;
  });
  await page.$eval(`[data-preset-library-delete="filament/${presetName}"]`, (button) => button.click());
  await page.waitForFunction(
    (name) =>
      globalThis.document.querySelector(`[data-preset-library-preset="filament/${name}"]`) === null &&
      !globalThis.window.workspace.getProfileOptions().filamentOptions.some((option) => option.name === name),
    { timeout: 30_000 },
    presetName,
  );

  const bundlePath = join(directory, 'orcaxr-presets.json');
  await writeFile(bundlePath, bundleText, 'utf8');
  const [bundleChooser] = await Promise.all([
    page.waitForFileChooser(),
    page.$eval('[data-preset-library-import]', (button) => button.click()),
  ]);
  await bundleChooser.accept([bundlePath]);
  await page.waitForFunction(
    (name) =>
      globalThis.document.querySelector(`[data-preset-library-preset="filament/${name}"]`) !== null &&
      globalThis.window.workspace.getProfileOptions().filamentOptions.some((option) => option.name === name),
    { timeout: 30_000 },
    presetName,
  );

  // A bundle from another engine is refused whole, leaving the setup alone.
  const foreignPath = join(directory, 'orcaxr-presets-foreign.json');
  await writeFile(
    foreignPath,
    JSON.stringify({ ...bundle, engine: { ...bundle.engine, commit: '0'.repeat(40) }, customPresets: [] }),
    'utf8',
  );
  const [foreignChooser] = await Promise.all([
    page.waitForFileChooser(),
    page.$eval('[data-preset-library-import]', (button) => button.click()),
  ]);
  await foreignChooser.accept([foreignPath]);
  await page.waitForSelector('[data-preset-library-issue="engine-mismatch"]', { timeout: 30_000 });
  assert.deepEqual(
    await page.$$eval('[data-preset-library-preset]', (rows) => rows.map((row) => row.dataset.presetLibraryPreset)),
    [`filament/${presetName}`],
    'the refused bundle did not clear the preset it omitted',
  );

  await page.$eval('#preset-library-details', (details) => details.removeAttribute('open'));
  console.log('[e2e] printer installed, preset authored over a system base, and the setup round-tripped as a bundle');
}

/**
 * Override one setting on an object and prove the scope is real (P6.5).
 *
 * The interesting failures here are invisible to unit tests: a panel that
 * renders the project's keys while writing to a node, an action that is
 * catalogued but unreachable from the surface that needs it, or a plate-only
 * key still offered where the engine would never read it. So this drives the
 * shipped picker in the real browser and then reads the canonical answer back.
 */
async function overrideOneObjectSetting(page) {
  await showInspectorTab(page, 'settings');
  await page.waitForSelector('[data-scoped-settings-panel="true"]', { timeout: 60_000 });
  const objectTarget = await page.evaluate(() =>
    globalThis.window.workspace.listScopedOverrideTargets().find((entry) => entry.scope === 'object'),
  );
  assert.ok(objectTarget, 'the loaded project should expose at least one object as a settings target');

  await page.$eval(
    '[data-scoped-settings-target="true"]',
    (select, id) => {
      select.value = id;
      select.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
    },
    objectTarget.id,
  );
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[data-scoped-settings-host]')?.dataset.scopedSettingsScope === 'object' &&
      globalThis.document.querySelector('[data-scoped-settings-host] [data-generated-settings-panel="true"]') !== null,
    { timeout: 60_000 },
  );

  // A plate arranges its own print sequence; an object cannot, and the engine
  // would ignore the key entirely if it were stored here.
  await page.$eval('[data-settings-search]', (input) => {
    input.value = 'print_sequence';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => globalThis.document.querySelector('[data-settings-key="print_sequence"]') === null, {
    timeout: 30_000,
  });

  await page.$eval('[data-settings-search]', (input) => {
    input.value = 'wall_loops';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.waitForSelector('[data-settings-key="wall_loops"][data-settings-support="implemented"]', {
    timeout: 60_000,
  });
  const before = await page.evaluate((target) => {
    const workspace = globalThis.window.workspace;
    return {
      scoped: workspace.getScopedOverrideSnapshot(target),
      project: workspace.getProjectSettingsOverrideSnapshot(),
      undoCount: workspace.getCanonicalSummary().history.undoCount,
    };
  }, objectTarget.target);
  assert.equal(Object.hasOwn(before.scoped.overrides, 'wall_loops'), false);

  await page.$eval('[data-settings-key="wall_loops"] [data-settings-control][data-settings-editable="true"]', (c) => {
    c.value = '4';
    c.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.$eval('[data-settings-apply]', (button) => button.click());
  await page.waitForFunction(
    ({ target, undoCount }) => {
      const workspace = globalThis.window.workspace;
      const snapshot = workspace.getScopedOverrideSnapshot(target);
      return (
        snapshot.overrides.wall_loops === '4' &&
        snapshot.effectiveConfig.wall_loops === '4' &&
        workspace.getCanonicalSummary().history.undoCount === undoCount + 1
      );
    },
    { timeout: 60_000 },
    { target: objectTarget.target, undoCount: before.undoCount },
  );

  // The edit landed on the object and nowhere else: the project's own override
  // map is untouched, which is exactly what a scope is for.
  const after = await page.evaluate(() => globalThis.window.workspace.getProjectSettingsOverrideSnapshot());
  assert.deepStrictEqual(after.overrides, before.project.overrides);

  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (target) => !Object.hasOwn(globalThis.window.workspace.getScopedOverrideSnapshot(target).overrides, 'wall_loops'),
    { timeout: 30_000 },
    objectTarget.target,
  );
  await clickMenuAction(page, 'edit_redo');
  await page.waitForFunction(
    (target) => globalThis.window.workspace.getScopedOverrideSnapshot(target).overrides.wall_loops === '4',
    { timeout: 30_000 },
    objectTarget.target,
  );
  console.log('[e2e] scoped object override applied, isolated from the project, and reversible');
}

/**
 * The same settings, reached without a keyboard (P6.5).
 *
 * The XR shell cannot be driven in this browser — there is no headset — but the
 * thing that has actually gone wrong before is not the drawing, it is the
 * wiring: a panel that renders and changes nothing. That part is testable here,
 * because the controller the headset renders is installed by the same code path
 * the DOM panel is, in this page, against this project. If it were dead, or if
 * the pinned schema failed to load over HTTP, this step fails.
 */
async function stepOneSettingWithoutAKeyboard(page) {
  await page.waitForFunction(() => globalThis.window.workspace.getScopedSettingsView()?.status === 'ready', {
    timeout: 60_000,
  });
  // Earlier steps left a model selected, and the panel follows a selection, so
  // the project scope is asked for rather than assumed.
  await page.evaluate(() => globalThis.window.workspace.selectScopedSettingsTarget('project'));
  await page.waitForFunction(() => globalThis.window.workspace.getScopedSettingsView()?.scope === 'project', {
    timeout: 60_000,
  });
  const before = await page.evaluate(() => {
    const workspace = globalThis.window.workspace;
    const view = workspace.getScopedSettingsView();
    const row = view.rows.find((entry) => entry.steppable && entry.key === 'sparse_infill_density');
    return {
      scope: view.scope,
      rows: view.rows.length,
      unavailable: view.unavailable,
      row,
      overrides: workspace.getProjectSettingsOverrideSnapshot().overrides,
      undoCount: workspace.getCanonicalSummary().history.undoCount,
    };
  });
  assert.equal(before.scope, 'project');
  assert.ok(before.rows > 10, `the headset should offer real settings, got ${before.rows}`);
  assert.ok(before.row, 'sparse infill density is a bounded percentage, so a controller can reach it');
  assert.equal(
    Object.hasOwn(before.overrides, 'sparse_infill_density'),
    false,
    'the project has not overridden infill density yet',
  );

  await page.evaluate((fieldId) => globalThis.window.workspace.stepScopedSetting(fieldId, 1), before.row.fieldId);
  await page.waitForFunction(
    ({ undoCount, previous }) => {
      const workspace = globalThis.window.workspace;
      const stored = workspace.getProjectSettingsOverrideSnapshot().overrides.sparse_infill_density;
      const shown = workspace
        .getScopedSettingsView()
        .rows.find((entry) => entry.key === 'sparse_infill_density')?.value;
      return (
        stored !== undefined &&
        stored !== previous &&
        shown === stored &&
        workspace.getCanonicalSummary().history.undoCount === undoCount + 1
      );
    },
    { timeout: 60_000 },
    { undoCount: before.undoCount, previous: before.row.value },
  );

  // One press, one reversible canonical command — the same guarantee a typed
  // field gets, because it is the same command.
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    () =>
      !Object.hasOwn(
        globalThis.window.workspace.getProjectSettingsOverrideSnapshot().overrides,
        'sparse_infill_density',
      ),
    { timeout: 30_000 },
  );
  // And the panel follows what the operator points at, which is how a spatial
  // surface chooses a node: cycling past every plate and part is not an answer.
  // Deselecting first is what makes this a *change* — the panel follows the
  // selection moving, and deliberately stays where it is when a selection is
  // merely cleared, since an operator mid-edit did not ask to be sent back to
  // the project.
  await clickMenuAction(page, 'edit_deselect_all');
  await page.waitForFunction(() => globalThis.window.workspace.scopedOverrideTargetIdForSelection() === null, {
    timeout: 30_000,
  });
  assert.equal(
    await page.evaluate(() => globalThis.window.workspace.getScopedSettingsView().scope),
    'project',
    'clearing a selection leaves the panel where it was',
  );
  await clickMenuAction(page, 'edit_select_all');
  await page.waitForFunction(
    () => {
      const workspace = globalThis.window.workspace;
      const target = workspace.scopedOverrideTargetIdForSelection();
      return target !== null && workspace.getScopedSettingsView()?.scope === 'object';
    },
    { timeout: 60_000 },
  );
  const followed = await page.evaluate(() => globalThis.window.workspace.getScopedSettingsView());
  assert.ok(
    followed.rows.every((row) => row.key !== 'print_sequence'),
    'an object scope offers no plate-only setting, exactly as the DOM panel narrows',
  );
  await clickMenuAction(page, 'edit_deselect_all');

  console.log(
    `[e2e] a keyboard-less press changed a project setting and undid it, and the panel followed the selection (${before.rows} project rows, ${followed.rows.length} object rows, ${before.unavailable} unsupported)`,
  );
}

/**
 * The right-click menu, generated from the catalog (P11.2).
 *
 * The scene had no context menu at all, and the Objects tree had a hand-built
 * one — two answers to the same right-click is the reachability gap P11.2
 * exists to close. So this asserts the shipped page: right-clicking a model
 * selects it and opens the object menu, right-clicking the bed opens the plate
 * menu, the entries are the registry's for that target, choosing one has the
 * canonical effect, and Escape closes without running anything.
 */
async function rightClickTheScene(page) {
  const viewport = await page.$('#viewport');
  assert.ok(viewport, 'the workspace viewport exists');
  const box = await viewport.boundingBox();

  const openAt = async (x, y) => {
    await page.evaluate(
      ({ x, y }) => {
        const target = globalThis.document.querySelector('canvas');
        target.dispatchEvent(
          new globalThis.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
        );
      },
      { x, y },
    );
    await page.waitForSelector('[data-scene-context-menu="true"]', { timeout: 30_000 });
    return page.evaluate(() => {
      const menu = globalThis.document.querySelector('[data-scene-context-menu="true"]');
      return {
        target: menu.dataset.contextTarget,
        instance: menu.dataset.contextInstance ?? null,
        label: menu.getAttribute('aria-label'),
        items: [...menu.querySelectorAll('[role="menuitem"]')].map((item) => ({
          id: item.dataset.contextItem,
          disabled: item.disabled,
        })),
      };
    });
  };

  // The bed: nothing under the pointer, so this is the plate's menu.
  const plate = await openAt(Math.round(box.x + 24), Math.round(box.y + box.height - 24));
  assert.equal(plate.target, 'plate');
  const plateIds = plate.items.map((item) => item.id);
  assert.ok(plateIds.includes('arrange_all') && plateIds.includes('add_plate'), `plate menu was ${plateIds}`);
  assert.equal(plateIds.includes('mirror_x'), false, 'a model action is not offered on the bed');

  const dismiss = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => globalThis.document.querySelector('[data-scene-context-menu="true"]') === null, {
      timeout: 30_000,
    });
  };
  await dismiss();

  // Right-clicking a model selects it, which is what makes every
  // selection-gated entry offerable rather than disabled. Where a model lands
  // on screen depends on the camera, so this searches outward from the centre
  // the same way the paint step does rather than asserting a fixed pixel.
  await clickMenuAction(page, 'edit_deselect_all');
  // Where the model actually is, asked of the camera that does the picking.
  // Hunting pixels around the middle of the viewport is a test that passes for
  // reasons nobody controls: earlier steps move the camera.
  await clickMenuAction(page, 'edit_select_all');
  const point = await page.evaluate(() => {
    const workspace = globalThis.window.workspace;
    const instanceId = workspace.getCanonicalSummary().selectedInstanceIds[0];
    return instanceId ? workspace.getInstancePickPoint(instanceId) : null;
  });
  await clickMenuAction(page, 'edit_deselect_all');
  if (!point) {
    const scene = await page.evaluate(() => {
      const workspace = globalThis.window.workspace;
      return {
        objects: workspace.getCanonicalSummary().objectCount,
        selected: workspace.getCanonicalSummary().selectedInstanceIds.length,
        placed: workspace.getAutomationSnapshot().placedModelsTotalAllPlates,
        preview: workspace.getPreviewState().active,
      };
    });
    assert.fail(`no point on screen picks a model: ${JSON.stringify(scene)}`);
  }
  const object = await openAt(Math.round(point.clientX), Math.round(point.clientY));
  assert.equal(object.target, 'object', 'right-clicking a model opens the model menu');
  assert.ok(object.instance, 'the menu names the instance it will act on');
  const enabled = object.items.filter((item) => !item.disabled).map((item) => item.id);
  assert.ok(enabled.includes('mirror_x'), `the object menu should be live after selecting: ${enabled}`);
  assert.equal(
    object.items.some((item) => item.id === 'add_plate'),
    false,
    'a plate action is not offered on a model',
  );

  const before = await page.evaluate(() => globalThis.window.workspace.getCanonicalSummary().history.undoCount);
  await page.$eval('[data-context-item="mirror_x"]', (item) => item.click());
  await page.waitForFunction(
    (undoCount) => globalThis.window.workspace.getCanonicalSummary().history.undoCount === undoCount + 1,
    { timeout: 30_000 },
    before,
  );
  assert.equal(
    await page.evaluate(() => globalThis.document.querySelector('[data-scene-context-menu="true"]')),
    null,
    'choosing an entry closes the menu',
  );
  await clickMenuAction(page, 'edit_undo');
  console.log(
    `[e2e] right-click gives the catalog's own menu (${plateIds.length} plate entries, ${object.items.length} object entries) and one press mirrored a model`,
  );
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
  await clickPanelControl(page, '#model-toolbar [data-action-id="tool_move"]');
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
      // The picture the printer's display shows. `libslic3r` cannot draw one —
      // it has geometry, not a view — so this only exists if the browser
      // rendered the plate and the route wrote the block the firmware reads.
      thumbnails: [...gcode.matchAll(/^; thumbnail begin (\d+)x(\d+) (\d+)$/gm)].map((match) => ({
        width: Number(match[1]),
        height: Number(match[2]),
        base64Length: Number(match[3]),
      })),
      thumbnailPayload: (() => {
        const block = /^; thumbnail begin \d+x\d+ \d+\n([\s\S]*?)^; thumbnail end$/m.exec(gcode);
        if (!block) return '';
        return block[1]
          .split('\n')
          .filter((line) => line.startsWith('; '))
          .map((line) => line.slice(2))
          .join('');
      })(),
    };
  });
  await readTheProgramInABrowser(page, artifact);
  assert.deepEqual(artifact.tools, [0, 1], 'the assigned second filament reaches the G-code as a second tool');
  assert.ok(artifact.colours.length >= 2 && artifact.types.length >= 2, 'the artifact declares its filaments');
  assert.equal(artifact.pauses, 1, 'the authored pause reaches the engine and appears once in the G-code');
  assert.equal(artifact.pauseBody, 'M600', 'the pause emits the body this printer profile declares');

  // The sliced file carries a picture of what it prints, in the sizes this
  // printer's own `thumbnails` value asks for. Without it the machine shows its
  // stock image and every print on the shelf looks like every other print.
  assert.ok(artifact.thumbnails.length > 0, 'the G-code must carry a thumbnail of the plate');
  for (const thumbnail of artifact.thumbnails) {
    assert.ok(thumbnail.width > 0 && thumbnail.height > 0, 'a thumbnail declares its own size');
    assert.equal(thumbnail.base64Length > 0, true, 'and the length a parser reads to accumulate it');
  }
  assert.equal(
    artifact.thumbnailPayload.length,
    artifact.thumbnails[0].base64Length,
    'the declared length is the payload that follows it, or a printer stops reading mid-image',
  );
  // A real PNG, not a blank canvas: base64 of the 8-byte PNG signature.
  assert.ok(
    artifact.thumbnailPayload.startsWith('iVBORw0KGgo'),
    'the payload must decode as a PNG, which is what the block claims it is',
  );
  console.log(
    `[e2e] the sliced file carries the plate's own picture (${artifact.thumbnails
      .map((thumbnail) => `${thumbnail.width}x${thumbnail.height}`)
      .join(', ')}), which is what the printer's display reads`,
  );

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
  await watchPrintFromAPhone(page, printer);
  await browsePrinterStorage(page, printer);
  await usePrinterConsole(page, printer);
  await readPrintHistory(page);
  await watchPrinterCamera(page, printer);
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

/**
 * The calibration ledger: what this machine was tuned for, and whether it
 * still holds (P8.5).
 *
 * The rule under test is the one that makes a ledger worth keeping: a result
 * measured on one nozzle and material is never offered as applicable to
 * another. So this records runs through the shipped form, then changes the
 * loaded nozzle and watches every row stop being applicable — without
 * disappearing, because a record that no longer applies is still evidence.
 */
async function keepCalibrationHistory(page) {
  const originalNozzle = await page.evaluate(() => globalThis.window.workspace.getHeadNozzle(0));
  await showInspectorTab(page, 'plates');
  await page.$eval('#calibration-history-details', (details) => details.setAttribute('open', ''));
  await page.waitForSelector('[data-calibration-history-panel="true"]', { timeout: 30_000 });
  assert.match(
    await page.$eval('[data-calibration-history-list]', (node) => node.textContent),
    /No calibration results recorded/,
    'a fresh device has an empty ledger, and says so',
  );

  const recordRun = async (value) => {
    await page.$eval('[data-calibration-history-entry-method]', (select) => {
      select.value = 'retraction-tower';
      select.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
    });
    await page.waitForSelector('[data-calibration-history-entry-value="retractionLengthMm"]', {
      timeout: 30_000,
    });
    await page.$eval(
      '[data-calibration-history-entry-value="retractionLengthMm"]',
      (input, text) => {
        input.value = text;
        input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
      },
      String(value),
    );
    await page.$eval('[data-calibration-history-entry-operator]', (input) => {
      input.value = 'e2e';
      input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
    });
    await page.$eval('[data-calibration-history-submit]', (button) => button.click());
  };

  await recordRun(0.6);
  await page.waitForFunction(
    () => globalThis.document.querySelectorAll('[data-calibration-history-record]').length === 1,
    { timeout: 30_000 },
  );
  const first = await page.evaluate(() => {
    const row = globalThis.document.querySelector('[data-calibration-history-record]');
    return {
      applicable: row?.dataset.calibrationHistoryApplicable,
      chosen: row?.querySelector('[data-calibration-history-chosen]')?.textContent,
      conditions: row?.querySelector('[data-calibration-history-conditions]')?.textContent,
    };
  });
  assert.equal(first.applicable, 'true', 'a result measured on what is loaded now applies');
  assert.equal(first.chosen, '0.6 mm');
  assert.match(first.conditions ?? '', /e2e/, 'the row names who measured it');

  await recordRun(0.8);
  await page.waitForFunction(
    () => globalThis.document.querySelectorAll('[data-calibration-history-record]').length === 2,
    { timeout: 30_000 },
  );

  // A run with no measurement is refused, and writes nothing.
  await page.$eval('[data-calibration-history-entry-value="retractionLengthMm"]', (input) => {
    input.value = '';
    input.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await page.$eval('[data-calibration-history-submit]', (button) => button.click());
  await page.waitForSelector('[data-calibration-history-issue="missing-measurement"]', { timeout: 30_000 });
  assert.equal((await page.$$('[data-calibration-history-record]')).length, 2, 'a refused record writes nothing');

  // Two runs of one method under one set of conditions compare cleanly.
  const ids = await page.$$eval('[data-calibration-history-record]', (rows) =>
    rows.map((row) => row.dataset.calibrationHistoryRecord),
  );
  for (const id of ids) {
    await page.$eval(`[data-calibration-history-select="${id}"]`, (box) => box.click());
  }
  await page.waitForSelector('[data-calibration-history-delta="retractionLengthMm"]', { timeout: 30_000 });
  assert.match(
    await page.$eval('[data-calibration-history-delta="retractionLengthMm"]', (node) => node.textContent),
    /0\.8 → 0\.6 \(-0\.2\)|0\.6 → 0\.8 \(\+0\.2\)/,
  );
  assert.equal(
    (await page.$$('[data-calibration-history-caveat]')).length,
    0,
    'two runs of one method under one set of conditions carry no caveats',
  );

  // Change the nozzle. The records stay — they are evidence — but they stop
  // being applicable, and each says exactly which condition moved.
  const swapped = await page.evaluate(() => {
    const before = globalThis.window.workspace.getHeadNozzle(0);
    globalThis.window.workspace.setHeadNozzle(0, before === '0.6' ? '0.4' : '0.6');
    return globalThis.window.workspace.getHeadNozzle(0) !== before;
  });
  assert.ok(swapped, 'the loaded project has a nozzle that can be changed');
  await page.$eval('[data-calibration-history-refresh]', (button) => button.click());
  await page.waitForFunction(
    () =>
      [...globalThis.document.querySelectorAll('[data-calibration-history-record]')].every(
        (row) => row.dataset.calibrationHistoryApplicable === 'false',
      ),
    { timeout: 30_000 },
  );
  assert.equal(
    (await page.$$('[data-calibration-history-record]')).length,
    2,
    'a record that no longer applies is still a record',
  );
  assert.match(
    await page.$eval('[data-calibration-history-mismatch]', (node) => node.textContent),
    /measured with nozzleDiameterMm/i,
    'and it names the condition that changed',
  );

  // The export is the file someone attaches to a forum post.
  await page.evaluate(() => {
    globalThis.__calibrationBlob = undefined;
    const createObjectURL = globalThis.URL.createObjectURL.bind(globalThis.URL);
    globalThis.URL.createObjectURL = (blob) => {
      if (blob.type === 'application/json') globalThis.__calibrationBlob = blob;
      return createObjectURL(blob);
    };
    const click = globalThis.HTMLAnchorElement.prototype.click;
    globalThis.HTMLAnchorElement.prototype.click = function patched() {
      if (this.download === 'orcaxr-calibration-history.json') return;
      return click.call(this);
    };
  });
  await page.$eval('[data-calibration-history-export]', (button) => button.click());
  const exported = await page.evaluate(async () => globalThis.__calibrationBlob?.text());
  assert.ok(exported, 'the export produced a file');
  const ledger = JSON.parse(exported);
  assert.equal(ledger.format, 'orcaxr.calibration-history');
  assert.equal(ledger.records.length, 2);
  assert.equal(
    /token|apikey|password|secret|https?:\/\/|(?:\d{1,3}\.){3}\d{1,3}/i.test(exported),
    false,
    'the exported ledger carries no address and no credential',
  );

  // Deleting is confirmed, and stays deleted across a real reload.
  await page.evaluate(() => {
    globalThis.window.confirm = () => true;
  });
  await page.$eval('[data-calibration-history-delete]', (button) => button.click());
  await page.waitForFunction(
    () => globalThis.document.querySelectorAll('[data-calibration-history-record]').length === 1,
    { timeout: 30_000 },
  );

  // The deletion is persisted, not merely removed from the list. Read the
  // stored ledger rather than reloading: the suite's project is still open, and
  // a reload here would throw away what the next steps inspect.
  const persisted = await page.evaluate(() => globalThis.localStorage.getItem('orcaxr.calibration-history'));
  assert.ok(persisted, 'the ledger is stored on this device');
  const storedLedger = JSON.parse(persisted);
  assert.equal(storedLedger.records.length, 1, 'the delete reached storage, not just the list');
  assert.equal(
    storedLedger.records[0].id,
    (
      await page.$$eval('[data-calibration-history-record]', (rows) =>
        rows.map((row) => row.dataset.calibrationHistoryRecord),
      )
    )[0],
    'and what is stored is what is shown',
  );

  // Put the nozzle back the way the project had it.
  await page.evaluate((nozzle) => globalThis.window.workspace.setHeadNozzle(0, nozzle), originalNozzle);
  await page.$eval('#calibration-history-details', (details) => details.removeAttribute('open'));
  console.log('[e2e] calibration results recorded, compared, invalidated by a material change, exported, and deleted');
}

/**
 * Watching a print from a phone, and losing the connection while it runs (P9.7).
 *
 * The compact surface is the only printer UI someone sees when they are not on
 * the Printer tab, so what it does when the session drops is the whole point:
 * the last reading stays on screen, labelled with its age, and every command is
 * refused until the machine can confirm its own state again.
 *
 * The other half is the confirmation gesture. Pause is one tap because being
 * slow to reach it costs prints; cancel is a hold, and a hold released early
 * must send nothing at all.
 */
async function watchPrintFromAPhone(page, printer) {
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('resize')));

  // Put the machine back to work; the previous step left it cancelled.
  printer.setState({ printState: 'printing', progress: 0.37, currentLayer: 37, totalLayers: 100 });
  const commandsBefore = printer.commands.length;

  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[data-printer-status-bar]')?.dataset.printerStatusPresent === 'true' &&
      globalThis.document.querySelector('[data-printer-status-bar]')?.hidden === false,
    { timeout: 30_000 },
  );
  const glance = await page.evaluate(() => ({
    headline: globalThis.document.querySelector('[data-printer-status-headline]')?.textContent,
    detail: globalThis.document.querySelector('[data-printer-status-detail]')?.textContent,
    tone: globalThis.document.querySelector('[data-printer-status-tone]')?.dataset.printerStatusTone,
    stale: globalThis.document.querySelector('[data-printer-status-bar]')?.dataset.printerStatusStale,
    width: globalThis.document.querySelector('[data-printer-status-bar]')?.getBoundingClientRect().width,
    overflow: globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth,
    commands: [...globalThis.document.querySelectorAll('[data-printer-status-command]')].map((button) => [
      button.dataset.printerStatusCommand,
      button.dataset.printerStatusHoldMs,
      button.disabled,
    ]),
  }));
  assert.match(glance.headline ?? '', /^Printing /);
  assert.match(glance.detail ?? '', /%/);
  assert.equal(glance.tone, 'active');
  assert.equal(glance.stale, 'false');
  assert.ok(glance.overflow <= 1, `the status surface overflows a 390px shell by ${glance.overflow}px`);
  assert.ok(glance.width <= 390, `the status surface is ${glance.width}px wide in a 390px shell`);
  assert.deepEqual(
    glance.commands,
    [
      ['pause', '0', false],
      ['resume', '0', true],
      ['cancel', '800', false],
      ['emergency-stop', '1200', false],
    ],
    'exactly the destructive commands are held, and availability follows the machine',
  );

  // A tap on a held control sends nothing and says why.
  await pressAndRelease(page, '[data-printer-status-command="cancel"]', 60);
  await page.waitForFunction(
    () => /longer hold/i.test(globalThis.document.querySelector('[data-printer-status-hold-note]')?.textContent ?? ''),
    { timeout: 10_000 },
  );
  assert.equal(printer.commands.length, commandsBefore, 'a released-too-early cancel sends nothing');

  // A hold that is abandoned mid-gesture also sends nothing.
  await page.$eval('[data-printer-status-command="cancel"]', (button) => {
    button.dispatchEvent(new globalThis.PointerEvent('pointerdown', { bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await page.$eval('[data-printer-status-command="cancel"]', (button) => {
    button.dispatchEvent(new globalThis.PointerEvent('pointerleave', { bubbles: true }));
  });
  await page.waitForFunction(
    () =>
      /cancelled — nothing was sent/i.test(
        globalThis.document.querySelector('[data-printer-status-hold-note]')?.textContent ?? '',
      ),
    { timeout: 10_000 },
  );
  assert.equal(printer.commands.length, commandsBefore, 'a hold the pointer left sends nothing');

  // Pause is one tap, because being slow to reach it costs prints.
  await pressAndRelease(page, '[data-printer-status-command="pause"]', 10);
  await page.waitForFunction(
    () => /^Paused/.test(globalThis.document.querySelector('[data-printer-status-headline]')?.textContent ?? ''),
    { timeout: 30_000 },
  );
  assert.deepEqual(printer.commands.slice(commandsBefore), ['pause']);
  await pressAndRelease(page, '[data-printer-status-command="resume"]', 10);
  await page.waitForFunction(
    () => /^Printing /.test(globalThis.document.querySelector('[data-printer-status-headline]')?.textContent ?? ''),
    { timeout: 30_000 },
  );
  assert.deepEqual(printer.commands.slice(commandsBefore), ['pause', 'resume']);

  // Lose the session the way a Wi-Fi blip does: the socket goes, the printer
  // keeps printing, and this client has to say so honestly.
  assert.ok(printer.dropSockets() > 0, 'the client had a live socket to lose');
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-printer-status-bar]')?.dataset.printerStatusStale === 'true',
    { timeout: 30_000 },
  );
  const lost = await page.evaluate(() => ({
    headline: globalThis.document.querySelector('[data-printer-status-headline]')?.textContent,
    detail: globalThis.document.querySelector('[data-printer-status-detail]')?.textContent,
    tone: globalThis.document.querySelector('[data-printer-status-tone]')?.dataset.printerStatusTone,
    recovery: globalThis.document.querySelector('[data-printer-status-recovery-message]')?.textContent,
    reconnect: globalThis.document.querySelector('[data-printer-status-reconnect]')?.textContent,
    commands: [...globalThis.document.querySelectorAll('[data-printer-status-command]')].map((button) => [
      button.dataset.printerStatusCommand,
      button.disabled,
      button.title,
    ]),
  }));
  assert.match(lost.headline ?? '', /^Printing /, 'the last thing the machine said stays on screen');
  assert.match(lost.detail ?? '', /^Last reading /, 'and it is labelled with its age, not presented as current');
  assert.equal(lost.tone, 'attention', 'a dropped socket is not a failed print');
  assert.ok(lost.recovery, 'a lost session says what is being done about it');
  assert.match(lost.reconnect ?? '', /Reconnect|Connect/);
  assert.equal(
    lost.commands.every(([, disabled]) => disabled === true),
    true,
    'nothing may be commanded against a state nothing can confirm',
  );
  assert.equal(
    lost.commands.every(([, , title]) => typeof title === 'string' && title.length > 0),
    true,
    'and each refusal says why',
  );

  // The transport retries on its own, so the recovery someone reads has to say
  // that rather than demand an action. It then actually recovers, unassisted,
  // and the surface goes back to showing a reading it can stand behind.
  assert.match(lost.recovery ?? '', /Retrying on its own/);
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-printer-status-bar]')?.dataset.printerStatusStale === 'false',
    { timeout: 60_000 },
  );
  assert.deepEqual(
    printer.commands.slice(commandsBefore),
    ['pause', 'resume'],
    'nothing was sent while the state could not be confirmed',
  );
  assert.match(
    await page.$eval('[data-printer-status-detail]', (node) => node.textContent),
    /%/,
    'a recovered session shows a live reading again',
  );
  assert.equal(
    await page.$eval('[data-printer-status-command="cancel"]', (button) => button.disabled),
    false,
    'and commands are offered again once the machine can confirm its own state',
  );

  // And a completed hold does exactly what it said it would.
  await pressAndRelease(page, '[data-printer-status-command="cancel"]', 1_100);
  // The hold *is* the confirmation, so no second dialog stands between the
  // gesture and the machine, and nothing is left on screen to dismiss.
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-print-job-state]')?.dataset.printJobState === 'cancelled',
    { timeout: 30_000 },
  );
  assert.deepEqual(printer.commands.slice(commandsBefore), ['pause', 'resume', 'cancel']);
  assert.equal(
    await page.$('[data-print-job-confirm="true"]'),
    null,
    'the hold replaced the dialog rather than adding to it',
  );

  // Nothing is running, so the surface gets out of the way of the plate again.
  await page.waitForFunction(() => globalThis.document.querySelector('[data-printer-status-bar]')?.hidden === true, {
    timeout: 30_000,
  });

  // …unless it is deliberately pinned, which is what the menu action is for.
  await clickMenuAction(page, 'printer_show_status');
  await page.waitForFunction(() => globalThis.document.querySelector('[data-printer-status-bar]')?.hidden === false, {
    timeout: 30_000,
  });
  assert.match(
    await page.$eval('[data-printer-status-headline]', (node) => node.textContent),
    /^Cancelled/,
    'a pinned surface shows the outcome rather than the reading it hid on',
  );
  await clickMenuAction(page, 'printer_show_status');
  await page.waitForFunction(() => globalThis.document.querySelector('[data-printer-status-bar]')?.hidden === true, {
    timeout: 30_000,
  });

  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('resize')));
  console.log('[e2e] print watched from a phone, survived a dropped session, and cancelled only on a full hold');
}

/** Press a control, hold it for `holdMs`, then release — the shipped gesture. */
async function pressAndRelease(page, selector, holdMs) {
  await page.$eval(selector, (button) => {
    button.dispatchEvent(new globalThis.PointerEvent('pointerdown', { bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await page.$eval(selector, (button) => {
    button.dispatchEvent(new globalThis.PointerEvent('pointerup', { bubbles: true }));
  });
}

/**
 * The other half of a print workflow: the files already on the machine.
 *
 * Everything here is driven through the shipped panel rather than the module,
 * because the failures that matter are the wiring ones — an action the surface
 * cannot reach, a delete that acts on the wrong row, a thumbnail requested with
 * the credential in a URL. The simulator holds a scanned file with a thumbnail
 * and an unscanned one, so "reports nothing" is checked against a real absence.
 */
async function browsePrinterStorage(page, printer) {
  printer.putFile(
    'projects/tower.gcode',
    Buffer.from('G1 X1 Y1 E1\n'),
    {
      estimated_time: 5400,
      filament_weight_total: 21.5,
      slicer: 'OrcaSlicer',
      thumbnails: [{ width: 300, height: 300, size: 8, relative_path: '.thumbs/tower.png' }],
    },
    1_800_000_000,
  );
  printer.putFile('projects/.thumbs/tower.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  await showInspectorTab(page, 'printer');
  await page.$eval('#printer-storage-details', (details) => {
    details.closest('details')?.setAttribute('open', '');
    details.setAttribute('open', '');
  });
  await page.waitForSelector('[data-printer-storage-panel="true"]', { timeout: 30_000 });
  await page.$eval('[data-printer-storage-refresh]', (button) => button.click());
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-printer-storage-list]')?.textContent.includes('projects'),
    { timeout: 30_000 },
  );

  // Folders are navigable; the uploaded plates live at the root, the seeded
  // file one level down.
  await page.$eval('[data-printer-storage-list]', (list) => {
    const row = [...list.querySelectorAll('button')].find((button) => button.textContent.includes('projects'));
    if (!row) throw new Error('no projects folder row');
    row.click();
  });
  await page.waitForSelector('[data-printer-storage-file="projects/tower.gcode"]', { timeout: 30_000 });

  await page.$eval('[data-printer-storage-file="projects/tower.gcode"]', (row) => row.click());
  await page.waitForFunction(() => globalThis.document.querySelector('[data-printer-storage-thumbnail]') !== null, {
    timeout: 30_000,
  });
  const facts = await page.$eval('[data-printer-storage-facts]', (list) =>
    [...list.children].map((node) => node.textContent),
  );
  assert.ok(facts.includes('1 h 30 min'), `estimated time missing from ${JSON.stringify(facts)}`);
  assert.ok(facts.includes('21.5 g'), `filament weight missing from ${JSON.stringify(facts)}`);
  assert.equal(
    await page.$eval('[data-printer-storage-thumbnail]', (image) => image.src.startsWith('blob:')),
    true,
    'the thumbnail is fetched with the session credential, never by pointing an <img> at the printer',
  );

  // Reprint the stored file: nothing is uploaded, and the live job picks it up.
  const storedBefore = printer.stored.size;
  await page.$eval('[data-printer-storage-action="print"]', (button) => button.click());
  await page.waitForFunction(
    () => /^Printing projects\/tower\.gcode/.test(globalThis.document.getElementById('status-text')?.textContent ?? ''),
    { timeout: 30_000 },
  );
  assert.equal(printer.started, 'projects/tower.gcode');
  assert.equal(printer.stored.size, storedBefore, 'a reprint uploads nothing');

  // Rename in place, then delete after an explicit confirmation.
  await page.evaluate(() => {
    globalThis.window.prompt = () => 'tower-v2.gcode';
  });
  await page.$eval('[data-printer-storage-action="rename"]', (button) => button.click());
  await page.waitForSelector('[data-printer-storage-file="projects/tower-v2.gcode"]', { timeout: 30_000 });
  assert.equal(printer.stored.has('projects/tower.gcode'), false);

  await page.$eval('[data-printer-storage-file="projects/tower-v2.gcode"]', (row) => row.click());
  await page.$eval('[data-printer-storage-action="delete"]', (button) => button.click());
  await page.waitForSelector('[data-print-job-confirm="true"]', { timeout: 30_000 });
  await page.click('[data-print-job-confirm-choice="cancel"]');
  await page.waitForFunction(() => !globalThis.document.querySelector('[data-print-job-confirm="true"]'));
  assert.equal(printer.stored.has('projects/tower-v2.gcode'), true, 'a dismissed delete removes nothing');

  await page.$eval('[data-printer-storage-action="delete"]', (button) => button.click());
  await page.waitForSelector('[data-print-job-confirm="true"]', { timeout: 30_000 });
  await page.click('[data-print-job-confirm-choice="confirm"]');
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-printer-storage-file="projects/tower-v2.gcode"]') === null,
    { timeout: 30_000 },
  );
  assert.equal(printer.stored.has('projects/tower-v2.gcode'), false);
  assert.equal(printer.stored.has('projects/.thumbs/tower.png'), true, 'a sibling survived the delete');
  await page.$eval('#printer-storage-details', (details) => details.removeAttribute('open'));
  console.log('[e2e] printer storage browsed, reprinted, renamed, and deleted behind a confirmation');
}

/**
 * The G-code console and the printer's own macros.
 *
 * The safety model is the thing under test: a query goes straight through, a
 * command that moves or halts states what it does and sends nothing when the
 * confirmation is dismissed, and the printer's reply arrives over the socket
 * rather than in the HTTP response.
 */
async function usePrinterConsole(page, printer) {
  await showInspectorTab(page, 'printer');
  await page.$eval('#printer-console-details', (details) => details.setAttribute('open', ''));
  await page.waitForSelector('[data-printer-console-panel="true"]', { timeout: 30_000 });

  // A pure query needs no confirmation, and the answer comes back over the
  // socket — an HTTP-only console would show nothing at all here.
  const beforeQuery = printer.commands.length;
  await setDomInput(page, '[data-printer-console-input]', 'M115');
  assert.equal(
    await page.$eval('[data-printer-console-assessment]', (line) => line.dataset.printerConsoleLevel),
    'safe',
  );
  await page.$eval('[data-printer-console-send]', (button) => button.click());
  await page.waitForFunction(
    () =>
      [...globalThis.document.querySelectorAll('[data-printer-console-entry="received"]')].some((line) =>
        line.textContent.includes('FIRMWARE_NAME:Klipper'),
      ),
    { timeout: 30_000 },
  );
  assert.deepEqual(printer.commands.slice(beforeQuery), ['gcode:M115']);

  // A command that drops the gantry states so, and a dismissed confirmation
  // must send nothing at all.
  await setDomInput(page, '[data-printer-console-input]', 'M84');
  const assessment = await page.$eval('[data-printer-console-assessment]', (line) => ({
    level: line.dataset.printerConsoleLevel,
    text: line.textContent,
  }));
  assert.equal(assessment.level, 'dangerous');
  assert.match(assessment.text, /Z axis can drop/);
  const beforeDismissed = printer.commands.length;
  await page.$eval('[data-printer-console-send]', (button) => button.click());
  await page.waitForSelector('[data-print-job-confirm="true"]', { timeout: 30_000 });
  await page.click('[data-print-job-confirm-choice="cancel"]');
  await page.waitForFunction(() => !globalThis.document.querySelector('[data-print-job-confirm="true"]'));
  assert.equal(printer.commands.length, beforeDismissed, 'a dismissed console command sends nothing');

  // Macros come from the printer's own configuration, carrying their own risk.
  await page.$eval('[data-printer-console-refresh-macros]', (button) => button.click());
  await page.waitForSelector('[data-printer-console-macro="PARK_HEAD"]', { timeout: 30_000 });
  await page.waitForSelector('[data-printer-console-macro="RESET_EVERYTHING"]', { timeout: 30_000 });
  assert.match(
    await page.$eval('[data-printer-console-macro="PARK_HEAD"]', (button) => button.title),
    /Parameters: X=0, Y=200/,
  );

  // Running it asks for each parameter, then sends the built invocation once
  // its own assessment has been confirmed.
  await page.evaluate(() => {
    globalThis.window.prompt = (label) => (label.includes('X') ? '10' : '190');
  });
  const beforeMacro = printer.commands.length;
  await page.$eval('[data-printer-console-macro="PARK_HEAD"]', (button) => button.click());
  await page.waitForSelector('[data-print-job-confirm="true"]', { timeout: 30_000 });
  await page.click('[data-print-job-confirm-choice="confirm"]');
  await page.waitForFunction(
    () =>
      [...globalThis.document.querySelectorAll('[data-printer-console-entry="sent"]')].some((line) =>
        line.textContent.includes('PARK_HEAD X=10 Y=190'),
      ),
    { timeout: 30_000 },
  );
  assert.deepEqual(printer.commands.slice(beforeMacro), ['gcode:PARK_HEAD X=10 Y=190']);

  await page.$eval('#printer-console-details', (details) => details.removeAttribute('open'));
  console.log('[e2e] printer console queried, refused a dismissed stepper release, and ran a macro with parameters');
}

/**
 * The printer's own record of what it has run.
 *
 * Paging is the part a unit test cannot prove: the pager has to be driven by
 * the count the printer reports, not by how many rows happened to arrive, or
 * the last page silently becomes unreachable.
 */
async function readPrintHistory(page) {
  await showInspectorTab(page, 'printer');
  await page.$eval('#printer-history-details', (details) => details.setAttribute('open', ''));
  await page.waitForSelector('[data-print-history-panel="true"]', { timeout: 30_000 });
  await page.$eval('[data-print-history-refresh]', (button) => button.click());
  await page.waitForSelector('[data-print-history-job="000001"]', { timeout: 30_000 });

  const totals = await page.$eval('[data-print-history-totals]', (node) => node.textContent);
  assert.match(totals, /23 jobs/);
  assert.match(totals, /21 h 5 min printing/);
  assert.match(totals, /96\.60 m filament/);

  // A job the printer never finished reports nothing rather than zeroes, and a
  // file that is gone says so instead of implying it can be reprinted.
  const running = await page.$eval('[data-print-history-job="000001"]', (row) => ({
    status: row.querySelector('[data-print-history-status-label]')?.dataset.printHistoryStatusLabel,
    facts: row.querySelector('[data-print-history-facts]')?.textContent,
  }));
  assert.equal(running.status, 'in_progress');
  assert.match(running.facts, /Printed —/);
  assert.match(running.facts, /— filament/);
  assert.equal(
    await page.$eval('[data-print-history-job="000002"] [data-print-history-missing]', (node) => node.textContent),
    'No longer on the printer',
  );

  // A completed run is comparable against its own estimate.
  assert.match(
    await page.$eval('[data-print-history-job="000003"] [data-print-history-facts]', (node) => node.textContent),
    /\+10% vs estimate/,
  );

  const firstPage = await page.$eval('[data-print-history-page-label]', (node) => node.textContent);
  assert.equal(firstPage, 'Page 1 of 2 — 23 jobs');
  assert.equal(await page.$eval('[data-print-history-previous]', (button) => button.disabled), true);

  await page.$eval('[data-print-history-next]', (button) => button.click());
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-print-history-page-label]')?.textContent === 'Page 2 of 2 — 23 jobs',
    { timeout: 30_000 },
  );
  assert.equal(
    await page.$eval('[data-print-history-next]', (button) => button.disabled),
    true,
    'the last page is last',
  );
  assert.equal(
    await page.$$eval('[data-print-history-job]', (rows) => rows.length),
    3,
    'the final page holds the remainder',
  );
  await page.$eval('[data-print-history-previous]', (button) => button.click());
  await page.waitForSelector('[data-print-history-job="000001"]', { timeout: 30_000 });

  await page.$eval('#printer-history-details', (details) => details.removeAttribute('open'));
  console.log('[e2e] print history read, paged to the last job, and back');
}

/**
 * The camera, and the polling policy that comes with it.
 *
 * Each frame is a separate authenticated request, so the assertion that matters
 * as much as the picture is that the requests stop when the section is closed.
 */
async function watchPrinterCamera(page, printer) {
  await showInspectorTab(page, 'printer');
  await page.$eval('#btn-printer-webcam', (button) => button.click());
  await page.waitForSelector('[data-printer-camera-panel="true"]', { timeout: 30_000 });
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-printer-camera-select]')?.options.length === 2,
    { timeout: 30_000 },
  );

  // The camera that can actually be shown is chosen first, and its frame is
  // fetched as bytes: a blob URL, never a URL pointed at the printer.
  await page.waitForFunction(
    () => {
      const image = globalThis.document.querySelector('[data-printer-camera-frame]');
      return image && !image.hidden && image.src.startsWith('blob:');
    },
    { timeout: 30_000 },
  );
  assert.equal(await page.$eval('[data-printer-camera-select]', (select) => select.value), 'cam-nozzle');
  assert.match(
    await page.$eval('[data-printer-camera-caption]', (node) => node.textContent),
    /Nozzle — mjpegstreamer-adaptive, shown as authenticated snapshots at up to 4 fps/,
  );
  // The mount is reproduced rather than ignored.
  assert.equal(await page.$eval('[data-printer-camera-frame]', (image) => image.style.transform), 'rotate(180deg)');
  assert.ok(printer.snapshotRequests > 0, 'frames were fetched from the printer');

  // A stream-only camera is listed with its reason instead of being hidden.
  await page.$eval('[data-printer-camera-select]', (select) => {
    select.value = 'cam-chamber';
    select.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () =>
      /cannot carry the printer API key/.test(
        globalThis.document.querySelector('[data-printer-camera-placeholder]')?.textContent ?? '',
      ),
    { timeout: 30_000 },
  );
  assert.equal(await page.$eval('[data-printer-camera-live]', (button) => button.disabled), true);

  // Back to the working camera, then close the section: polling must stop.
  await page.$eval('[data-printer-camera-select]', (select) => {
    select.value = 'cam-nozzle';
    select.dispatchEvent(new globalThis.Event('change', { bubbles: true }));
  });
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-printer-camera-live]')?.dataset.printerCameraPolling === 'true',
    { timeout: 30_000 },
  );
  await page.$eval('#printer-camera-details', (details) => {
    details.open = false;
    details.dispatchEvent(new globalThis.Event('toggle'));
  });
  await page.waitForFunction(
    () => globalThis.document.querySelector('[data-printer-camera-live]')?.dataset.printerCameraPolling === 'false',
    { timeout: 30_000 },
  );
  const idle = printer.snapshotRequests;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(printer.snapshotRequests, idle, 'a hidden camera fetches nothing');
  console.log('[e2e] printer camera shown as authenticated snapshots, and stopped fetching once hidden');
}

function checksumOf(buffer) {
  let checksum = 5381;
  for (const byte of buffer) checksum = ((checksum * 33) ^ byte) >>> 0;
  return checksum;
}

async function clickMenuAction(page, actionId) {
  await page.$eval(`[data-action-id="${actionId}"]`, (item) => {
    // On a window too narrow for the menu bar the whole bar sits behind the
    // hamburger, so that is the first thing an operator presses.
    const bar = globalThis.document.getElementById('menu-bar-host');
    if (bar && globalThis.getComputedStyle(bar).display === 'none') {
      globalThis.document.getElementById('menu-button')?.click();
    }
    // The trigger toggles, so a section that is already open must not be
    // pressed again — that would close the menu the item is in.
    const host = item.closest('.menu-host');
    if (host && !host.classList.contains('open')) host.querySelector('.menu-trigger')?.click();
  });
  const diagnosis = await page.$eval(`[data-action-id="${actionId}"]`, (item) => {
    const rect = item.getBoundingClientRect();
    const style = globalThis.getComputedStyle(item);
    const centre = globalThis.document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      display: style.display,
      visibility: style.visibility,
      onTop: centre ? `${centre.tagName}.${centre.className}` : null,
      viewport: [globalThis.innerWidth, globalThis.innerHeight],
    };
  });
  try {
    await page.click(`[data-action-id="${actionId}"]`);
  } catch (error) {
    throw new Error(`menu action ${actionId} was not clickable: ${JSON.stringify(diagnosis)}`, { cause: error });
  }
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
const printer = await startMoonrakerSimulator({
  // Klipper reports its macros through `configfile.settings`; the console reads
  // parameters out of the bodies rather than inventing a schema Klipper lacks.
  configSettings: {
    'gcode_macro park_head': {
      description: 'Park the toolhead at the back left',
      gcode: 'G1 X{params.X|default(0)} Y{params.Y|default(200)} F6000',
    },
    'gcode_macro reset_everything': { gcode: 'FIRMWARE_RESTART' },
  },
  gcodeResponses: { M115: 'FIRMWARE_NAME:Klipper FIRMWARE_VERSION:v0.12.0' },
  // Enough recorded jobs to page, including one the printer never finished and
  // one whose file has since been deleted.
  history: Array.from({ length: 23 }, (_, index) => ({
    job_id: String(index + 1).padStart(6, '0'),
    filename: `history/job-${index + 1}.gcode`,
    status: index === 0 ? 'in_progress' : index % 5 === 0 ? 'cancelled' : 'completed',
    start_time: 1_800_000_000 - index * 7200,
    end_time: index === 0 ? 0 : 1_800_003_600 - index * 7200,
    ...(index === 0 ? {} : { print_duration: 3300 + index, total_duration: 3600 + index, filament_used: 4200 + index }),
    exists: index !== 1,
    metadata: { estimated_time: 3000 },
  })),
  // One camera that can be shown as snapshots, and one that only streams.
  webcams: [
    {
      uid: 'cam-nozzle',
      name: 'Nozzle',
      service: 'mjpegstreamer-adaptive',
      enabled: true,
      target_fps: 10,
      snapshot_url: '/webcam/snapshot',
      stream_url: '/webcam/?action=stream',
      rotation: 180,
    },
    { uid: 'cam-chamber', name: 'Chamber', service: 'webrtc-go2rtc', enabled: true, stream_url: '/webrtc' },
  ],
  historyTotals: {
    total_jobs: 23,
    total_time: 82_800,
    total_print_time: 75_900,
    total_filament_used: 96_600,
    longest_print: 3322,
  },
});
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

  await configurePrinterLibrary(page, fixtureDirectory);

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
    await page.evaluate(() => {
      const active = globalThis.document.activeElement;
      return active?.classList.contains('menu-trigger') ? active.getAttribute('aria-controls') : (active?.id ?? '');
    }),
    'oxr-menu-help',
    'closing the dialog returns focus to the menu the item was invoked from',
  );

  await surviveEveryViewport(page);

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
  await toggleViewOverlays(page);
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
    // The trigger toggles, so a section that is already open must not be
    // pressed again — that would close the menu the item is in.
    const host = item.closest('.menu-host');
    if (host && !host.classList.contains('open')) host.querySelector('.menu-trigger')?.click();
  });
  const openProject = await page.$('[data-action-id="file_open_project"]');
  assert.ok(openProject, 'Open Project action is available');
  const [projectChooser] = await Promise.all([page.waitForFileChooser(), openProject.click()]);
  await projectChooser.accept([fixturePath]);
  // The workspace is empty here, so there is no decision to put in front of
  // anyone: nothing is replaced, nothing authored is lost, and repairs report
  // themselves afterwards. The project must simply open.
  await page.waitForFunction(() => (globalThis.window.workspace?.getCanonicalSummary?.().objectCount ?? 0) === 2, {
    timeout: 60_000,
  });
  assert.equal(
    await page.$('[data-project-import-preview="true"]'),
    null,
    'opening a project into an empty workspace must not interrupt with a preview',
  );

  // Opening a project OVER open work is a decision, so the preview appears.
  await page.$eval('[data-action-id="file_open_project"]', (item) => {
    // The trigger toggles, so a section that is already open must not be
    // pressed again — that would close the menu the item is in.
    const host = item.closest('.menu-host');
    if (host && !host.classList.contains('open')) host.querySelector('.menu-trigger')?.click();
  });
  const replaceOverOpenWork = await page.$('[data-action-id="file_open_project"]');
  const [replaceChooser] = await Promise.all([page.waitForFileChooser(), replaceOverOpenWork.click()]);
  await replaceChooser.accept([fixturePath]);
  await page.waitForSelector('[data-project-import-preview="true"] [role="dialog"]', { timeout: 60_000 });
  const importPreview = await page.$eval('[data-project-import-preview="true"]', (overlay) => {
    const replace = [...overlay.querySelectorAll('button')].find((button) => button.textContent === 'Replace project');
    const notices = [...overlay.querySelectorAll('[data-notice-id]')];
    return {
      title: overlay.querySelector('#project-import-preview-title')?.textContent,
      summary: overlay.querySelector('#project-import-preview-summary')?.textContent,
      notices: notices.map((notice) => notice.textContent),
      noticesVisible: notices.every((notice) => notice.getClientRects().length > 0),
      markedNotices: overlay.querySelectorAll('[data-notice-id][data-acknowledgement-id]').length,
      replaceDisabled: replace?.disabled,
    };
  });
  assert.match(importPreview.title, /^Open .+\?$/i);
  assert.match(importPreview.summary, /2 plate\(s\), 2 object\(s\)/i);
  assert.match(importPreview.summary, /one undoable canonical command/i);
  assert.ok(importPreview.notices.length > 0, 'foreign project import notices are listed');
  assert.equal(importPreview.noticesVisible, true, 'every project import notice is visible');
  // Acknowledging is one act, not one per row: every notice stays visible, and
  // the notices that carry the decision are marked, but confirming is what
  // acknowledges them. An unblocked preview is therefore confirmable on arrival.
  assert.equal(importPreview.replaceDisabled, false, 'an unblocked preview confirms without per-notice ticking');
  // This fixture's notices are all reported ones (repairs and diagnostics), so
  // none is marked. The preview appeared purely because work was already open —
  // which is the decision it exists to put in front of the operator.
  assert.equal(importPreview.markedNotices, 0, 'nothing here loses authored data, so nothing is marked');
  assert.equal(
    await page.$eval(
      '[data-project-import-preview="true"]',
      (overlay) => overlay.querySelectorAll('input[data-acknowledgement-id]').length,
    ),
    0,
    'the per-notice checkbox gate is gone',
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
  // Cancelling leaves the project that is already open exactly as it was, which
  // is what makes the preview a decision rather than a formality.
  const cancelPreview = (
    await Promise.all(
      previewButtons.map(async (button) =>
        (await button.evaluate((node) => node.textContent)) === 'Cancel' ? button : null,
      ),
    )
  ).find(Boolean);
  assert.ok(cancelPreview, 'the preview can be declined');
  await cancelPreview.click();
  await page.waitForFunction(() => !globalThis.document.querySelector('[data-project-import-preview="true"]'), {
    timeout: 30_000,
  });
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
    // The trigger toggles, so a section that is already open must not be
    // pressed again — that would close the menu the item is in.
    const host = item.closest('.menu-host');
    if (host && !host.classList.contains('open')) host.querySelector('.menu-trigger')?.click();
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
  assert.equal(await page.$eval('#model-toolbar [data-action-id="tool_move"]', (node) => node.disabled), true);
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

  // Selecting a model in the viewport and pressing a colour is the whole
  // interaction the flat shell promises. It is the same canonical action the
  // selector above just used, so what is proved here is the surface: the bar
  // appears for a viewport selection, offers the loaded filaments, and commits
  // on the first press without a confirming button.
  assert.equal(
    await page.$eval('#selection-filament-host', (host) => host.hidden),
    false,
    'the selection above already keeps the one-press bar on screen',
  );
  const clickedModel = await page.evaluate(() => {
    const workspace = globalThis.window.workspace;
    workspace.selectModel(workspace.models[0]);
    const snapshot = workspace.getFilamentAssignmentSnapshot();
    const target = snapshot.options.find(
      (option) => option.enabled && option.id !== snapshot.scopes[0]?.localFilamentId,
    );
    return {
      label: snapshot.scopes[0]?.label,
      scopeCount: snapshot.scopes.length,
      targetId: target?.id,
      undoCount: workspace.getCanonicalSummary().history.undoCount,
    };
  });
  assert.equal(clickedModel.scopeCount, 1, 'clicking one model is one assignable scope, not a refusal');
  assert.ok(clickedModel.targetId, 'the bar has a filament to offer that is not already assigned');
  await page.waitForFunction(
    (label) =>
      globalThis.document.querySelector('[data-selection-filament-label]')?.textContent === label &&
      globalThis.document.getElementById('selection-filament-host')?.hidden === false,
    {},
    clickedModel.label,
  );
  const barChips = await page.$$eval('[data-selection-filament-chip]', (nodes) =>
    nodes.map((node) => node.dataset.selectionFilamentChip),
  );
  assert.ok(barChips.includes('inherit'), 'the bar can also put a scope back on its default');
  assert.ok(
    barChips.filter((kind) => kind === 'physical').length >= 2,
    'every loaded head is one press away, not one menu away',
  );
  await page.$eval(
    '[data-selection-filament-chip]',
    (_node, targetId) => {
      globalThis.document
        .querySelector(`[data-selection-filament-chip][data-filament-id="${globalThis.CSS.escape(targetId)}"]`)
        ?.click();
    },
    clickedModel.targetId,
  );
  await page.waitForFunction(
    ({ targetId, undoCount }) => {
      const workspace = globalThis.window.workspace;
      const scopes = workspace.getFilamentAssignmentSnapshot().scopes;
      return (
        scopes.length === 1 &&
        scopes[0].localFilamentId === targetId &&
        workspace.getCanonicalSummary().history.undoCount === undoCount + 1
      );
    },
    {},
    { targetId: clickedModel.targetId, undoCount: clickedModel.undoCount },
  );
  assert.equal(
    await page.$eval('[data-selection-filament-chip][aria-pressed="true"]', (node) => node.dataset.filamentId ?? ''),
    clickedModel.targetId,
    'the pressed chip reads back as what the selection now prints in',
  );
  await clickMenuAction(page, 'edit_undo');
  await page.waitForFunction(
    (undoCount) => globalThis.window.workspace.getCanonicalSummary().history.undoCount === undoCount,
    {},
    clickedModel.undoCount,
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
  assert.equal(await page.$eval('#model-toolbar [data-action-id="tool_move"]', (node) => node.disabled), false);
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

  await overrideOneObjectSetting(page);
  await stepOneSettingWithoutAKeyboard(page);
  await rightClickTheScene(page);

  // The responsive PlateManager owns guarded canonical plate operations. Add
  // starts in the existing plate bar; every subsequent operation is driven
  // through the manager and asserted from canonical summaries/tree IDs.
  // The plate strip sits over the build plate, so adding starts in Prepare;
  // the manager is a Project-page panel, so everything after it happens there.
  // The flow crosses both exactly as an operator's does.
  await showInspectorTab(page, 'objects');
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
  await showInspectorTab(page, 'plates');
  await page.$eval('#plate-manager-host', (host) => {
    const details = host.closest('details');
    if (details) details.open = true;
  });
  await page.waitForSelector('#plate-manager-host [data-plate-manager-list="true"]');
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

  // ---- First run: configure once, and have it still be configured later ----
  //
  // A printer and a slicer that must be re-entered on every reload are not
  // really configured, so this proves the whole loop in a real browser: the
  // first-run prompt, the values surviving a fresh page, and the switch that
  // erases them again.
  await showInspectorTab(page, 'printer');
  await setDomInput(page, '#printer-host', 'http://127.0.0.1:7125');
  await setDomInput(page, '#printer-api-key', 'e2e-printer-key');
  await setDomInput(page, '#external-slicer-token', 'e2e-slicer-token');
  assert.equal(
    await page.$eval('#empty-setup-printer', (element) => element.hidden),
    true,
    'the first-run prompt retires once a printer is configured',
  );

  const reloaded = await openReadyPage(browser, url, { width: 1280, height: 720 });
  try {
    assert.equal(await reloaded.$eval('#printer-host', (element) => element.value), 'http://127.0.0.1:7125');
    assert.equal(await reloaded.$eval('#printer-api-key', (element) => element.value), 'e2e-printer-key');
    assert.equal(await reloaded.$eval('#external-slicer-token', (element) => element.value), 'e2e-slicer-token');
    assert.equal(
      await reloaded.$eval('#empty-setup-printer', (element) => element.hidden),
      true,
      'a configured install never shows the first-run prompt again',
    );

    // Turning remembering off has to erase what is already stored, not merely
    // stop writing more.
    await showInspectorTab(reloaded, 'printer');
    await reloaded.click('#btn-forget-credentials');
    assert.equal(
      await reloaded.evaluate(() => globalThis.localStorage.getItem('orcaxr.credentials')),
      null,
      'forgetting removes the stored credentials entirely',
    );
    assert.equal(await reloaded.$eval('#printer-api-key', (element) => element.value), '');
  } finally {
    await reloaded.close();
  }

  // ---- Named printers: add two, switch, and keep them apart ----------------
  //
  // The acceptance criterion names both machines: they must add from a clean
  // profile, switch safely, and keep independent credentials. A key that
  // follows a switch is a key sent to the wrong printer.
  await showInspectorTab(page, 'printer');
  await page.evaluate(() => {
    globalThis.prompt = (_message, fallback) => globalThis.__printerName ?? fallback;
    globalThis.confirm = () => true;
  });
  await setDomInput(page, '#printer-host', 'http://127.0.0.1:7125');
  await page.evaluate(() => {
    globalThis.__printerName = 'Snapmaker U1';
  });
  await page.click('#btn-printer-add');
  await setDomInput(page, '#printer-api-key', 'U1-KEY-EXAMPLE');

  await setDomInput(page, '#printer-host', 'http://127.0.0.1:7126');
  await page.evaluate(() => {
    globalThis.__printerName = 'Elegoo Centauri Carbon';
  });
  await page.click('#btn-printer-add');
  await setDomInput(page, '#printer-api-key', 'ELEGOO-KEY-EXAMPLE');

  const printerNames = await page.$$eval('#printer-select option', (options) =>
    options.map((option) => option.textContent),
  );
  assert.deepStrictEqual(printerNames, ['Snapmaker U1', 'Elegoo Centauri Carbon']);

  const u1Value = await page.$$eval(
    '#printer-select option',
    (options) => options.filter((option) => option.textContent === 'Snapmaker U1').map((option) => option.value)[0],
  );
  await page.select('#printer-select', u1Value);
  assert.equal(await page.$eval('#printer-host', (element) => element.value), 'http://127.0.0.1:7125');
  assert.equal(
    await page.$eval('#printer-api-key', (element) => element.value),
    'U1-KEY-EXAMPLE',
    'each printer keeps its own credential across a switch',
  );

  // ---- Preferences: versioned, migrated, resettable without losing work ----
  await showInspectorTab(page, 'printer');
  await page.click('#pref-reduce-motion');
  assert.equal(
    await page.evaluate(() => globalThis.document.documentElement.dataset.reduceMotion),
    'always',
    'a preference with no observable effect would be worse than not offering it',
  );

  const presetsBefore = await page.evaluate(() => globalThis.localStorage.getItem('orcaxr.profiles'));
  await page.click('#btn-prefs-reset');
  const afterReset = await page.evaluate(() => ({
    prefs: globalThis.localStorage.getItem('orcaxr.preferences'),
    printer: globalThis.localStorage.getItem('orcaxr.printer'),
    presets: globalThis.localStorage.getItem('orcaxr.profiles'),
    motion: globalThis.document.documentElement.dataset.reduceMotion,
  }));
  assert.equal(afterReset.prefs, null);
  assert.equal(afterReset.printer, null);
  assert.equal(afterReset.motion, undefined, 'the override lifts live, not on next reload');
  // The acceptance criterion: restoring settings must not cost the operator
  // their presets.
  assert.equal(afterReset.presets, presetsBefore, 'presets survive a settings reset');

  assert.deepStrictEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join('\n')}`);
  assert.deepStrictEqual(policyErrors, [], `CSP violations: ${policyErrors.join('\n')}`);
  // Last of all: recording a result and then changing the loaded filament
  // invalidates the sliced artifact and adds undoable commands, so this runs
  // once nothing else depends on the preview or the history depth.
  await keepCalibrationHistory(page);

  console.log(
    'Production E2E smoke passed (calibration results recorded, compared, invalidated by a nozzle change, exported and deleted, a print watched from a phone that survived a dropped session and cancelled only on a full hold, a browser configured from empty storage — two printers installed, a filament preset authored over a system base, and the whole setup exported and reimported as a bundle — canonical import/history, Objects/filament assignment, a clicked model coloured by one press on a loaded filament, semantic roles/ranges, generated settings that the same panel also writes to one object without touching the project, guarded plate management, a Smart Paint consent gate that sends nothing and changes nothing without consent, an authored layer pause that reaches the sliced G-code and comes back as a located preview tick beside the engine totals, a multicolor slice sent to a live Moonraker printer then paused, resumed, and cancelled from its live job panel, a stored file browsed, reprinted without re-uploading, renamed, and deleted behind a confirmation, a console that answers a query over the socket, sends nothing when a stepper release is dismissed, and runs a macro with the parameters its own body declares, a print history paged by the count the printer reports, a camera shown as authenticated snapshots that stops fetching when hidden, a printer plus slicer configured once that are still configured after a reload, device preferences that apply live and reset without touching presets, and two named printers that switch without their credentials following each other).',
  );
} finally {
  await browser.close();
  await server.close();
  await printer.close();
  await rm(fixtureDirectory, { recursive: true, force: true });
}
