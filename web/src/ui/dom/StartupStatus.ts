import { initializationFeatureLabel } from '../../startup/labels';
import type { FeatureInitializationRegistry, InitializationSnapshot } from '../../startup/FeatureInitialization';
import { t } from '../../l10n/t';

export class StartupStatus {
  private unsubscribe?: () => void;
  private collapsed = false;
  constructor(
    private readonly host: HTMLElement,
    private readonly registry: FeatureInitializationRegistry,
    private readonly recover: (id: string) => void,
  ) {}
  mount(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.registry.subscribe((snapshot) => this.render(snapshot));
  }
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.host.replaceChildren();
  }
  private render(snapshot: InitializationSnapshot): void {
    const document = this.host.ownerDocument;
    this.host.classList.toggle('ready', snapshot.phase === 'ready');
    this.host.dataset.bootState = snapshot.phase;
    this.host.dataset.shellUsable = String(snapshot.features.some((f) => f.id === 'shell' && f.phase === 'ready'));
    const card = document.createElement('div');
    card.className = 'boot-card';
    const title = document.createElement('strong');
    title.tabIndex = -1;
    title.textContent =
      snapshot.phase === 'failed'
        ? t('startup.requiredUnavailable', 'Some required features are unavailable')
        : snapshot.phase === 'degraded'
          ? t('startup.optionalUnavailable', 'Some optional features are unavailable')
          : t('startup.preparing', 'Preparing OrcaXR');
    card.append(title);
    if (snapshot.phase === 'failed' || snapshot.phase === 'degraded') {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.dataset.startupDetails = 'true';
      toggle.textContent = this.collapsed
        ? t('startup.showDetails', 'Show recovery details')
        : t('startup.hideDetails', 'Hide recovery details');
      toggle.setAttribute('aria-expanded', String(!this.collapsed));
      toggle.addEventListener('click', () => {
        this.collapsed = !this.collapsed;
        this.render(this.registry.snapshot);
      });
      card.append(toggle);
    }
    for (const feature of snapshot.features.filter((f) => f.phase === 'failed' || (f.core && f.phase !== 'ready'))) {
      const row = document.createElement('div');
      row.hidden = this.collapsed;
      row.dataset.startupFeature = feature.id;
      const detail = document.createElement('p');
      detail.textContent =
        feature.phase === 'failed'
          ? `${initializationFeatureLabel(feature)}: ${feature.reason}`
          : t('startup.loadingFeature', 'Loading {feature}…', { feature: initializationFeatureLabel(feature) });
      row.append(detail);
      if (feature.phase === 'failed') {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.startupRecovery = feature.id;
        button.textContent =
          feature.recovery === 'reload'
            ? t('startup.reloadFeature', 'Reload to restore {feature}', {
                feature: initializationFeatureLabel(feature),
              })
            : t('startup.retryFeature', 'Retry {feature}', { feature: initializationFeatureLabel(feature) });
        button.addEventListener('click', () => this.recover(feature.id));
        row.append(button);
      }
      card.append(row);
    }
    const wasFocused = this.host.contains(document.activeElement);
    this.host.replaceChildren(card);
    if (wasFocused && snapshot.phase !== 'ready') title.focus();
  }
}
