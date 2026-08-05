/**
 * Static HTML bodies for the Help menu's informational modals. Authored here
 * (trusted content — no user input) so ActionContext stays DOM-agnostic: it
 * hands these strings to `workspace.showModal`, which each shell renders its own
 * way (the DOM shell as an overlay card; XR falls back to the status line).
 */
import type { Action } from './ActionRegistry';
import { shortcutHelpRows } from './ShortcutCatalog';

const SITE = 'https://orcaxr.martinez.fyi';
const GITHUB = 'https://github.com/ignacio82/OrcaXR';

export const ABOUT_HTML = `
  <p><strong>OrcaXR</strong> — an XR-first 3D-print slicer with DOM and experimental
  spatial (XR) shells driven by one shared action registry.</p>
  <p>Slicing is powered by a WebAssembly build of the Snapmaker Orca engine and runs
  in your browser by default. Snapmaker Orca v2.3.4 workflow parity and XR input
  qualification are still in progress.</p>
  <p style="color:var(--oxr-color-text-muted)">
    <a href="${SITE}" target="_blank" rel="noopener">orcaxr.martinez.fyi</a> ·
    <a href="${GITHUB}" target="_blank" rel="noopener">GitHub</a> ·
    <a href="${GITHUB}/blob/main/docs/parity.md" target="_blank" rel="noopener">Parity status</a>
  </p>`;

export function shortcutsHtml(actions: readonly Action[]): string {
  const rows = shortcutHelpRows(actions)
    .map(
      (row) =>
        `<tr><td>${row.displays.map((display) => `<kbd>${escapeHtml(display)}</kbd>`).join(' / ')}</td>` +
        `<td>${escapeHtml(row.actionLabel)}${row.unavailable ? ' (unavailable)' : ''}</td></tr>`,
    )
    .join('');
  return `
    <p>OrcaXR is command-first — press <kbd>Ctrl+K</kbd> or <kbd>⌘+K</kbd> to open
    the command palette and find any catalogued action by name. Actions that are not
    available in the current build remain disabled.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr><th scope="col" style="text-align:left">Shortcut</th><th scope="col" style="text-align:left">Action</th></tr></thead>
      <tbody>
        <tr><td><kbd>Ctrl+K</kbd> / <kbd>⌘+K</kbd></td><td>Command palette</td></tr>
        ${rows}
      </tbody>
    </table>
    <p style="color:var(--oxr-color-text-muted)">This list is generated from the shared action catalogue.</p>`;
}

export const TUTORIAL_HTML = `
  <p>This is the basic browser workflow in the current alpha:</p>
  <ol style="margin:0;padding-left:20px;line-height:1.7">
    <li><strong>Import</strong> a model (File → Import) or drop in a primitive (Add).</li>
    <li><strong>Place</strong> it with Move / Rotate / Scale, or hit Auto-arrange.</li>
    <li><strong>Pick a profile</strong> — printer, process and filament — up top.</li>
    <li><strong>Slice</strong>, then <strong>Preview</strong> the toolpaths.</li>
    <li><strong>Export</strong> the G-code or send it to your printer.</li>
  </ol>
  <p style="color:var(--oxr-color-text-muted)">The XR shell shares the action catalogue,
  but end-to-end controller, hand, and gaze workflows are still being qualified.
  <a href="${GITHUB}/blob/main/docs/parity.md" target="_blank" rel="noopener">See current parity status.</a></p>`;

const TIPS = [
  'Press Ctrl/⌘ K to find any catalogued action by name; unavailable actions stay disabled.',
  'Auto-arrange (Tools) lays every model out on the plate so nothing overlaps.',
  'Split to Objects (Tools) separates a multi-body import into independent models.',
  'Cut (Tools) bisects a model horizontally and caps both halves.',
  'Show Overhangs (View) highlights the steep down-facing faces in red.',
  'Import Zip Archive (File) loads every STL / 3MF / OBJ inside a .zip at once.',
  'Duplicate Current Plate (Tools) clones a whole plate — models and layout.',
];

/** A rotating tip, seeded by the day so it changes daily but is stable per day. */
export function tipOfTheDayHtml(): string {
  const day = Math.floor(Date.now() / 86_400_000);
  const tip = TIPS[day % TIPS.length];
  return `<p style="font-size:15px;line-height:1.6">💡 ${tip}</p>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string,
  );
}
