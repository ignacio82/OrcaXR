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
  const source = [
    'o Wedge',
    'usemtl shell',
    'v 0 0 0',
    'v 20 0 0',
    'v 0 20 0',
    'v 0 0 20',
    'f 1 2 3',
    'f 1 2 4',
    'o Riser',
    'usemtl core',
    'v 40 0 0',
    'v 60 0 0',
    'v 40 20 0',
    'f 5 6 7',
    '',
  ].join('\n');
  const path = join(directory, 'two-objects.obj');
  await writeFile(path, strToU8(source));
  return path;
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
  assert.equal(
    await page.$eval('#file-input', (input) => input.accept),
    '.stl,.obj,.amf,.amfz,.zip',
    'the model picker offers exactly the decodable model containers',
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
    'Production E2E smoke passed (canonical import/history, Objects/filament assignment, semantic roles/ranges, generated settings, and guarded plate management).',
  );
} finally {
  await browser.close();
  await server.close();
  await rm(fixtureDirectory, { recursive: true, force: true });
}
