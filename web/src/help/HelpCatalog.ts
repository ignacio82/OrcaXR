/**
 * Contextual help and troubleshooting (P11.3).
 *
 * Two things live here, and the second is why this file exists at all.
 *
 * The first is topic content for the areas an operator has to understand —
 * onboarding, FullSpectrum, painting, profiles, preview, Moonraker, offline
 * and XR, privacy, diagnostics, limitations.
 *
 * The second is per-error troubleshooting. Every preflight issue used to carry
 * the same sentence: "Resolve this issue before slicing or sending." True, and
 * useless — it tells someone that something is wrong, which they already knew,
 * and nothing about what to do. Each code now says what it means and what
 * actually fixes it, and a coverage test fails when a new code lands without
 * one, so this cannot quietly rot back to a generic string.
 *
 * Everything is bundled with the app rather than fetched, so help works in the
 * same offline conditions the rest of the app is required to work in.
 */

export const HELP_DOCS_ORIGIN = 'https://orcaxr.martinez.fyi';
export const HELP_REPO_ORIGIN = 'https://github.com/ignacio82/OrcaXR';

/** Hosts a help link may point at. Anything else is a mistake, not a choice. */
export const HELP_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  HELP_DOCS_ORIGIN,
  HELP_REPO_ORIGIN,
  'https://github.com/Snapmaker/OrcaSlicer',
  'https://help.prusa3d.com',
  'https://developer.mozilla.org',
  'https://moonraker.readthedocs.io',
]);

export interface HelpTopic {
  readonly id: string;
  readonly title: string;
  /** What this is, in a sentence or two an operator can act on. */
  readonly body: string;
  /** Words someone might type that should find this topic. */
  readonly keywords: readonly string[];
  readonly link?: string;
}

export interface TroubleshootingTopic {
  /** The preflight issue code this explains. */
  readonly code: string;
  readonly title: string;
  /** Why the check fired, in the operator's terms rather than the engine's. */
  readonly what: string;
  /** The concrete thing that clears it. */
  readonly fix: string;
}

/**
 * Per-code troubleshooting.
 *
 * Ordered as an operator meets them: geometry and plate problems first, then
 * filament and tool mapping, then the wipe tower, then project integrity.
 */
