import { t } from '../../l10n/t';

export interface WaveOverhangsSettings {
  readonly enabled: boolean;
  readonly algorithm: 'andersons' | 'kaiser';
  readonly printSpeedMmS: number;
  readonly travelSpeedMmS: number;
  readonly fanSpeedPercent: number;
  readonly auxFanSpeedPercent: number;
  readonly floorUseHilbert: boolean;
  readonly floorLayers: number;
  readonly floorHilbertDensity: number;
  readonly floorPrintSpeedMmS: number;
  readonly floorFanSpeedPercent: number;
  readonly supportRemainingAreas: boolean;
  readonly ringOverlap: number;
  readonly minWaveTimeS: number;
  readonly endRetractMm: number;
  readonly debugGCode: boolean;
}

export const DEFAULT_WAVE_OVERHANGS_SETTINGS: WaveOverhangsSettings = Object.freeze({
  enabled: false,
  algorithm: 'andersons',
  printSpeedMmS: 35,
  travelSpeedMmS: 80,
  fanSpeedPercent: 90,
  auxFanSpeedPercent: 50,
  floorUseHilbert: true,
  floorLayers: 3,
  floorHilbertDensity: 100,
  floorPrintSpeedMmS: 40,
  floorFanSpeedPercent: 85,
  supportRemainingAreas: true,
  ringOverlap: 0.4,
  minWaveTimeS: 0,
  endRetractMm: 0,
  debugGCode: true,
});

export interface WaveOverhangsPanelState {
  readonly settings: WaveOverhangsSettings;
  readonly hasOverrides: boolean;
  readonly busy?: boolean;
}

export interface WaveOverhangsPanelAdapter {
  getState(): WaveOverhangsPanelState;
  subscribe?(listener: () => void): () => void;
  onUpdate(settings: Partial<WaveOverhangsSettings>): void | Promise<void>;
  onReset(): void | Promise<void>;
  onError?(error: unknown): void;
}

let panelSeq = 0;

/**
 * Intuitive Wave-Overhang controls panel.
 * Exposes algorithm selection with detailed guidance, anti-warping Hilbert floor
 * parameters, speed & cooling overrides, and support material subtraction.
 */
export class WaveOverhangsPanel {
  private readonly instanceId = ++panelSeq;
  private root?: HTMLElement;
  private unsubscribe?: () => void;
  private state?: WaveOverhangsPanelState;

  constructor(
    private readonly container: HTMLElement,
    private readonly adapter: WaveOverhangsPanelAdapter,
  ) {}

