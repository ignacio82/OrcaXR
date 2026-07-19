/**
 * Help group — mirrors Snapmaker Orca's `Help` menu. "Report a bug" and
 * "Documentation" open the relevant web pages (real, working equivalents of
 * Orca's desktop links). Browser adaptations and their acceptance status are
 * documented in `docs/parity.md`.
 *
 * "Show Configuration Folder" has no web equivalent (the browser sandbox has no
 * user-visible filesystem) — it is intentionally represented as a disabled
 * placeholder rather than omitted, so the menu structure stays 1:1 with Orca.
 */
import type { ActionDefinition as Action } from '../ActionRegistry';

/** OrcaXR's own website and GitHub — Help links point here, not at upstream. */
const SITE = 'https://orcaxr.martinez.fyi';
const GITHUB = 'https://github.com/ignacio82/OrcaXR';

export const helpActions: Action[] = [
  {
    id: 'help_setup_wizard',
    label: 'Setup Wizard',
    icon: 'wizard',
    group: 'help',
    disclosure: 'menu',
    menuSection: 'help',
    hint: 'Re-run the first-launch printer / filament setup',
    run: (ctx) => ctx.setupWizard(),
  },
  {
    id: 'help_shortcuts',
    label: 'Keyboard Shortcuts',
    icon: 'keyboard',
    group: 'help',
    disclosure: 'menu',
    menuSection: 'help',
    hint: 'Show the list of keyboard shortcuts',
    run: (ctx) => ctx.showShortcuts(),
  },
  {
    id: 'help_config_folder',
    label: 'Show Configuration Folder',
    icon: 'folder_open',
    group: 'help',
    disclosure: 'menu',
    menuSection: 'help',
    hint: 'Open the on-disk configuration folder',
  },
  {
    id: 'help_tutorial',
    label: 'Tutorial',
    icon: 'school',
    group: 'help',
    disclosure: 'menu',
    menuSection: 'help',
    hint: 'Open the OrcaXR getting-started tutorial',
    run: (ctx) => ctx.showTutorial(),
  },
  {
    id: 'help_docs',
    label: 'Documentation',
    icon: 'book',
    group: 'help',
    disclosure: 'menu',
    menuSection: 'help',
    hint: 'Open the OrcaXR website',
    run: (ctx) => ctx.openUrl(SITE),
  },
  {
    id: 'help_report_bug',
    label: 'Report a Bug',
    icon: 'bug',
    group: 'help',
    disclosure: 'menu',
    menuSection: 'help',
    hint: 'File an issue on the OrcaXR GitHub tracker',
    run: (ctx) => ctx.openUrl(`${GITHUB}/issues/new`),
  },
  {
    id: 'help_tip_of_day',
    label: 'Show Tip of the Day',
    icon: 'tip',
    group: 'help',
    disclosure: 'menu',
    menuSection: 'help',
    hint: 'Show a rotating usage tip',
    run: (ctx) => ctx.showTip(),
  },
  {
    id: 'help_check_updates',
    label: 'Check for Update',
    icon: 'update',
    group: 'help',
    disclosure: 'menu',
    menuSection: 'help',
    hint: 'Check for a newer OrcaXR version',
    run: (ctx) => ctx.checkForUpdates(),
  },
  {
    id: 'help_about',
    label: 'About OrcaXR',
    icon: 'info',
    group: 'help',
    disclosure: 'menu',
    menuSection: 'help',
    hint: 'Version and credits',
    run: (ctx) => ctx.showAbout(),
  },
];
