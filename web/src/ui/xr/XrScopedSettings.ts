/**
 * Scoped settings, drawn for a surface with no keyboard (P6.5).
 *
 * The controller in `settings/editor/scopedStepper.ts` decides *what* a headset
 * may change and validates every press through the shared draft editor. This
 * file decides only how those rows look, and it draws them through the same
 * mockable adapter the action buttons use — so the one thing that has always
 * been unverifiable about the XR shell, whether a control is actually wired to
 * the thing it claims to change, can be asserted without a headset.
 *
 * The layout answers two questions an operator has in this order: *which node
 * am I editing*, and *what can I change on it*. So the target picker is first
 * and always present, even while the rows are still loading — the alternative
 * is a panel that appears empty when it is merely not ready.
 */

import { tokens } from '../tokens';
import type { ScopedStepperView } from '../../settings/editor/scopedStepper';
import type { XrUiAdapter } from './XrUiAdapter';

const C = tokens.color;

export interface XrScopedSettingsHandlers {
  onCycleTarget(direction: 1 | -1): void;
  onStep(fieldId: string, direction: 1 | -1): void;
}

export interface XrScopedSettingsRender<TextNode> {
  /**
   * Value text by field id. A press changes one number, and rebuilding forty
   * rows of spatial panels to show it costs a visible hitch, so the shell writes
   * through this map and rebuilds only when {@link XrScopedSettingsRender.signature}
   * changes.
   */
  readonly values: ReadonlyMap<string, { readonly node: TextNode; readonly unit: string }>;
  readonly signature: string;
}

/**
 * What must be rebuilt rather than retyped.
 *
 * Values are deliberately absent: a changed number is written into the row that
 * already exists, and only a changed *shape* — another node, another row set, a
 * message that appeared — justifies rebuilding the panel.
 */
export function xrScopedSettingsSignature(view: ScopedStepperView | null): string {
  if (!view) return 'absent';
  return [
    view.status,
    view.targetIndex,
    view.targetCount,
    view.unavailable,
    view.message ?? '',
    view.rows
      .map((row) => `${row.fieldId}:${row.steppable ? 's' : '-'}:${row.overridden ? 'o' : '-'}:${row.group}`)
      .join(','),
  ].join('|');
}

