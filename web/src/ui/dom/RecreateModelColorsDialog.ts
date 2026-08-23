/**
 * RecreateModelColorsDialog — accessible DOM confirmation modal for matching
 * model colors to available physical filaments or Full-Spectrum recipes.
 */

import type { FilamentId } from '../../project/domain/ids';
import type { RecreateModelColorsPlan } from '../../project/filaments/recreateModelColors';
import type { CanonicalVirtualFilamentLibrarySnapshot } from '../../workspace/CanonicalWorkspaceController';
import { t } from '../../l10n/t';

export interface RecreateModelColorsDialogResult {
  readonly confirmed: boolean;
  readonly overrides?: ReadonlyMap<string, FilamentId>;
}

/**
 * Present the model color recreation plan to the operator with swatch previews,
 * DeltaE accuracy metrics, and manual override dropdowns before committing.
 */
export function askRecreateModelColors(
  plan: RecreateModelColorsPlan,
  librarySnapshot?: CanonicalVirtualFilamentLibrarySnapshot,
): Promise<RecreateModelColorsDialogResult> {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement('div');
  overlay.dataset.recreateModelColorsDialog = 'true';
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10002;background:#000b;display:flex;align-items:center;' +
    'justify-content:center;padding:20px;box-sizing:border-box;';

  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'orcaxr-recreate-colors-title');
  dialog.setAttribute('aria-describedby', 'orcaxr-recreate-colors-desc');
  dialog.style.cssText =
    'max-width:620px;width:100%;max-height:85vh;background:var(--oxr-color-bg-card);' +
    'color:var(--oxr-color-text);border:1px solid var(--oxr-color-stroke);' +
    'border-radius:12px;padding:20px;font:14px/1.5 system-ui,sans-serif;display:flex;' +
    'flex-direction:column;gap:14px;box-sizing:border-box;overflow:hidden;';

  const title = document.createElement('h2');
  title.id = 'orcaxr-recreate-colors-title';
  title.textContent = t('dialog.recreateModelColors.title', 'Recreate Model Colors (Full-Spectrum)');
  title.style.cssText = 'margin:0;font-size:16px;font-weight:600;';

  const desc = document.createElement('p');
  desc.id = 'orcaxr-recreate-colors-desc';
  desc.textContent = t(
    'dialog.recreateModelColors.description',
    'Match colors from the current model to the closest available physical filaments or synthesize Full-Spectrum dithering recipes.',
  );
  desc.style.cssText = 'margin:0;color:var(--oxr-text-muted);font-size:12px;';

  const tableContainer = document.createElement('div');
  tableContainer.style.cssText =
    'flex:1;overflow-y:auto;border:1px solid var(--oxr-color-stroke);' +
    'border-radius:8px;background:var(--oxr-bg-sunken);padding:8px;display:flex;flex-direction:column;gap:8px;';

  const overrides = new Map<string, FilamentId>();

  for (const match of plan.matches) {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:10px;padding:8px;border-radius:6px;' +
      'background:var(--oxr-surface);border:1px solid var(--oxr-surface);box-sizing:border-box;';

    // Source color swatch & info
    const sourceCol = document.createElement('div');
    sourceCol.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:140px;';
    const sourceSwatch = document.createElement('div');
    sourceSwatch.style.cssText =
      `width:24px;height:24px;border-radius:4px;border:1px solid var(--oxr-stroke-strong);` +
      `background-color:${match.source.color};flex-shrink:0;`;
    const sourceText = document.createElement('div');
    sourceText.style.cssText = 'display:flex;flex-direction:column;';
    const sourceHex = document.createElement('span');
    sourceHex.textContent = match.source.color;
    sourceHex.style.cssText = 'font-weight:600;font-size:12px;font-family:monospace;';
    const sourceSample = document.createElement('span');
    sourceSample.textContent =
      match.source.sourceMaterialName ??
      match.source.sampleNames[0] ??
      t('dialog.recreateModelColors.refsCount', '{count} refs', { count: match.source.usageCount });
    sourceSample.style.cssText =
      'font-size:10px;color:var(--oxr-text-muted);max-width:100px;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    sourceText.append(sourceHex, sourceSample);
    sourceCol.append(sourceSwatch, sourceText);

    // Arrow
    const arrow = document.createElement('span');
    arrow.textContent = '→';
    arrow.style.cssText = 'color:var(--oxr-text-muted);font-size:16px;flex-shrink:0;';

    // Destination color swatch & details
    const destCol = document.createElement('div');
    destCol.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;';
    const destSwatch = document.createElement('div');
    destSwatch.style.cssText =
      `width:24px;height:24px;border-radius:4px;border:1px solid var(--oxr-stroke-strong);` +
      `background-color:${match.destination.displayColor};flex-shrink:0;`;

    const destSelect = document.createElement('select');
    destSelect.setAttribute(
      'aria-label',
      t('dialog.recreateModelColors.destAria', 'Destination for {color}', { color: match.source.color }),
    );
    destSelect.style.cssText =
      'flex:1;min-width:0;background:var(--oxr-surface);color:inherit;' +
      'border:1px solid var(--oxr-color-stroke);border-radius:4px;' +
      'padding:4px 6px;font-size:12px;';

    // Default option: matched auto destination
    const autoOption = document.createElement('option');
    autoOption.value = '__auto__';
    autoOption.textContent = match.destination.name;
    destSelect.appendChild(autoOption);

    // Add physical filament choices
    const candidatePhysical = plan.candidatePhysicalFilaments;
    if (candidatePhysical && candidatePhysical.length > 0) {
      for (const phys of candidatePhysical) {
        if (!phys.enabled) continue;
        const opt = document.createElement('option');
        opt.value = phys.id;
        opt.textContent = t('dialog.recreateModelColors.physicalOption', 'Physical: {name} (T{toolId}) - {color}', {
          name: phys.name,
          toolId: phys.toolId + 1,
          color: phys.color,
        });
        destSelect.appendChild(opt);
      }
    } else if (librarySnapshot) {
      for (const phys of librarySnapshot.physical) {
        if (!phys.enabled) continue;
        const opt = document.createElement('option');
        opt.value = phys.id;
        opt.textContent = t('dialog.recreateModelColors.physicalOption', 'Physical: {name} (T{toolId}) - {color}', {
          name: phys.name,
          toolId: phys.engineToolId,
          color: phys.color,
        });
        destSelect.appendChild(opt);
      }
    }

    if (librarySnapshot) {
      // Add existing mixed filament choices
      for (const item of librarySnapshot.mixed) {
        const mix = item.filament;
        if (!mix.enabled) continue;
        const opt = document.createElement('option');
        opt.value = mix.id;
        opt.textContent = t('dialog.recreateModelColors.virtualOption', 'Virtual: {name} - {color}', {
          name: mix.name,
          color: mix.displayColor,
        });
        destSelect.appendChild(opt);
      }
    }

    destSelect.onchange = () => {
      if (destSelect.value === '__auto__') {
        overrides.delete(match.source.color);
        destSwatch.style.backgroundColor = match.destination.displayColor;
      } else {
        overrides.set(match.source.color, destSelect.value as FilamentId);
        const selectedPhys = (candidatePhysical ?? librarySnapshot?.physical)?.find((p) => p.id === destSelect.value);
        const selectedMix = librarySnapshot?.mixed.find((m) => m.filament.id === destSelect.value)?.filament;
        if (selectedPhys) destSwatch.style.backgroundColor = selectedPhys.color;
        else if (selectedMix) destSwatch.style.backgroundColor = selectedMix.displayColor;
      }
    };

    destCol.append(destSwatch, destSelect);

    // DeltaE badge
    const deltaEBadge = document.createElement('span');
    const deltaVal = match.destination.deltaE2000;
    deltaEBadge.textContent = `ΔE ${deltaVal.toFixed(1)}`;
    const deltaColor =
      deltaVal <= 1.5 ? 'rgba(76,175,80,0.2)' : deltaVal <= 4.0 ? 'rgba(255,193,7,0.2)' : 'rgba(244,67,54,0.2)';
    const deltaBorder =
      deltaVal <= 1.5 ? 'rgba(76,175,80,0.6)' : deltaVal <= 4.0 ? 'rgba(255,193,7,0.6)' : 'rgba(244,67,54,0.6)';
    deltaEBadge.style.cssText =
      `padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;font-family:monospace;` +
      `background:${deltaColor};border:1px solid ${deltaBorder};flex-shrink:0;`;
    deltaEBadge.title = t(
      'dialog.recreateModelColors.deltaETooltip',
      'Perceptual color difference in CIELAB space (lower is better)',
    );

    row.append(sourceCol, arrow, destCol, deltaEBadge);
    tableContainer.appendChild(row);
  }

  const footer = document.createElement('div');
  footer.style.cssText =
    'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-top:4px;';

  const summary = document.createElement('span');
  summary.style.cssText = 'font-size:12px;color:var(--oxr-text-muted);';
  summary.textContent = t(
    'dialog.recreateModelColors.summaryStats',
    'Avg ΔE: {avg} (Max: {max}) across {count} color(s)',
    {
      avg: plan.averageDeltaE2000.toFixed(1),
      max: plan.maxDeltaE2000.toFixed(1),
      count: plan.matches.length,
    },
  );

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-inline-start:auto;';

  const buttons: HTMLButtonElement[] = [];
  const make = (label: string, isPrimary: boolean, onAction: () => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText =
      'min-height:36px;padding:8px 16px;border-radius:6px;cursor:pointer;color:inherit;font-size:13px;' +
      `border:1px solid ${isPrimary ? 'var(--oxr-color-accent,var(--oxr-accent))' : 'var(--oxr-stroke)'};` +
      `background:${isPrimary ? 'var(--oxr-surface-hover)' : 'var(--oxr-surface)'};font-weight:${isPrimary ? 600 : 400};`;
    button.onclick = onAction;
    buttons.push(button);
    return button;
  };

  let settle: (result: RecreateModelColorsDialogResult) => void = () => {};
  const finish = (confirmed: boolean) => {
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    previousFocus?.focus?.();
    settle({ confirmed, overrides: overrides.size > 0 ? overrides : undefined });
  };

  const applyBtn = make(t('dialog.recreateModelColors.apply', 'Apply Matches'), true, () => finish(true));
  const cancelBtn = make(t('dialog.recreateModelColors.cancel', 'Cancel'), false, () => finish(false));

  actions.append(cancelBtn, applyBtn);
  footer.append(summary, actions);

  dialog.append(title, desc, tableContainer, footer);
  overlay.append(dialog);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
      return;
    }
    if (event.key !== 'Tab' || buttons.length === 0) return;
    const active = document.activeElement;
    const index = buttons.findIndex((button) => button === active);
    const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index + 1) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(overlay);
  applyBtn.focus();

  return new Promise<RecreateModelColorsDialogResult>((resolve) => {
    settle = resolve;
  });
}
