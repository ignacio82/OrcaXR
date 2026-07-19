import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { launchBrowser, openReadyPage, startPreview } from './preview-harness.mjs';

async function writeMultiPlateFixture(directory) {
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
  <resources>
    <object id="1" type="model"><components><component objectid="101" p:path="/3D/Objects/alpha.model"/></components></object>
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
    </triangles></mesh></object></resources>
</model>`;
  const betaModel = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="102" type="model"><mesh><vertices>
      <vertex x="135" y="20" z="7"/><vertex x="145" y="20" z="7"/>
      <vertex x="135" y="30" z="7"/><vertex x="135" y="20" z="12"/>
    </vertices><triangles>
      <triangle v1="0" v2="2" v3="1" paint_color="4"/><triangle v1="0" v2="1" v3="3"/>
      <triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>
    </triangles></mesh></object></resources>
</model>`;
  const settings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="1"><part id="101"><metadata key="extruder" value="1"/></part></object>
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

const fixtureDirectory = await mkdtemp(join(tmpdir(), 'orcaxr-e2e-'));
const fixturePath = await writeMultiPlateFixture(fixtureDirectory);
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
  assert.equal(await page.$eval('[data-action-id="edit_undo"]', (node) => node.disabled), true);
  assert.match(await page.$eval('[data-action-id="edit_undo"]', (node) => node.title), /history is not implemented/i);

  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await page.waitForSelector('#command-palette.open');
  assert.equal(
    await page.$eval('#cmd-list [data-action-id="edit_undo"]', (node) => node.classList.contains('disabled')),
    true,
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
    await page.$eval('.menu-trigger:focus', (trigger) => trigger.textContent.trim().startsWith('Help')),
    true,
  );

  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('resize')));
  const overflow = await page.evaluate(
    () => globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 1, `mobile shell overflows horizontally by ${overflow}px`);

  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluate(() => {
    // This fixture verifies import only; don't make the smoke gate wait for
    // the much larger slicing engine's background warm-up.
    globalThis.window.workspace.slicerWarmupQueued = true;
  });
  const fileInput = await page.$('#file-input');
  assert.ok(fileInput, 'model file input is available');
  await fileInput.uploadFile(fixturePath);
  await page.waitForFunction(
    () => {
      const snapshot = globalThis.window.workspace?.getAutomationSnapshot?.();
      return snapshot?.placedModelsTotalAllPlates === 2 && snapshot.plates.length === 2;
    },
    { timeout: 60_000 },
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
      const target = workspace.plates.find((candidate) => candidate.id === plate.id);
      const allModels = workspace.plates.flatMap((candidate) =>
        candidate.models.map((model) => ({ plateId: candidate.id, visible: model.viewer.visible })),
      );
      const color = target.models[0].raw.getAttribute('color').array;
      const uniqueColors = new Set();
      for (let index = 0; index < color.length; index += 3) {
        uniqueColors.add(`${Math.round(color[index])},${Math.round(color[index + 1])},${Math.round(color[index + 2])}`);
      }
      plates.push({
        label: plate.label,
        count: plate.count,
        bounds,
        colors: [...uniqueColors].sort(),
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
  assert.deepStrictEqual(imported[0].colors, ['1,0,0']);
  assert.deepStrictEqual(imported[1].colors, ['0,0,1', '1,0,0']);
  assert.ok(imported.every((plate) => plate.activeVisible === plate.count && plate.inactiveVisible === 0));

  assert.deepStrictEqual(pageErrors, [], `uncaught page errors: ${pageErrors.join('\n')}`);
  assert.deepStrictEqual(policyErrors, [], `CSP violations: ${policyErrors.join('\n')}`);
  console.log(
    'Production E2E smoke passed (capability guard, command palette, mobile viewport, Production Extension multi-plate import).',
  );
} finally {
  await browser.close();
  await server.close();
  await rm(fixtureDirectory, { recursive: true, force: true });
}