  mount(): void {
    if (this.root) return;
    const document = this.container.ownerDocument;
    const root = document.createElement('section');
    root.dataset.waveOverhangsPanel = 'true';
    root.setAttribute('aria-labelledby', `oxr-wave-heading-${this.instanceId}`);
    root.style.cssText =
      'display:flex;min-width:0;flex-direction:column;gap:10px;color:var(--oxr-color-text);' +
      'font:12.5px/1.4 var(--font-sans,system-ui,sans-serif);';
    this.container.replaceChildren(root);
    this.root = root;
    this.unsubscribe = this.adapter.subscribe?.(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    if (!this.root) return;
    this.state = this.adapter.getState();
    this.render();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root?.remove();
    this.root = undefined;
  }

  private render(): void {
    const root = this.root;
    const state = this.state;
    if (!root || !state) return;
    const document = root.ownerDocument;
    root.replaceChildren();

    const { settings, hasOverrides, busy } = state;

    // Header bar with status and reset button
    const headRow = document.createElement('div');
    headRow.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-block-end:2px;';

    const heading = document.createElement('h3');
    heading.id = `oxr-wave-heading-${this.instanceId}`;
    heading.textContent = t('ui.waveOverhangs.title', 'Wave overhang printing');
    heading.style.cssText = 'margin:0;font-size:13px;font-weight:600;';
    headRow.appendChild(heading);

    if (hasOverrides) {
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.dataset.waveAction = 'reset';
      resetBtn.textContent = t('ui.waveOverhangs.resetOverrides', 'Reset overrides');
      resetBtn.title = t(
        'ui.waveOverhangs.resetOverridesHint',
        'Reset all wave overhang settings back to process defaults',
      );
      resetBtn.style.cssText =
        'padding:2px 8px;font-size:11px;border-radius:var(--radius-sm,4px);' +
        'border:1px solid var(--oxr-border,rgba(128,128,128,0.3));background:transparent;' +
        'color:var(--oxr-color-text-muted);cursor:pointer;';
      resetBtn.onclick = () => void this.adapter.onReset();
      headRow.appendChild(resetBtn);
    }
    root.appendChild(headRow);

    // Primary Enable Toggle
    const enableLabel = document.createElement('label');
    enableLabel.className = 'check-row';
    enableLabel.style.cssText =
      'display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-weight:500;' +
      'padding:6px 8px;border-radius:var(--radius-sm,4px);background:var(--oxr-bg-card,rgba(128,128,128,0.08));';

    const enableChk = document.createElement('input');
    enableChk.type = 'checkbox';
    enableChk.dataset.waveEnable = 'true';
    enableChk.checked = settings.enabled;
    enableChk.disabled = !!busy;
    enableChk.style.cssText = 'margin-block-start:2px;cursor:pointer;';
    enableChk.onchange = () => {
      void this.adapter.onUpdate({ enabled: enableChk.checked });
    };

    const enableTextWrap = document.createElement('div');
    enableTextWrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

    const enableTitle = document.createElement('span');
    enableTitle.textContent = t('ui.waveOverhangs.enableLabel', 'Enable wave overhangs');
    enableTitle.style.cssText = 'font-size:12.5px;color:var(--oxr-color-text);';

    const enableDesc = document.createElement('span');
    enableDesc.textContent = t(
      'ui.waveOverhangs.enableDesc',
      'Replace straight cantilever overhang bridging with curved wave toolpaths that anchor into walls without supports.',
    );
    enableDesc.style.cssText = 'font-size:11px;color:var(--oxr-color-text-muted);line-height:1.3;';

    enableTextWrap.appendChild(enableTitle);
    enableTextWrap.appendChild(enableDesc);
    enableLabel.appendChild(enableChk);
    enableLabel.appendChild(enableTextWrap);
    root.appendChild(enableLabel);

    // Sub-settings container (dimmed if disabled)
    const body = document.createElement('div');
    body.dataset.waveBody = 'true';
    body.style.cssText = `display:flex;flex-direction:column;gap:10px;margin-block-start:4px;${
      settings.enabled ? '' : 'opacity:0.5;pointer-events:none;'
    }`;

    // Algorithm Selection & Decision Guidance
    const algoGroup = document.createElement('div');
    algoGroup.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    const algoId = `oxr-wave-algo-${this.instanceId}`;
    const algoLabel = document.createElement('label');
    algoLabel.htmlFor = algoId;
    algoLabel.textContent = t('ui.waveOverhangs.algorithmLabel', 'Wave generation algorithm:');
    algoLabel.style.cssText = 'font-weight:600;font-size:12px;';
    algoGroup.appendChild(algoLabel);

    const algoSelect = document.createElement('select');
    algoSelect.id = algoId;
    algoSelect.dataset.waveAlgorithm = 'true';
    algoSelect.className = 'field-control text-input';
    algoSelect.style.cssText =
      'padding:5px 8px;font-size:12px;border-radius:var(--radius-sm,4px);' +
      'border:1px solid var(--oxr-border,rgba(128,128,128,0.3));background:var(--oxr-surface,transparent);' +
      'color:var(--oxr-color-text);cursor:pointer;';

    const optAndersons = document.createElement('option');
    optAndersons.value = 'andersons';
    optAndersons.textContent = t(
      'ui.waveOverhangs.algoAndersonsOpt',
      'Andersons (Concentric Wavefront) — Recommended Default',
    );
    algoSelect.appendChild(optAndersons);

    const optKaiser = document.createElement('option');
    optKaiser.value = 'kaiser';
    optKaiser.textContent = t('ui.waveOverhangs.algoKaiserOpt', 'Kaiser LaSO (Lateral Seed-Curve Offsetting)');
    algoSelect.appendChild(optKaiser);

    algoSelect.value = settings.algorithm;
    algoSelect.disabled = !settings.enabled || !!busy;
    algoSelect.onchange = () => {
      void this.adapter.onUpdate({ algorithm: algoSelect.value as 'andersons' | 'kaiser' });
    };
    algoGroup.appendChild(algoSelect);

    // Interactive Guidance Card
    const guideCard = document.createElement('div');
    guideCard.dataset.waveAlgorithmGuide = 'true';
    guideCard.style.cssText =
      'padding:8px 10px;border-radius:var(--radius-sm,4px);background:var(--oxr-bg-card,rgba(128,128,128,0.06));' +
      'border-inline-start:3px solid var(--oxr-accent,#ff9800);font-size:11.5px;line-height:1.35;color:var(--oxr-color-text);';

    if (settings.algorithm === 'andersons') {
      guideCard.innerHTML = `
        <div style="font-weight:600;margin-block-end:3px;color:var(--oxr-color-text);">
          ${t('ui.waveOverhangs.guideAndersonsTitle', 'Janis A. Andersons Wavefront Propagation (Default)')}
        </div>
        <div style="color:var(--oxr-color-text-muted);">
          ${t(
            'ui.waveOverhangs.guideAndersonsText',
            'Propagates concentric wavefront paths outward from supported perimeters. Best for mechanical models, flat/steep cantilevers, and parts with clear wall boundaries. Provides high structural stiffness with uniform layer adhesion.',
          )}
        </div>
      `;
    } else {
      guideCard.innerHTML = `
        <div style="font-weight:600;margin-block-end:3px;color:var(--oxr-color-text);">
          ${t('ui.waveOverhangs.guideKaiserTitle', 'Kaiser Lateral Seed-Curve Offsetting (LaSO)')}
        </div>
        <div style="color:var(--oxr-color-text-muted);">
          ${t(
            'ui.waveOverhangs.guideKaiserText',
            'Offsets lateral seed-curves along the overhang slope with tunable ring overlap. Best for organic shapes, curved figurines, and continuous tapering surfaces where toolpaths following natural contour lines prevent drooping.',
          )}
        </div>
      `;
    }
    algoGroup.appendChild(guideCard);
    body.appendChild(algoGroup);

    // Quick Tuning Presets
    const presetsGroup = document.createElement('div');
    presetsGroup.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    const presetsLabel = document.createElement('span');
    presetsLabel.textContent = t('ui.waveOverhangs.presetsLabel', 'Quick tuning profiles:');
    presetsLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--oxr-color-text-muted);';
    presetsGroup.appendChild(presetsLabel);

    const presetsRow = document.createElement('div');
    presetsRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

    const btnPresetBalanced = this.createPresetButton(
      t('ui.waveOverhangs.presetBalanced', 'Balanced (Default)'),
      t('ui.waveOverhangs.presetBalancedHint', 'Andersons algorithm, 35 mm/s speed, 90% fan, 3 Hilbert floor layers'),
      () => {
        void this.adapter.onUpdate({
          algorithm: 'andersons',
          printSpeedMmS: 35,
          fanSpeedPercent: 90,
          floorUseHilbert: true,
          floorLayers: 3,
          supportRemainingAreas: true,
        });
      },
    );

    const btnPresetHighSpeed = this.createPresetButton(
      t('ui.waveOverhangs.presetHighSpeed', 'Fast / Rigid'),
      t('ui.waveOverhangs.presetHighSpeedHint', 'Andersons algorithm, 50 mm/s speed, 100% fan, 2 floor layers'),
      () => {
        void this.adapter.onUpdate({
          algorithm: 'andersons',
          printSpeedMmS: 50,
          fanSpeedPercent: 100,
          floorUseHilbert: true,
          floorLayers: 2,
          supportRemainingAreas: true,
        });
      },
    );

    const btnPresetOrganic = this.createPresetButton(
      t('ui.waveOverhangs.presetOrganic', 'Organic / Smooth'),
      t(
        'ui.waveOverhangs.presetOrganicHint',
        'Kaiser LaSO algorithm, 30 mm/s speed, 100% fan, 40% ring overlap, 3 floor layers',
      ),
      () => {
        void this.adapter.onUpdate({
          algorithm: 'kaiser',
          printSpeedMmS: 30,
          fanSpeedPercent: 100,
          ringOverlap: 0.4,
          floorUseHilbert: true,
          floorLayers: 3,
          supportRemainingAreas: true,
        });
      },
    );

    presetsRow.appendChild(btnPresetBalanced);
    presetsRow.appendChild(btnPresetHighSpeed);
    presetsRow.appendChild(btnPresetOrganic);
    presetsGroup.appendChild(presetsRow);
    body.appendChild(presetsGroup);

    // Anti-Warping Hilbert Floor Section
    const floorSection = document.createElement('div');
    floorSection.style.cssText =
      'display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:var(--radius-sm,4px);' +
      'background:var(--oxr-bg-card,rgba(128,128,128,0.04));border:1px solid var(--oxr-border,rgba(128,128,128,0.2));';

    const floorTitle = document.createElement('div');
    floorTitle.style.cssText = 'font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px;';
    floorTitle.textContent = t('ui.waveOverhangs.floorSectionTitle', 'Thermal stress & floor layers:');
    floorSection.appendChild(floorTitle);

    const hilbertLabel = document.createElement('label');
    hilbertLabel.className = 'check-row';
    hilbertLabel.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;';

    const hilbertChk = document.createElement('input');
    hilbertChk.type = 'checkbox';
    hilbertChk.dataset.waveHilbert = 'true';
    hilbertChk.checked = settings.floorUseHilbert;
    hilbertChk.disabled = !settings.enabled || !!busy;
    hilbertChk.onchange = () => {
      void this.adapter.onUpdate({ floorUseHilbert: hilbertChk.checked });
    };

    const hilbertText = document.createElement('span');
    hilbertText.textContent = t('ui.waveOverhangs.useHilbertFloor', 'Enforce Hilbert curve solid floor infill');
    hilbertLabel.appendChild(hilbertChk);
    hilbertLabel.appendChild(hilbertText);
    floorSection.appendChild(hilbertLabel);

    const floorLayersId = `oxr-wave-floor-layers-${this.instanceId}`;
    const floorLayersRow = document.createElement('div');
    floorLayersRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

    const floorLayersLabel = document.createElement('label');
    floorLayersLabel.htmlFor = floorLayersId;
    floorLayersLabel.textContent = t('ui.waveOverhangs.floorLayersCount', 'Floor layers count:');
    floorLayersLabel.style.cssText = 'font-size:11.5px;color:var(--oxr-color-text-muted);cursor:pointer;';

    const floorLayersInput = document.createElement('input');
    floorLayersInput.id = floorLayersId;
    floorLayersInput.type = 'number';
    floorLayersInput.dataset.waveFloorLayers = 'true';
    floorLayersInput.className = 'field-control text-input';
    floorLayersInput.min = '1';
    floorLayersInput.max = '10';
    floorLayersInput.step = '1';
    floorLayersInput.value = String(settings.floorLayers);
    floorLayersInput.style.cssText = 'width:60px;padding:3px 6px;font-size:12px;text-align:end;';
    floorLayersInput.disabled = !settings.enabled || !settings.floorUseHilbert || !!busy;
    floorLayersInput.onchange = () => {
      const val = parseInt(floorLayersInput.value, 10);
      if (Number.isFinite(val) && val >= 1) void this.adapter.onUpdate({ floorLayers: val });
    };

    floorLayersRow.appendChild(floorLayersLabel);
    floorLayersRow.appendChild(floorLayersInput);
    floorSection.appendChild(floorLayersRow);

    const floorHint = document.createElement('span');
    floorHint.textContent = t(
      'ui.waveOverhangs.floorHint',
      'Fractal Hilbert scan paths eliminate directional shrinking stress, keeping overhang floors flat and preventing warping.',
    );
    floorHint.style.cssText = 'font-size:11px;color:var(--oxr-color-text-muted);line-height:1.3;';
    floorSection.appendChild(floorHint);

    body.appendChild(floorSection);

    // Speeds & Cooling Overrides
    const speedsSection = document.createElement('div');
    speedsSection.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    const speedsTitle = document.createElement('span');
    speedsTitle.textContent = t('ui.waveOverhangs.speedCoolingTitle', 'Speeds & cooling overrides:');
    speedsTitle.style.cssText = 'font-weight:600;font-size:12px;';
    speedsSection.appendChild(speedsTitle);

    // Wave print speed
    speedsSection.appendChild(
      this.createNumberRow(
        t('ui.waveOverhangs.waveSpeed', 'Wave print speed (mm/s):'),
        settings.printSpeedMmS,
        'wavePrintSpeed',
        5,
        200,
        1,
        (val) => this.adapter.onUpdate({ printSpeedMmS: val }),
        !settings.enabled || !!busy,
      ),
    );

    // Wave fan speed
    speedsSection.appendChild(
      this.createNumberRow(
        t('ui.waveOverhangs.waveFan', 'Part cooling fan (%):'),
        settings.fanSpeedPercent,
        'waveFanSpeed',
        0,
        100,
        1,
        (val) => this.adapter.onUpdate({ fanSpeedPercent: val }),
        !settings.enabled || !!busy,
      ),
    );

    // Aux fan speed
    speedsSection.appendChild(
      this.createNumberRow(
        t('ui.waveOverhangs.auxFan', 'Auxiliary fan (%):'),
        settings.auxFanSpeedPercent,
        'waveAuxFanSpeed',
        0,
        100,
        1,
        (val) => this.adapter.onUpdate({ auxFanSpeedPercent: val }),
        !settings.enabled || !!busy,
      ),
    );

    body.appendChild(speedsSection);

    // Support Material Subtraction
    const supportLabel = document.createElement('label');
    supportLabel.className = 'check-row';
    supportLabel.style.cssText =
      'display:flex;align-items:flex-start;gap:6px;cursor:pointer;font-size:12px;' +
      'padding:6px;border-radius:var(--radius-sm,4px);background:var(--oxr-bg-card,rgba(128,128,128,0.04));';

    const supportChk = document.createElement('input');
    supportChk.type = 'checkbox';
    supportChk.dataset.waveSupportSubtract = 'true';
    supportChk.checked = settings.supportRemainingAreas;
    supportChk.disabled = !settings.enabled || !!busy;
    supportChk.style.cssText = 'margin-block-start:2px;cursor:pointer;';
    supportChk.onchange = () => {
      void this.adapter.onUpdate({ supportRemainingAreas: supportChk.checked });
    };

    const supportTextWrap = document.createElement('div');
    supportTextWrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

    const supportTitle = document.createElement('span');
    supportTitle.textContent = t('ui.waveOverhangs.supportSubtract', 'Subtract wave coverage from supports');
    supportTitle.style.cssText = 'font-weight:500;color:var(--oxr-color-text);';

    const supportDesc = document.createElement('span');
    supportDesc.textContent = t(
      'ui.waveOverhangs.supportSubtractDesc',
      'Automatically disables normal and tree supports underneath overhang areas successfully printed with wave paths.',
    );
    supportDesc.style.cssText = 'font-size:11px;color:var(--oxr-color-text-muted);line-height:1.3;';

    supportTextWrap.appendChild(supportTitle);
    supportTextWrap.appendChild(supportDesc);
    supportLabel.appendChild(supportChk);
    supportLabel.appendChild(supportTextWrap);
    body.appendChild(supportLabel);

    // Advanced Tunables Disclosure
    const advDetails = document.createElement('details');
    advDetails.style.cssText = 'font-size:11.5px;';
    const advSummary = document.createElement('summary');
    advSummary.textContent = t('ui.waveOverhangs.advancedSettings', 'Advanced wave tunables');
    advSummary.style.cssText = 'cursor:pointer;font-weight:600;color:var(--oxr-color-text-muted);padding:4px 0;';
    advDetails.appendChild(advSummary);

    const advContent = document.createElement('div');
    advContent.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:6px 0;margin-block-start:4px;';

    if (settings.algorithm === 'kaiser') {
      advContent.appendChild(
        this.createNumberRow(
          t('ui.waveOverhangs.ringOverlap', 'Kaiser ring overlap (0-1):'),
          settings.ringOverlap,
          'waveRingOverlap',
          0,
          1,
          0.05,
          (val) => this.adapter.onUpdate({ ringOverlap: val }),
          !settings.enabled || !!busy,
        ),
      );
    }

    advContent.appendChild(
      this.createNumberRow(
        t('ui.waveOverhangs.minWaveTime', 'Min wave dwell time (s):'),
        settings.minWaveTimeS,
        'waveMinTime',
        0,
        10,
        0.1,
        (val) => this.adapter.onUpdate({ minWaveTimeS: val }),
        !settings.enabled || !!busy,
      ),
    );

    advContent.appendChild(
      this.createNumberRow(
        t('ui.waveOverhangs.endRetract', 'End-of-line retract (mm):'),
        settings.endRetractMm,
        'waveEndRetract',
        0,
        10,
        0.1,
        (val) => this.adapter.onUpdate({ endRetractMm: val }),
        !settings.enabled || !!busy,
      ),
    );

    const debugLabel = document.createElement('label');
    debugLabel.className = 'check-row';
    debugLabel.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;';
    const debugChk = document.createElement('input');
    debugChk.type = 'checkbox';
    debugChk.dataset.waveDebug = 'true';
    debugChk.checked = settings.debugGCode;
    debugChk.disabled = !settings.enabled || !!busy;
    debugChk.onchange = () => {
      void this.adapter.onUpdate({ debugGCode: debugChk.checked });
    };
    const debugText = document.createElement('span');
    debugText.textContent = t('ui.waveOverhangs.debugGcode', 'Emit structured debug comments in G-code');
    debugLabel.appendChild(debugChk);
    debugLabel.appendChild(debugText);
    advContent.appendChild(debugLabel);

    advDetails.appendChild(advContent);
    body.appendChild(advDetails);

    root.appendChild(body);
  }

