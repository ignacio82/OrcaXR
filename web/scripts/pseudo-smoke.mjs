#!/usr/bin/env node
/**
 * The app, rendered in a language that is longer than English and in one that
 * runs the other way (P10.4.4).
 *
 * The static direction contract beside this file catches the properties that
 * cannot mirror. This catches what only a real render can: a control sized to
 * the English word inside it. "Slice" fits; "Aufschneiden" does not, and the
 * button clips without anything failing — the text is still in the DOM, still
 * readable to a test that asks for `textContent`, and invisible on screen.
 *
 * So the measurement is geometric. Every message in `en-XA` is expanded by 40%
 * and wrapped in `⟦ ⟧`, which is roughly the worst case the twenty shipped
 * languages produce for short labels; a control whose content is wider than its
 * box is reported with the text that overflowed it. The mirrored run then holds
 * the same controls to actually being on the other side, because a layout that
 * sets `dir="rtl"` and mirrors nothing is the failure this is looking for.
 *
 * What this cannot do is judge legibility, which is why P10.4.4's headset and
 * human-review clauses stay open — it finds clipping, not ugliness.
 */
import assert from 'node:assert/strict';

import { launchBrowser, openReadyPage, startPreview } from './preview-harness.mjs';

/**
 * The controls a run must not clip.
 *
 * Named rather than "everything visible": a status line that ellipsises a long
 * sentence is doing its job, while a primary button that hides half its verb is
 * not. These are the surfaces an operator navigates by.
 */
const CRITICAL = [
  { name: 'primary bar', selector: '#action-panel button' },
  { name: 'menu triggers', selector: '#menu-bar-host .menu-trigger' },
  { name: 'menu items', selector: '#menu-bar-host .menu-dropdown button' },
  { name: 'workspace tabs', selector: '#view-tabs button' },
  { name: 'print actions', selector: '#print-actions button' },
  { name: 'sidebar cards', selector: '#param-scroll .card-head h2' },
  { name: 'field labels', selector: '#param-scroll .field-row .field-label' },
  { name: 'calibration grid', selector: '#calibration-grid button' },
];

// The model toolbar is deliberately absent: it is icons, and its labels are
// the accessible name rather than anything drawn. A geometric check there
// would measure a clipped 1px box and report every tool as truncated.

/**
 * The minimum this run must actually look at.
 *
 * Without it the gate passes vacuously the day a selector stops matching — and
 * a green "none clipped" over an empty list is worse than no gate, because it
 * is believed.
 */
const MINIMUM_CONTROLS = 40;

/**
 * Pixels of overflow tolerated before a control counts as clipped. One, because
 * sub-pixel layout rounding routinely produces a `scrollWidth` a hair over the
 * client box on a control that is not clipping anything.
 */
const SLACK = 1;

const { server, url } = await startPreview();
const browser = await launchBrowser();
try {
  const page = await openReadyPage(browser, url, { width: 1280, height: 720 });
  await revealChrome(page);

  // Open the menu bar before measuring anything. A closed dropdown has zero
  // width, so its rows are skipped — and the menu columns are the longest text
  // in the app, which makes "the gate passed because it did not look" the
  // likeliest way for this to be quietly useless.
  await openMenus(page);
  const viewportWidth = await page.evaluate(() => globalThis.window.innerWidth);
  const englishInspector = await inspectorCentre(page);
  const before = await measure(page, CRITICAL);
  assert.ok(
    before.total >= MINIMUM_CONTROLS,
    `only ${before.total} critical controls were measured; the selectors have gone stale`,
  );

  // Switched through the app's own localizer rather than by seeding storage and
  // reloading, so what is measured is the repaint an operator actually gets.
  const expanded = await switchLocale(page, 'en-XA');
  assert.equal(expanded.locale, 'en-XA', 'the expanded pseudo-locale applied');
  assert.equal(expanded.dir, 'ltr');
  assert.ok(expanded.sample.includes('⟦'), `pseudo-localization reached the labels (got ${expanded.sample})`);

  const clipped = await measure(page, CRITICAL);
  assert.equal(clipped.total, before.total, 'the same controls are present after the switch');
  assert.deepEqual(
    clipped.overflowing,
    [],
    'a control whose box is narrower than its text clips it; size to the content, not to the English',
  );

  const mirrored = await switchLocale(page, 'ar-XB');
  assert.equal(mirrored.locale, 'ar-XB');
  assert.equal(mirrored.dir, 'rtl', 'the mirrored pseudo-locale sets the document direction');

  const rtl = await measure(page, CRITICAL);
  assert.deepEqual(rtl.overflowing, [], 'the mirrored run must not clip either');

  // A layout that declares `dir="rtl"` and lays out identically has not
  // mirrored, it has only changed an attribute. The evidence is the *same*
  // element measured in both directions rather than two elements compared in
  // one: the parameter sidebar is anchored to the inline start, so it must
  // cross the midline. Comparing two elements would pass silently whenever one
  // of them is hidden.
  const mirroredInspector = await inspectorCentre(page);
  assert.ok(
    englishInspector !== null && mirroredInspector !== null,
    'the inspector must be on screen in both directions for the mirror check to mean anything',
  );
  assert.ok(
    englishInspector < viewportWidth / 2 && mirroredInspector > viewportWidth / 2,
    `dir=rtl did not mirror the layout: the sidebar sits at ${Math.round(englishInspector)}px in English and ` +
      `${Math.round(mirroredInspector)}px mirrored, in a ${viewportWidth}px viewport`,
  );

  const back = await switchLocale(page, 'en');
  assert.equal(back.locale, 'en');
  assert.equal(back.dir, 'ltr', 'switching back restores the direction');
  assert.ok(!back.sample.includes('⟦'), 'and the real labels');

  // The per-group tally is printed rather than only the total: a selector that
  // stops matching takes its whole surface out of the gate, and a shrinking
  // total is the only warning of it.
  console.log(
    `Pseudo-localization smoke passed (${before.total} critical controls, expanded and mirrored, none clipped): ` +
      Object.entries(clipped.counts)
        .map(([name, count]) => `${name} ${count}`)
        .join(', '),
  );
} finally {
  await browser.close();
  await server.close();
}

