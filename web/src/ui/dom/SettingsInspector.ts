import { SettingsConfig, type SettingSchema, type SettingSection, type SettingRow } from '../../actions/SettingsConfig';
import type { OrcaWorkspace } from '../../workspace/OrcaWorkspace';

export class SettingsInspector {
  private activeCategory: keyof SettingSchema = 'process';
  private activeGroupId: string = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly workspace: OrcaWorkspace,
  ) {
    this.activeGroupId = SettingsConfig[this.activeCategory][0].id;
  }

  mount() {
    this.render();
  }

  private render() {
    this.container.innerHTML = '';

    // 1. Top tabs (Process, Filament, Printer)
    const tabsContainer = document.createElement('div');
    tabsContainer.style.cssText =
      'display:flex; gap:2px; background:var(--oxr-color-bg-sunken, #0000004d); padding:4px; border-radius:var(--oxr-radius-sm, 8px); margin-bottom:12px;';

    const categories: { id: keyof SettingSchema; label: string }[] = [
      { id: 'process', label: 'Process' },
      { id: 'filament', label: 'Filament' },
      { id: 'printer', label: 'Printer' },
    ];

    for (const cat of categories) {
      const tab = document.createElement('button');
      tab.textContent = cat.label;
      const isActive = this.activeCategory === cat.id;
      tab.style.cssText = `
        flex: 1; padding: 6px 0; border: none; background: ${isActive ? 'var(--oxr-color-bg-card, #0d141cA6)' : 'transparent'};
        color: ${isActive ? 'var(--oxr-color-text, #fff)' : 'var(--oxr-color-text-muted, #a0aab5)'};
        border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer; transition: all 0.2s ease;
        ${isActive ? 'box-shadow: 0 2px 8px rgba(0,0,0,0.2);' : ''}
      `;
      tab.onclick = () => {
        this.activeCategory = cat.id;
        this.activeGroupId = SettingsConfig[cat.id][0].id;
        this.render();
      };
      tabsContainer.appendChild(tab);
    }
    this.container.appendChild(tabsContainer);

    // 2. Group chips (Quality, Strength, Speed...)
    const groupsContainer = document.createElement('div');
    groupsContainer.style.cssText =
      'display:flex; gap:6px; overflow-x:auto; padding-bottom:8px; margin-bottom:4px; scrollbar-width:none;';

    const groups = SettingsConfig[this.activeCategory];
    for (const group of groups) {
      const chip = document.createElement('button');
      chip.textContent = group.label;
      const isActive = this.activeGroupId === group.id;
      chip.style.cssText = `
        white-space: nowrap; padding: 6px 12px; border-radius: 14px; font-size: 12px; font-weight: 600; border: none; cursor: pointer;
        background: ${isActive ? 'var(--oxr-color-accent, #ff6d00)' : 'var(--oxr-color-surface, #ffffff14)'};
        color: ${isActive ? 'var(--oxr-color-on-accent, #000)' : 'var(--oxr-color-text, #fff)'};
      `;
      chip.onclick = () => {
        this.activeGroupId = group.id;
        this.render();
      };
      groupsContainer.appendChild(chip);
    }
    this.container.appendChild(groupsContainer);

    // 3. Settings scrollable area
    const settingsArea = document.createElement('div');
    settingsArea.style.cssText =
      'flex: 1; overflow-y: auto; padding-right: 4px; display: flex; flex-direction: column; gap: 16px;';

    const activeGroup = groups.find((g) => g.id === this.activeGroupId) || groups[0];
    for (const section of activeGroup.sections) {
      settingsArea.appendChild(this.buildSection(section));
    }
    this.container.appendChild(settingsArea);
  }

  private buildSection(section: SettingSection): HTMLElement {
    const secEl = document.createElement('div');

    const title = document.createElement('div');
    title.textContent = section.title;
    title.style.cssText =
      'font-size: 11px; font-weight: 700; color: var(--oxr-color-text-muted, #a0aab5); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; border-bottom: 1px solid var(--oxr-color-stroke, #ffffff1a); padding-bottom: 4px;';
    secEl.appendChild(title);

    const rowsContainer = document.createElement('div');
    rowsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

    for (const row of section.rows) {
      rowsContainer.appendChild(this.buildRow(row));
    }
    secEl.appendChild(rowsContainer);
    return secEl;
  }

  private buildRow(row: SettingRow): HTMLElement {
    const rowEl = document.createElement('div');
    rowEl.style.cssText =
      'display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: var(--oxr-color-text, #fff);';

    const label = document.createElement('span');
    label.textContent = row.label;
    label.style.flex = '1';
    rowEl.appendChild(label);

    const controlWrapper = document.createElement('div');
    controlWrapper.style.cssText = 'display: flex; align-items: center; gap: 6px;';

    // Currently we hook into workspace.customOverrides, but only a few keys are supported in main.ts.
    // For unsupported keys, we just show them as UI without backend logic for now.
    const currentValue = this.workspace.customOverrides[row.key] || row.defaultValue;

    if (row.type === 'b') {
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = currentValue === '1' || currentValue === 'On';
      chk.style.cssText =
        'width: 16px; height: 16px; accent-color: var(--oxr-color-accent, #ffb74d); cursor: pointer; margin: 0;';
      chk.onchange = () => {
        this.workspace.customOverrides[row.key] = chk.checked ? '1' : '0';
      };
      controlWrapper.appendChild(chk);
    } else if (row.type === 'n') {
      const input = document.createElement('input');
      input.type = 'text'; // use text to allow empty or numbers
      input.value = currentValue;
      input.style.cssText =
        'width: 60px; box-sizing: border-box; background: var(--oxr-color-bg-sunken, #0000004d); color: #fff; border: 1px solid var(--oxr-color-stroke, #ffffff1a); border-radius: 6px; padding: 4px 6px; font-size: 13px; text-align: right; outline: none;';
      input.oninput = () => {
        let val = input.value;
        if (row.unit === '%' && val && !val.endsWith('%')) {
          val += '%';
        }
        this.workspace.customOverrides[row.key] = val;
      };
      controlWrapper.appendChild(input);
      if (row.unit) {
        const unit = document.createElement('span');
        unit.textContent = row.unit;
        unit.style.cssText = 'color: var(--oxr-color-text-muted, #a0aab5); font-size: 12px; width: 24px;';
        controlWrapper.appendChild(unit);
      }
    } else if (row.type === 'e') {
      const select = document.createElement('select');
      select.style.cssText =
        'background: var(--oxr-color-bg-sunken, #0000004d); color: #fff; border: 1px solid var(--oxr-color-stroke, #ffffff1a); border-radius: 6px; padding: 4px 6px; font-size: 12px; outline: none; cursor: pointer;';
      const opt = document.createElement('option');
      opt.textContent = currentValue;
      select.appendChild(opt);
      // We don't have enum options in the schema yet, just spoof it with defaultValue
      if (currentValue !== row.defaultValue) {
        const opt2 = document.createElement('option');
        opt2.textContent = row.defaultValue;
        select.appendChild(opt2);
      }
      select.onchange = () => {
        this.workspace.customOverrides[row.key] = select.value;
      };
      controlWrapper.appendChild(select);
    } else {
      const span = document.createElement('span');
      span.textContent = currentValue;
      span.style.cssText = 'color: var(--oxr-color-text-muted, #a0aab5); font-style: italic;';
      controlWrapper.appendChild(span);
    }

    rowEl.appendChild(controlWrapper);
    return rowEl;
  }
}
