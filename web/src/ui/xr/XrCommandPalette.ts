/**
 * XrCommandPalette — every action by name, in the headset.
 *
 * The registry's completeness guarantee is that whatever the visible chrome
 * shows, any capability is one search away. That was true of one shell: the
 * palette was a DOM overlay, and `command-palette` is a surface the immersive
 * shell never drew. An operator in a headset had the chrome and nothing else.
 *
 * The list is the same list — `registry.forSurface('command-palette')`, matched
 * on label, id and hint exactly as {@link CommandPalette} matches it — so the
 * two shells cannot search different catalogues. A row that cannot run stays
 * listed and says why, for the same reason it does in a menu: an operator who
 * cannot find an action cannot tell "absent" from "not available here".
 *
 * Typing is a real problem in a headset and is solved rather than avoided: the
 * query field opens {@link renderXrKeyboard}, and the result count is shown
 * against the whole catalogue so a narrow query does not look like an empty
 * app.
 */
import type { Action, ActionRegistry } from '../../actions/ActionRegistry';
import type { UiStateShape } from '../../actions/UiState';
import { t } from '../../l10n/t';
import { tokens } from '../tokens';
import {
  XR_TYPE,
  createXrColumn,
  createXrField,
  createXrIconButton,
  createXrListRow,
  createXrRow,
  createXrSurfaceBody,
} from './XrChrome';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrCommandPaletteContext {
  readonly registry: ActionRegistry;
  readonly state: Readonly<UiStateShape>;
  readonly query: string;
  onEditQuery(): void;
  onRun(action: Action): void;
  onClose(): void;
}

export interface XrCommandPaletteRender<PanelNode> {
  readonly root: PanelNode;
  /** Matches in draw order; the automation seam and what the tests read. */
  readonly matches: readonly Action[];
}

/** The DOM palette's matcher, so neither shell can find what the other cannot. */
export function xrPaletteMatches(
  registry: ActionRegistry,
  state: Readonly<UiStateShape>,
  query: string,
): { readonly matches: readonly Action[]; readonly total: number } {
  const visible = registry
    .forSurface('command-palette')
    .filter((action) => registry.availability(action, 'command-palette', state).state !== 'hidden');
  const q = query.trim().toLowerCase();
  const matches = q
    ? visible.filter(
        (action) =>
          action.label.toLowerCase().includes(q) ||
          action.id.toLowerCase().includes(q) ||
          (action.hint ?? '').toLowerCase().includes(q),
      )
    : visible;
  return { matches, total: visible.length };
}

/** How many results a 0.46 m tall palette can show without scrolling. */
const VISIBLE_RESULTS = 6;

export function renderXrCommandPalette<PanelNode, ImageNode, TextNode>(
  ui: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  ctx: XrCommandPaletteContext,
): XrCommandPaletteRender<PanelNode> {
  const body = createXrSurfaceBody(ui, { elevation: 'elevated', padding: tokens.space.md, gap: tokens.space.sm });
  ui.appendChild(root, body);

  const { matches, total } = xrPaletteMatches(ctx.registry, ctx.state, ctx.query);

  const header = createXrRow(ui, { gap: tokens.space.sm, flexShrink: 0 });
  ui.appendChild(body, header);
  const field = createXrField(ui, {
    value: ctx.query,
    placeholder: t('ui.xrCommandPalette.search', 'Search every action'),
    icon: 'search',
    accented: true,
    onClick: () => ctx.onEditQuery(),
  });
  ui.appendChild(header, field.root);
  ui.appendChild(
    header,
    ui.createText(
      t('ui.xrCommandPalette.count', '{shown} of {total}')
        .replace('{shown}', String(matches.length))
        .replace('{total}', String(total)),
      { fontSize: XR_TYPE.micro, color: C.textMuted, flexShrink: 0 },
    ),
  );
  // A modal surface has to be dismissible by something the operator can see.
  // "Pinch away to close" is a gesture nobody discovers, and a palette that
  // cannot be closed is a headset the operator is stuck in.
  ui.appendChild(header, createXrIconButton(ui, { icon: 'close', size: 36, iconSize: 16, onClick: ctx.onClose }).root);

  const list = createXrColumn(ui, { gap: 3, flexGrow: 1, flexShrink: 1, overflow: 'scroll' });
  ui.appendChild(body, list);

  if (matches.length === 0) {
    ui.appendChild(
      list,
      ui.createText(t('ui.xrCommandPalette.noMatches', 'No matching actions'), {
        fontSize: XR_TYPE.body,
        color: C.textMuted,
      }),
    );
  }
  for (const action of matches.slice(0, VISIBLE_RESULTS)) {
    const availability = ctx.registry.availability(action, 'command-palette', ctx.state);
    const enabled = availability.state === 'enabled';
    const reason = availability.state === 'disabled' ? availability.reason : undefined;
    const row = createXrListRow(ui, {
      label: action.label,
      icon: action.icon,
      tag: action.group,
      ...(reason ? { reason } : action.hint ? { hint: action.hint } : {}),
      enabled,
      onClick: () => ctx.onRun(action),
    });
    ui.appendChild(list, row.root);
  }

  ui.appendChild(
    body,
    ui.createText(
      matches.length > VISIBLE_RESULTS
        ? t('ui.xrCommandPalette.narrow', 'Keep typing to narrow {rest} more results.').replace(
            '{rest}',
            String(matches.length - VISIBLE_RESULTS),
          )
        : t('ui.xrCommandPalette.pinchToRun', 'Pinch a row to run it. A row that cannot run says why.'),
      { fontSize: XR_TYPE.micro, color: C.textMuted, flexShrink: 0 },
    ),
  );

  return { root: body, matches };
}
