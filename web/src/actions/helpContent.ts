/**
 * Static HTML bodies for the Help menu's informational modals. Authored here
 * (trusted content — no user input) so ActionContext stays DOM-agnostic: it
 * hands these strings to `workspace.showModal`, which each shell renders its own
 * way (the DOM shell as an overlay card; XR falls back to the status line).
 */

const SITE = 'https://orcaxr.martinez.fyi';
const GITHUB = 'https://github.com/ignacio82/OrcaXR';

export const ABOUT_HTML = `
  <p><strong>OrcaXR</strong> — an XR-first 3D-print slicer with full-parity DOM and
  spatial (XR) shells, driven by one shared action registry.</p>
  <p>Slicing is powered by a WebAssembly build of the OrcaSlicer / Snapmaker Orca
  engine, running entirely in your browser.</p>
  <p style="color:var(--oxr-color-text-muted)">
    <a href="${SITE}" target="_blank" rel="noopener">orcaxr.martinez.fyi</a> ·
    <a href="${GITHUB}" target="_blank" rel="noopener">GitHub</a>
  </p>`;

export const SHORTCUTS_HTML = `
  <p>OrcaXR is command-first — press <kbd>Ctrl</kbd>/<kbd>⌘</kbd> <kbd>K</kbd> to open
  the command palette and run <em>any</em> action by name.</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr><td><kbd>Ctrl/⌘ K</kbd></td><td>Command palette (every action)</td></tr>
    <tr><td><kbd>Del</kbd></td><td>Delete the selected model</td></tr>
    <tr><td><kbd>Esc</kbd></td><td>Deselect / close this dialog</td></tr>
    <tr><td><kbd>G</kbd> / <kbd>R</kbd> / <kbd>S</kbd></td><td>Move / Rotate / Scale selected model</td></tr>
    <tr><td>Drag</td><td>Move · Rotate · Scale (pick the tool on the left rail)</td></tr>
  </table>
  <p style="color:var(--oxr-color-text-muted)">More shortcuts arrive as features land.</p>`;

export const TUTORIAL_HTML = `
  <ol style="margin:0;padding-left:20px;line-height:1.7">
    <li><strong>Import</strong> a model (File → Import) or drop in a primitive (Add).</li>
    <li><strong>Place</strong> it with Move / Rotate / Scale, or hit Auto-arrange.</li>
    <li><strong>Pick a profile</strong> — printer, process and filament — up top.</li>
    <li><strong>Slice</strong>, then <strong>Preview</strong> the toolpaths.</li>
    <li><strong>Export</strong> the G-code or send it to your printer.</li>
  </ol>
  <p style="color:var(--oxr-color-text-muted)">Everything here also works hands-free in the XR shell.</p>`;

const TIPS = [
  'Press Ctrl/⌘ K to run any command by name — it lists every action in the app.',
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