export const TROUBLESHOOTING: readonly TroubleshootingTopic[] = Object.freeze([
  {
    code: 'no-printable-instance',
    title: 'Nothing on this plate is set to print',
    what: 'Every object on the active plate is marked unprintable, so slicing it would produce an empty file.',
    fix: 'Mark at least one instance printable in the Objects list, or switch to a plate that has printable parts.',
  },
  {
    code: 'plate-not-printable',
    title: 'This plate is switched off',
    what: 'The plate itself is marked unprintable, which excludes it regardless of what sits on it.',
    fix: 'Turn the plate back on in the Plates panel, or slice a different plate.',
  },
  {
    code: 'unknown-plate',
    title: 'That plate is no longer in the project',
    what: 'The slice request names a plate that has since been deleted or renumbered.',
    fix: 'Pick the plate again in the Plates panel; the request was not run against a stale target.',
  },
  {
    code: 'instance-outside-build-volume',
    title: 'A part is outside the build volume',
    what: 'Some geometry sits beyond the printer’s reachable envelope, so the machine could not print it as placed.',
    fix: 'Move or scale the part back inside, or choose a printer with a larger volume. Arrange will place everything that fits.',
  },
  {
    code: 'instance-below-build-plate',
    title: 'A part is below the bed',
    what: 'Geometry extends under Z = 0, which the slicer cannot reach and the nozzle would drive into.',
    fix: 'Use Drop to bed on that instance, or raise it until its lowest point is at or above the plate.',
  },
  {
    code: 'instance-aabb-overlap',
    title: 'Two parts occupy the same space',
    what: 'Bounding boxes intersect, so the parts would be printed into one another.',
    fix: 'Separate them by hand or run Arrange. Overlap is only expected for a negative volume or a modifier, which are not flagged here.',
  },
  {
    code: 'empty-model-mesh',
    title: 'A part has no geometry',
    what: 'The mesh contains no triangles, usually because an import produced nothing or an edit removed everything.',
    fix: 'Delete the empty part, or re-import the source file and check the import warnings.',
  },
  {
    code: 'unreadable-model-mesh',
    title: 'A part’s mesh could not be read',
    what: 'The stored geometry for this part is missing or does not decode, so nothing can be sliced from it.',
    fix: 'Re-import the model. If a saved project does this, its asset is damaged; open an earlier copy.',
  },
  {
    code: 'disabled-filament-assignment',
    title: 'Something is assigned to a switched-off filament',
    what: 'A part, volume, or layer range points at a filament slot that is currently disabled.',
    fix: 'Re-enable that slot in the Filament panel, or reassign what depends on it to an active one.',
  },
  {
    code: 'deleted-mixed-filament-assignment',
    title: 'Something is assigned to a deleted virtual filament',
    what: 'A FullSpectrum recipe that objects still reference has been removed.',
    fix: 'Recreate the recipe or reassign those objects. Undo will restore it if the deletion was recent.',
  },
  {
    code: 'disabled-mixed-component',
    title: 'A recipe depends on a switched-off filament',
    what: 'A FullSpectrum recipe mixes from a physical slot that is disabled, so the blend cannot be produced.',
    fix: 'Re-enable the component slot, or edit the recipe to use loaded filaments.',
  },
  {
    code: 'incompatible-mixed-components',
    title: 'A recipe mixes materials that cannot be printed together',
    what: 'The components need incompatible temperatures or chemistry; the engine refuses the pair outright.',
    fix: 'Build the recipe from one material family — the compatibility table in the Filament panel shows which.',
  },
  {
    code: 'mixed-filament-unsupported-printer',
    title: 'This printer cannot mix filaments',
    what: 'The project uses FullSpectrum recipes, but the resolved printer has a single tool.',
    fix: 'Select a multi-tool printer profile, or replace the virtual filaments with physical assignments.',
  },
  {
    code: 'filament-tool-out-of-range',
    title: 'A filament is assigned to a tool the printer does not have',
    what: 'The slot number exceeds the printer’s tool count. The engine would silently clamp it to tool 1 and print in the wrong colour.',
    fix: 'Reassign to an existing tool, or select a printer with enough tools. Syncing from the printer sets the count from the machine.',
  },
  {
    code: 'filament-count-exceeds-engine-limit',
    title: 'Too many filaments for the engine',
    what: 'The project declares more filaments — physical plus virtual — than the pinned engine can address.',
    fix: 'Reduce the number of FullSpectrum recipes, or merge ones that resolve to nearly the same colour.',
  },
  {
    code: 'filament-nozzle-mismatch',
    title: 'A filament expects a different nozzle',
    what: 'The filament profile targets a nozzle diameter the tool is not configured for.',
    fix: 'Pick a filament profile for the fitted nozzle, or correct the tool’s nozzle in the printer profile.',
  },
  {
    code: 'unsupported-filament-material',
    title: 'That material is not supported on this tool',
    what: 'The tool’s own configuration declares a different filament type than the filament assigned to it.',
    fix: 'Choose a filament profile matching the tool, or sync from the printer so both agree on what is loaded.',
  },
  {
    code: 'filament-temperature-out-of-range',
    title: 'A filament temperature is outside the tool’s range',
    what: 'The requested nozzle temperature falls outside what the hotend profile permits.',
    fix: 'Adjust the filament temperature, or use a hotend profile rated for it. Printing outside the range risks the hotend.',
  },
  {
    code: 'invalid-filament-temperature',
    title: 'A filament temperature is not a usable number',
    what: 'The stored temperature is missing, non-numeric, or outside any plausible range.',
    fix: 'Reselect the filament profile so its temperatures are restored from the catalog.',
  },
  {
    code: 'gradient-recipe-out-of-bounds',
    title: 'A gradient runs past its usable range',
    what: 'A FullSpectrum gradient endpoint sits outside the ratios the engine accepts, which it would silently clamp.',
    fix: 'Move the endpoints inside the allowed window in the recipe editor; the panel shows the limits.',
  },
  {
    code: 'wipe-tower-outside-build-volume',
    title: 'The wipe tower does not fit',
    what: 'The tower is placed partly outside the build volume, so the purge would happen off the bed.',
    fix: 'Drag the tower somewhere it fits, or make it smaller. It needs clear space for every tool change.',
  },
  {
    code: 'wipe-tower-requires-physical-filament',
    title: 'The wipe tower has no filament to purge with',
    what: 'The tower is enabled but is not bound to a loaded physical filament.',
    fix: 'Assign a physical filament to the tower, or turn it off if the job needs no tool changes.',
  },
  {
    code: 'wipe-tower-requires-relative-e',
    title: 'The wipe tower needs relative extrusion',
    what: 'This printer is configured for absolute extruder addressing, which the tower’s purge logic cannot use safely.',
    fix: 'Enable relative E in the printer profile, or disable the wipe tower.',
  },
  {
    code: 'wipe-tower-ooze-prevention-conflict',
    title: 'Ooze prevention conflicts with the wipe tower',
    what: 'Both are enabled, and together they produce contradictory temperature and purge behaviour.',
    fix: 'Turn off ooze prevention, or turn off the wipe tower. On a tool-changing job the tower is usually the one to keep.',
  },
  {
    code: 'wipe-tower-mixed-extruder-diameters',
    title: 'The tools have different nozzle sizes',
    what: 'A single wipe tower cannot purge tools whose nozzles extrude at different widths.',
    fix: 'Fit matching nozzles, or restrict the job to tools that share a diameter.',
  },
  {
    code: 'unsafe-custom-gcode',
    title: 'Custom G-code was refused',
    what: 'Authored G-code contains something the safety check will not pass, or exceeds the size limit.',
    fix: 'Open the layer event and remove the flagged command. The message names what it objected to.',
  },
  {
    code: 'missing-profile-attestation',
    title: 'This project’s profile cannot be proven',
    what: 'A tool is not bound to an exact filament preset, and an imported project carries no embedded configuration for it.',
    fix: 'Select an explicit filament profile for that tool, so the settings used are the ones on screen.',
  },
  {
    code: 'invalid-project-state',
    title: 'The project failed its own integrity check',
    what: 'Canonical validation rejected the project before slicing. This is a bug rather than a setup mistake.',
    fix: 'Undo the last change. If it persists, export diagnostics — the bundle names the failing rule and carries no project data.',
  },
]);