/**
 * Open the surfaces that start closed.
 *
 * The menu columns and the collapsed tool rail hold most of the app's labels,
 * and a run that measured only what is visible at boot would check five
 * controls and call the app safe.
 */
async function revealChrome(page) {
  await page.evaluate(() => {
    // Set the open state directly rather than clicking the trigger: a click is
    // a toggle, and calling this again after a remount would close what the
    // first call opened — which is how a run silently drops to five controls.
    // The rail and the calibration grid are hidden until a model is loaded.
    // Revealing them is legitimate here: this run measures whether the chrome
    // clips its own labels, not whether the app works — and a gate that skipped
    // twenty-nine controls because the plate was empty would be reporting
    // coverage it did not have.
    globalThis.document.getElementById('ui-container')?.classList.remove('no-model');
    // A folded sidebar card and a hidden page have no layout, so every one is
    // opened: a label clips the same way whether or not its card happened to be
    // open, and the Project page holds the calibration grid.
    for (const card of globalThis.document.querySelectorAll('.oxr-card')) {
      card.classList.remove('folded');
      card.hidden = false;
    }
    for (const page of globalThis.document.querySelectorAll('.workspace-page')) page.hidden = false;
    // The inspector shows one tab at a time; the rest are `hidden`. Every panel
    // is measured rather than only the open one, because a label clips the same
    // way whether or not its tab happened to be selected at boot.
    for (const panel of globalThis.document.querySelectorAll('.insp-panel, [id^="insp-panel-"]')) {
      panel.hidden = false;
      panel.style.display = 'block';
    }
    globalThis.document.getElementById('menu-bar-host')?.classList.add('open');
    globalThis.document.getElementById('menu-button')?.setAttribute('aria-expanded', 'true');
    for (const collapsed of globalThis.document.querySelectorAll('.collapsed')) collapsed.classList.remove('collapsed');
    for (const dropdown of globalThis.document.querySelectorAll('#menu-bar-host .menu-dropdown')) {
      dropdown.removeAttribute('hidden');
      dropdown.style.display = 'block';
      dropdown.style.visibility = 'visible';
      dropdown.style.opacity = '1';
    }
  });
  await page.evaluate(
    () => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))),
  );
}

/** Open the menu bar so its columns are laid out and can be measured. */
async function openMenus(page) {
  const opened = await page.evaluate(() => {
    const host = globalThis.document.querySelector('#menu-bar-host');
    if (!host) return 0;
    host.classList.add('open');
    // Each column's popover opens on its own trigger, so every one is opened
    // rather than the first: the longest label in the app is not in File.
    for (const dropdown of host.querySelectorAll('.menu-dropdown')) dropdown.classList.add('open');
    return host.querySelectorAll('.menu-dropdown button').length;
  });
  await page.evaluate(
    () => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))),
  );
  return opened;
}

/**
 * Where the parameter sidebar's midpoint sits. It is anchored to the inline
 * START, so this is the one number that says whether the layout mirrored
 * rather than merely relabelled itself.
 */
function inspectorCentre(page) {
  return page.evaluate(() => {
    const element = globalThis.document.querySelector('#param-scroll');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return rect.width === 0 ? null : rect.left + rect.width / 2;
  });
}

/** Drive the app's own localizer and wait for the repaint it triggers. */
async function switchLocale(page, locale) {
  const result = await page.evaluate(async (target) => {
    const l10n = globalThis.window.__orcaL10n;
    if (!l10n) throw new Error('the app did not expose its localizer');
    const applied = await l10n.setLocale(target);
    return { applied, locale: l10n.locale };
  }, locale);
  if (!result.applied) throw new Error(`the app refused to switch to ${locale}`);
  // The repaint is a remount, so the surfaces opened above are closed again.
  await revealChrome(page);
  return page.evaluate(() => ({
    locale: globalThis.window.__orcaL10n.locale,
    dir: globalThis.document.documentElement.dir,
    sample: globalThis.document.querySelector('#action-panel button')?.textContent ?? '',
  }));
}

/**
 * Which controls hold more text than they can show.
 *
 * `scrollWidth`/`scrollHeight` against the client box is what "clipped" means
 * here: it is true whether the overflow is hidden, ellipsised, or simply spills,
 * and it does not depend on the text being any particular string.
 */
function measure(page, groups) {
  return page.evaluate(
    (definitions, slack) => {
      const overflowing = [];
      const counts = {};
      let total = 0;
      for (const { name, selector } of definitions) {
        counts[name] = 0;
        for (const element of globalThis.document.querySelectorAll(selector)) {
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          total += 1;
          counts[name] += 1;
          const text = (element.textContent ?? '').trim();
          if (!text) continue;
          const wide = element.scrollWidth - element.clientWidth;
          const tall = element.scrollHeight - element.clientHeight;
          if (wide > slack || tall > slack) {
            overflowing.push(`${name}: ${text.slice(0, 48)} (overflow ${wide}×${tall}px)`);
          }
        }
      }
      return { total, overflowing, counts };
    },
    groups,
    SLACK,
  );
}