export function renderXrScopedSettings<PanelNode, ImageNode, TextNode>(
  adapter: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  root: PanelNode,
  view: ScopedStepperView | null,
  handlers: XrScopedSettingsHandlers,
): XrScopedSettingsRender<TextNode> {
  const values = new Map<string, { node: TextNode; unit: string }>();
  adapter.appendChild(
    root,
    adapter.createText('SCOPED SETTINGS', {
      fontSize: 11,
      fontWeight: 'bold',
      color: '#8a94a0',
      paddingTop: 8,
    }),
  );
  if (!view) {
    // Said rather than left blank: the shell installs the controller once the
    // pinned schema is loadable, and an empty space would read as "no settings".
    adapter.appendChild(
      root,
      adapter.createText('The settings schema is still loading.', { fontSize: 13, color: C.textMuted }),
    );
    return { values, signature: xrScopedSettingsSignature(view) };
  }

  const picker = adapter.createPanel({
    width: '100%',
    paddingLeft: 12,
    paddingRight: 12,
    paddingTop: 8,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    cornerRadius: tokens.radius.sm,
    fillColor: '#ffffff10',
  });
  adapter.appendChild(
    picker,
    stepButton(adapter, '‹', () => handlers.onCycleTarget(-1)),
  );
  adapter.appendChild(
    picker,
    adapter.createText(view.targetLabel, { fontSize: 15, color: '#eef2f6', flexGrow: 1, flexShrink: 1 }),
  );
  if (view.targetCount > 0) {
    adapter.appendChild(
      picker,
      adapter.createText(`${view.targetIndex + 1}/${view.targetCount}`, {
        fontSize: 12,
        color: '#8a94a0',
        flexShrink: 0,
      }),
    );
  }
  adapter.appendChild(
    picker,
    stepButton(adapter, '›', () => handlers.onCycleTarget(1)),
  );
  adapter.appendChild(root, picker);

  if (view.status !== 'ready') {
    adapter.appendChild(
      root,
      adapter.createText(view.message ?? 'Reading this node’s settings…', { fontSize: 13, color: C.textMuted }),
    );
    return { values, signature: xrScopedSettingsSignature(view) };
  }

  let group = '';
  for (const row of view.rows) {
    if (row.group !== group) {
      group = row.group;
      adapter.appendChild(root, adapter.createText(group, { fontSize: 11, color: '#6f7b88', paddingTop: 6 }));
    }
    const panel = adapter.createPanel({
      width: '100%',
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 8,
      paddingBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      cornerRadius: tokens.radius.sm,
      // An overridden setting is tinted, because "where did I set that?" is the
      // question a scoped panel exists to answer.
      fillColor: row.overridden ? '#ff6d0014' : C.surfaceDisabled,
    });
    adapter.appendChild(
      panel,
      adapter.createText(row.label, {
        fontSize: 15,
        color: row.steppable ? '#c7ced6' : '#8a94a0',
        flexGrow: 1,
        flexShrink: 1,
      }),
    );
    if (row.steppable) {
      const unit = row.unit ? ` ${row.unit}` : '';
      const value = adapter.createText(`${row.value}${unit}`, { fontSize: 15, color: '#eef2f6', flexShrink: 0 });
      values.set(row.fieldId, { node: value, unit });
      adapter.appendChild(
        panel,
        stepButton(adapter, '−', () => handlers.onStep(row.fieldId, -1)),
      );
      adapter.appendChild(panel, value);
      adapter.appendChild(
        panel,
        stepButton(adapter, '+', () => handlers.onStep(row.fieldId, 1)),
      );
    } else {
      // The value still shows: an operator who cannot change a setting here
      // still needs to know what it is before deciding to reach for a screen.
      adapter.appendChild(
        panel,
        adapter.createText(row.value || '—', { fontSize: 13, color: '#8a94a0', flexShrink: 0 }),
      );
    }
    adapter.appendChild(root, panel);
  }

  if (view.rows.length === 0) {
    adapter.appendChild(
      root,
      adapter.createText('This node has no settings of its own.', { fontSize: 13, color: C.textMuted }),
    );
  }
  if (view.unavailable > 0) {
    // The DOM panel draws these as disabled controls; drawing ninety of them
    // here would bury the ones that work, so the count is stated instead.
    adapter.appendChild(
      root,
      adapter.createText(
        `${view.unavailable} more are unavailable on every surface (generated definition unsupported).`,
        { fontSize: 11, color: '#6f7b88' },
      ),
    );
  }
  if (view.message) {
    adapter.appendChild(root, adapter.createText(view.message, { fontSize: 12, color: C.warn }));
  }
  return { values, signature: xrScopedSettingsSignature(view) };
}

/** One press target, big enough to hit with a ray from across a room. */
function stepButton<PanelNode, ImageNode, TextNode>(
  adapter: XrUiAdapter<PanelNode, ImageNode, TextNode>,
  label: string,
  onPress: () => void,
): PanelNode {
  const button = adapter.createPanel({
    paddingLeft: 14,
    paddingRight: 14,
    paddingTop: 6,
    paddingBottom: 6,
    cornerRadius: tokens.radius.sm,
    fillColor: C.surface,
    flexShrink: 0,
    onClick: () => {
      onPress();
      return true;
    },
    onHoverEnter: () => adapter.setPanelFill(button, C.surfaceHover),
    onHoverExit: () => adapter.setPanelFill(button, C.surface),
  });
  adapter.appendChild(button, adapter.createText(label, { fontSize: 17, color: '#eef2f6' }));
  return button;
}