  private createPresetButton(label: string, hint: string, onClick: () => void): HTMLButtonElement {
    const document = this.container.ownerDocument;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-preset';
    btn.textContent = label;
    btn.title = hint;
    btn.style.cssText =
      'flex:1 1 auto;padding:4px 8px;font-size:11px;font-weight:500;border-radius:var(--radius-sm,4px);' +
      'border:1px solid var(--oxr-border,rgba(128,128,128,0.25));background:var(--oxr-surface,transparent);' +
      'color:var(--oxr-color-text);cursor:pointer;text-align:center;';
    btn.onclick = onClick;
    return btn;
  }

  private createNumberRow(
    labelText: string,
    value: number,
    datasetKey: string,
    min: number,
    max: number,
    step: number,
    onChange: (val: number) => void,
    disabled: boolean,
  ): HTMLElement {
    const document = this.container.ownerDocument;
    const inputId = `oxr-wave-num-${datasetKey}-${this.instanceId}`;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

    const lbl = document.createElement('label');
    lbl.htmlFor = inputId;
    lbl.textContent = labelText;
    lbl.style.cssText = 'font-size:11.5px;color:var(--oxr-color-text-muted);cursor:pointer;';

    const input = document.createElement('input');
    input.id = inputId;
    input.type = 'number';
    input.dataset[datasetKey] = 'true';
    input.className = 'field-control text-input';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.disabled = disabled;
    input.style.cssText = 'width:60px;padding:3px 6px;font-size:12px;text-align:end;';
    input.onchange = () => {
      const parsed = parseFloat(input.value);
      if (Number.isFinite(parsed)) onChange(parsed);
    };

    row.appendChild(lbl);
    row.appendChild(input);
    return row;
  }
}