const TROUBLESHOOTING_BY_CODE: ReadonlyMap<string, TroubleshootingTopic> = new Map(
  TROUBLESHOOTING.map((topic) => [topic.code, topic]),
);

export function troubleshootingFor(code: string): TroubleshootingTopic | undefined {
  return TROUBLESHOOTING_BY_CODE.get(code);
}

/** The areas the item names, each answerable without leaving the app. */
export const HELP_TOPICS: readonly HelpTopic[] = Object.freeze([
  {
    id: 'onboarding',
    title: 'Getting started',
    body: 'Load a model, check the printer and filament at the top of the inspector, then slice. The first run offers a Set up your printer button; the address and any key are saved on this device, so you configure them once.',
    keywords: ['start', 'first', 'new', 'setup', 'begin', 'tutorial'],
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    body: 'Every action is reachable from the command palette, which also shows its shortcut. The Shortcuts help page is generated from the same action catalog the toolbar renders, so it cannot list a key that does nothing.',
    keywords: ['keyboard', 'keys', 'hotkey', 'palette', 'command'],
  },
  {
    id: 'fullspectrum',
    title: 'FullSpectrum virtual filaments',
    body: 'A virtual filament is a recipe that blends loaded physical spools. Components are addressed by physical slot, so a recipe breaks if its slot is disabled or removed. Gradients interpolate between two components across a ratio range the engine bounds.',
    keywords: ['fullspectrum', 'virtual', 'mix', 'blend', 'gradient', 'recipe', 'colour', 'color'],
  },
  {
    id: 'painting',
    title: 'Painting parts',
    body: 'Painting assigns a filament, support, seam, or fuzzy-skin state to individual triangles. Strokes are undoable canonical commands and survive save and reload. Repainting after a mesh is replaced is required, because triangle indices no longer refer to the same surface.',
    keywords: ['paint', 'colour', 'color', 'support', 'seam', 'fuzzy', 'brush', 'multicolour'],
  },
  {
    id: 'profiles',
    title: 'Printers, processes, and filaments',
    body: 'A printer profile fixes the machine and its nozzles, a process profile the layer and speed settings, and a filament profile the material. Changing the printer keeps a compatible process and every filament slot where it can, and explains any substitution it had to make.',
    keywords: ['profile', 'preset', 'printer', 'process', 'filament', 'nozzle', 'machine'],
  },
  {
    id: 'preview',
    title: 'Reading the preview',
    body: 'The preview renders the sliced G-code, not the model: what you see is what the printer received. Colour modes, move filters, and the layer scrubber all read the same artifact, and the preview refuses to show a result that no longer matches the project.',
    keywords: ['preview', 'gcode', 'layer', 'scrubber', 'toolpath', 'travel'],
  },
  {
    id: 'moonraker',
    title: 'Connecting a printer',
    body: 'OrcaXR speaks Moonraker directly. Enter the printer address once; a plain-HTTP LAN address also needs Chrome’s Local Network Access permission and this page’s origin in the printer’s cors_domains. Sending a file and starting a print are separate actions, because only the second moves a machine.',
    keywords: ['printer', 'moonraker', 'connect', 'network', 'cors', 'lan', 'send', 'upload'],
    link: 'https://moonraker.readthedocs.io',
  },
  {
    id: 'external-slicer',
    title: 'Using an external slicer',
    body: 'An external server must prove which engine it runs before it receives canonical work: matching WASM artifacts, or the pinned Snapmaker Orca commit plus the pinned patch set for a CLI build. A server published beyond loopback needs a token, which goes in the Access token field.',
    keywords: ['slicer', 'external', 'server', 'engine', 'token', 'attestation', 'cli'],
  },
  {
    id: 'offline-xr',
    title: 'Offline and headset use',
    body: 'The app installs as a PWA and slices in the browser, so the core flow works with no network. Some flows are DOM-only and say so rather than appearing in the headset and failing: anything needing a file picker or typed text names that reason on the action itself.',
    keywords: ['offline', 'pwa', 'xr', 'headset', 'vr', 'install', 'network'],
  },
  {
    id: 'privacy',
    title: 'Privacy and what leaves this device',
    body: 'Slicing happens in the browser unless an external slicer is enabled. The printer key and slicer token are stored on this device behind a switch that also erases them. Assistant features ask for consent per payload kind before anything is sent, and a diagnostics export never carries your project, addresses, or tokens.',
    keywords: ['privacy', 'security', 'token', 'secret', 'data', 'consent', 'ai'],
  },
  {
    id: 'diagnostics',
    title: 'Reporting a problem',
    body: 'File → Export Diagnostics builds a bundle and shows you exactly what it contains before writing it. It carries versions, capability counts, the shape of your project, and a redacted log — never geometry, G-code, addresses, or tokens, and model names only if you opt in.',
    keywords: ['bug', 'report', 'diagnostics', 'logs', 'support', 'export', 'crash'],
  },
  {
    id: 'limitations',
    title: 'Known limitations',
    body: 'OrcaXR tracks a pinned Snapmaker Orca release and does not claim full parity. An action that is not implemented says so with a reason instead of failing when used, and the parity plan records what remains for every area.',
    keywords: ['limitation', 'missing', 'parity', 'unsupported', 'roadmap', 'known'],
    link: `${HELP_REPO_ORIGIN}/blob/main/docs/parity.md`,
  },
]);

export interface HelpSearchHit {
  readonly kind: 'topic' | 'troubleshooting' | 'action';
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/**
 * Search topics, troubleshooting, and the action catalog together.
 *
 * One index rather than three, because someone looking for "wipe tower" does
 * not know whether their answer is a concept, an error, or a button.
 */
export function searchHelp(
  query: string,
  actions: readonly { readonly id: string; readonly label: string; readonly hint?: string }[] = [],
): readonly HelpSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits: HelpSearchHit[] = [];

  for (const topic of HELP_TOPICS) {
    const haystack = `${topic.title} ${topic.body} ${topic.keywords.join(' ')}`.toLowerCase();
    if (haystack.includes(needle)) {
      hits.push({ kind: 'topic', id: topic.id, title: topic.title, body: topic.body });
    }
  }
  for (const topic of TROUBLESHOOTING) {
    const haystack = `${topic.title} ${topic.what} ${topic.fix} ${topic.code}`.toLowerCase();
    if (haystack.includes(needle)) {
      hits.push({ kind: 'troubleshooting', id: topic.code, title: topic.title, body: `${topic.what} ${topic.fix}` });
    }
  }
  for (const action of actions) {
    const haystack = `${action.label} ${action.hint ?? ''}`.toLowerCase();
    if (haystack.includes(needle)) {
      hits.push({ kind: 'action', id: action.id, title: action.label, body: action.hint ?? '' });
    }
  }
  return Object.freeze(hits);
}

/** Every outbound link the help content declares, for the link check. */
export function helpLinks(): readonly string[] {
  return Object.freeze(HELP_TOPICS.map((topic) => topic.link).filter((link): link is string => Boolean(link)));
}