export interface MountWaveOverhangsPanelOptions {
  container: HTMLElement;
  workspace: {
    getProjectSettingsOverrideSnapshot(): {
      effectiveConfig: Record<string, unknown>;
      overrides: Record<string, unknown>;
      inheritedConfig: Record<string, unknown>;
      sourceRevision: number;
      sourceHash: string;
    };
    subscribeCanonicalState(listener: () => void): () => void;
  };
  registry: {
    invoke(id: string, surface: string, ctx: unknown, state: unknown, payload: unknown): Promise<boolean>;
  };
  actionCtx: unknown;
  getUiState: () => unknown;
  onErrorMessage?: (message: string) => void;
}

export function mountWaveOverhangsPanel(options: MountWaveOverhangsPanelOptions): () => void {
  const { container, workspace, registry, actionCtx, getUiState, onErrorMessage } = options;

  const WAVE_KEYS = [
    'wave_overhangs',
    'wave_overhang_algorithm',
    'wave_overhang_print_speed',
    'wave_overhang_travel_speed',
    'wave_overhang_fan_speed',
    'wave_overhang_aux_fan_speed',
    'wave_overhang_floor_use_hilbert',
    'wave_overhang_floor_layers',
    'wave_overhang_floor_hilbert_density',
    'wave_overhang_floor_print_speed',
    'wave_overhang_floor_fan_speed',
    'support_remaining_areas_after_wave_overhangs',
    'wave_overhang_ring_overlap',
    'wave_overhang_min_wave_time',
    'wave_overhang_end_retract_length',
    'wave_overhang_debug_gcode',
  ] as const;

  const readWaveSettings = (): WaveOverhangsPanelState => {
    const snap = workspace.getProjectSettingsOverrideSnapshot();
    const eff = snap.effectiveConfig;
    const ov = snap.overrides;
    const hasOverrides = WAVE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(ov, k));

    const enabled = eff.wave_overhangs === true || eff.wave_overhangs === 1 || eff.wave_overhangs === '1';
    const algorithm: 'andersons' | 'kaiser' = eff.wave_overhang_algorithm === 'kaiser' ? 'kaiser' : 'andersons';
    const printSpeedMmS =
      typeof eff.wave_overhang_print_speed === 'number'
        ? eff.wave_overhang_print_speed
        : Number(eff.wave_overhang_print_speed) || DEFAULT_WAVE_OVERHANGS_SETTINGS.printSpeedMmS;
    const travelSpeedMmS =
      typeof eff.wave_overhang_travel_speed === 'number'
        ? eff.wave_overhang_travel_speed
        : Number(eff.wave_overhang_travel_speed) || DEFAULT_WAVE_OVERHANGS_SETTINGS.travelSpeedMmS;
    const fanSpeedPercent =
      typeof eff.wave_overhang_fan_speed === 'number'
        ? eff.wave_overhang_fan_speed
        : Number(eff.wave_overhang_fan_speed) || DEFAULT_WAVE_OVERHANGS_SETTINGS.fanSpeedPercent;
    const auxFanSpeedPercent =
      typeof eff.wave_overhang_aux_fan_speed === 'number'
        ? eff.wave_overhang_aux_fan_speed
        : Number(eff.wave_overhang_aux_fan_speed) || DEFAULT_WAVE_OVERHANGS_SETTINGS.auxFanSpeedPercent;
    const floorUseHilbert =
      eff.wave_overhang_floor_use_hilbert === false ||
      eff.wave_overhang_floor_use_hilbert === 0 ||
      eff.wave_overhang_floor_use_hilbert === '0'
        ? false
        : true;
    const floorLayers =
      typeof eff.wave_overhang_floor_layers === 'number'
        ? eff.wave_overhang_floor_layers
        : Number(eff.wave_overhang_floor_layers) || DEFAULT_WAVE_OVERHANGS_SETTINGS.floorLayers;
    const floorHilbertDensity =
      typeof eff.wave_overhang_floor_hilbert_density === 'number'
        ? eff.wave_overhang_floor_hilbert_density
        : Number(eff.wave_overhang_floor_hilbert_density) || DEFAULT_WAVE_OVERHANGS_SETTINGS.floorHilbertDensity;
    const floorPrintSpeedMmS =
      typeof eff.wave_overhang_floor_print_speed === 'number'
        ? eff.wave_overhang_floor_print_speed
        : Number(eff.wave_overhang_floor_print_speed) || DEFAULT_WAVE_OVERHANGS_SETTINGS.floorPrintSpeedMmS;
    const floorFanSpeedPercent =
      typeof eff.wave_overhang_floor_fan_speed === 'number'
        ? eff.wave_overhang_floor_fan_speed
        : Number(eff.wave_overhang_floor_fan_speed) || DEFAULT_WAVE_OVERHANGS_SETTINGS.floorFanSpeedPercent;
    const supportRemainingAreas =
      eff.support_remaining_areas_after_wave_overhangs === false ||
      eff.support_remaining_areas_after_wave_overhangs === 0 ||
      eff.support_remaining_areas_after_wave_overhangs === '0'
        ? false
        : true;
    const ringOverlap =
      typeof eff.wave_overhang_ring_overlap === 'number'
        ? eff.wave_overhang_ring_overlap
        : Number(eff.wave_overhang_ring_overlap) || DEFAULT_WAVE_OVERHANGS_SETTINGS.ringOverlap;
    const minWaveTimeS =
      typeof eff.wave_overhang_min_wave_time === 'number'
        ? eff.wave_overhang_min_wave_time
        : Number(eff.wave_overhang_min_wave_time) || DEFAULT_WAVE_OVERHANGS_SETTINGS.minWaveTimeS;
    const endRetractMm =
      typeof eff.wave_overhang_end_retract_length === 'number'
        ? eff.wave_overhang_end_retract_length
        : Number(eff.wave_overhang_end_retract_length) || DEFAULT_WAVE_OVERHANGS_SETTINGS.endRetractMm;
    const debugGCode =
      eff.wave_overhang_debug_gcode === false ||
      eff.wave_overhang_debug_gcode === 0 ||
      eff.wave_overhang_debug_gcode === '0'
        ? false
        : true;

    return {
      settings: {
        enabled,
        algorithm,
        printSpeedMmS,
        travelSpeedMmS,
        fanSpeedPercent,
        auxFanSpeedPercent,
        floorUseHilbert,
        floorLayers,
        floorHilbertDensity,
        floorPrintSpeedMmS,
        floorFanSpeedPercent,
        supportRemainingAreas,
        ringOverlap,
        minWaveTimeS,
        endRetractMm,
        debugGCode,
      },
      hasOverrides,
    };
  };

  const panel = new WaveOverhangsPanel(container, {
    getState: () => readWaveSettings(),
    subscribe: (listener) => workspace.subscribeCanonicalState(listener),
    onUpdate: async (patch) => {
      const snap = workspace.getProjectSettingsOverrideSnapshot();
      const nextOverrides: Record<string, unknown> = { ...snap.overrides };

      if (patch.enabled !== undefined) nextOverrides.wave_overhangs = patch.enabled ? '1' : '0';
      if (patch.algorithm !== undefined) nextOverrides.wave_overhang_algorithm = patch.algorithm;
      if (patch.printSpeedMmS !== undefined) nextOverrides.wave_overhang_print_speed = String(patch.printSpeedMmS);
      if (patch.travelSpeedMmS !== undefined) nextOverrides.wave_overhang_travel_speed = String(patch.travelSpeedMmS);
      if (patch.fanSpeedPercent !== undefined) nextOverrides.wave_overhang_fan_speed = String(patch.fanSpeedPercent);
      if (patch.auxFanSpeedPercent !== undefined)
        nextOverrides.wave_overhang_aux_fan_speed = String(patch.auxFanSpeedPercent);
      if (patch.floorUseHilbert !== undefined)
        nextOverrides.wave_overhang_floor_use_hilbert = patch.floorUseHilbert ? '1' : '0';
      if (patch.floorLayers !== undefined) nextOverrides.wave_overhang_floor_layers = String(patch.floorLayers);
      if (patch.floorHilbertDensity !== undefined)
        nextOverrides.wave_overhang_floor_hilbert_density = String(patch.floorHilbertDensity);
      if (patch.floorPrintSpeedMmS !== undefined)
        nextOverrides.wave_overhang_floor_print_speed = String(patch.floorPrintSpeedMmS);
      if (patch.floorFanSpeedPercent !== undefined)
        nextOverrides.wave_overhang_floor_fan_speed = String(patch.floorFanSpeedPercent);
      if (patch.supportRemainingAreas !== undefined)
        nextOverrides.support_remaining_areas_after_wave_overhangs = patch.supportRemainingAreas ? '1' : '0';
      if (patch.ringOverlap !== undefined) nextOverrides.wave_overhang_ring_overlap = String(patch.ringOverlap);
      if (patch.minWaveTimeS !== undefined) nextOverrides.wave_overhang_min_wave_time = String(patch.minWaveTimeS);
      if (patch.endRetractMm !== undefined) nextOverrides.wave_overhang_end_retract_length = String(patch.endRetractMm);
      if (patch.debugGCode !== undefined) nextOverrides.wave_overhang_debug_gcode = patch.debugGCode ? '1' : '0';

      await registry.invoke('settings_apply_project', 'dom-inspector', actionCtx, getUiState(), {
        projectSettingsApply: {
          inheritedConfig: snap.inheritedConfig as unknown as any,
          overrides: nextOverrides as unknown as any,
          sourceRevision: snap.sourceRevision,
          sourceHash: snap.sourceHash,
        },
      });
    },
    onReset: async () => {
      const snap = workspace.getProjectSettingsOverrideSnapshot();
      const nextOverrides: Record<string, unknown> = { ...snap.overrides };
      for (const k of WAVE_KEYS) {
        delete nextOverrides[k];
      }
      await registry.invoke('settings_apply_project', 'dom-inspector', actionCtx, getUiState(), {
        projectSettingsApply: {
          inheritedConfig: snap.inheritedConfig as unknown as any,
          overrides: nextOverrides as unknown as any,
          sourceRevision: snap.sourceRevision,
          sourceHash: snap.sourceHash,
        },
      });
    },
    onError: (error) => {
      onErrorMessage?.(
        t('app.main.waveOverhangsError', 'Wave overhangs: {reason}', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });

  panel.mount();
  const dispose = () => panel.dispose();
  window.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
