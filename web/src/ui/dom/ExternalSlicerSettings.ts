import { SlicerClient } from '../../slicer/SlicerClient';
import { normalizeHttpEndpoint } from '../../net/LocalNetworkAccess';
import { t } from '../../l10n/t';

export interface ExternalSlicerSettingsOptions {
  readonly root: Document;
  readonly initialToken: string;
  readonly status: (message: string) => void;
  readonly changed: () => void;
  readonly credentialsChanged: () => void;
  readonly reportFailure: (endpoint: string, error: unknown, isCurrent: () => boolean) => Promise<void>;
}

const mounted = new WeakMap<Document, { dispose(): void }>();

/** Settings surface owns its listeners; the shared controller owns route truth. */
export function mountExternalSlicerSettings(options: ExternalSlicerSettingsOptions): { dispose(): void } {
  const { root } = options;
  mounted.get(root)?.dispose();
  const input = (id: string) => root.getElementById(id) as HTMLInputElement;
  const url = input('external-slicer-url');
  const token = input('external-slicer-token');
  const enabled = input('external-slicer-enabled');
  const connect = root.getElementById('btn-external-slicer-connect') as HTMLButtonElement;
  const remove = root.getElementById('btn-external-slicer-delete') as HTMLButtonElement;
  const status = root.getElementById('external-slicer-status')!;
  const controls = root.getElementById('external-slicer-controls')!;
  const hint = root.getElementById('external-slicer-hint')!;
  if (![url, token, enabled, connect, remove, status, controls, hint].every(Boolean))
    throw new Error('External slicer controls are missing.');
  const listeners = new AbortController();
  let disposed = false;
  let draft = false;
  token.value = options.initialToken;

  const render = () => {
    if (disposed) return;
    const state = SlicerClient.getExternalSlicerConnection();
    if (!draft) url.value = state.endpoint;
    enabled.checked = state.enabled;
    controls.style.display = state.endpoint || state.phase === 'probing' ? 'flex' : 'none';
    hint.style.display = state.endpoint || state.persistence === 'session-only' ? 'block' : 'none';
    hint.textContent = state.enabled
      ? t('app.externalSlicer.on', 'On — models will be sliced on the external server.')
      : t('app.externalSlicer.off', 'Off — slicing locally in-browser.');
    if (state.persistence === 'session-only')
      hint.textContent += ` ${t('app.externalSlicer.sessionOnly', 'This choice is only saved for this tab. Browser storage is unavailable.')}`;
    status.textContent =
      state.phase === 'probing'
        ? t('app.externalSlicer.checking', 'Checking engine…')
        : state.phase === 'failed'
          ? state.reason
          : state.enabled
            ? state.origin === 'auto-discovered'
              ? t('app.externalSlicer.here', 'Slicing here — attested')
              : t('app.externalSlicer.online', 'Online — attested')
            : t('app.externalSlicer.offline', 'Offline');
    status.style.color = state.enabled ? 'var(--oxr-ok)' : 'var(--oxr-text-muted)';
    options.changed();
  };
  const unsubscribe = SlicerClient.subscribeExternalSlicerConnection(render);
  const listen = (element: EventTarget, type: string, run: EventListener) =>
    element.addEventListener(type, run, { signal: listeners.signal });
  const connectCandidate = async (candidate: string, origin: 'user' | 'auto-discovered' = 'user') => {
    const pending = SlicerClient.connectExternalSlicer(candidate, undefined, origin);
    const generation = SlicerClient.getExternalSlicerConnection().generation;
    try {
      await pending;
      if (disposed || SlicerClient.getExternalSlicerConnection().generation !== generation) return;
      draft = false;
      render();
      options.status(
        t('app.main.externalSlicerConnectedExternalSlicing', 'External slicer connected — external slicing is on.'),
      );
    } catch (error) {
      if (disposed || SlicerClient.getExternalSlicerConnection().generation !== generation) return;
      draft = false;
      render();
      options.status(
        t('app.main.externalSlicerConnectionFailedSlicing', 'External slicer connection failed — slicing locally.'),
      );
      const endpoint = normalizeHttpEndpoint(candidate);
      if (endpoint)
        await options.reportFailure(
          endpoint,
          error,
          () => !disposed && SlicerClient.getExternalSlicerConnection().generation === generation,
        );
    }
  };
  listen(url, 'input', () => {
    draft = true;
    SlicerClient.invalidateExternalSlicerProbe();
  });
  listen(token, 'input', () => {
    SlicerClient.setExternalSlicerToken(token.value);
    options.credentialsChanged();
  });
  listen(enabled, 'change', () => {
    if (!enabled.checked) SlicerClient.disableExternalSlicer();
    else void connectCandidate(SlicerClient.getExternalSlicerUrl());
  });
  listen(remove, 'click', () => {
    draft = false;
    SlicerClient.clearExternalSlicer();
    options.status(t('app.main.externalSlicerRemovedSlicingLocally', 'External slicer removed — slicing locally.'));
  });
  listen(connect, 'click', () => {
    if (!url.value.trim()) {
      draft = false;
      SlicerClient.clearExternalSlicer();
    } else void connectCandidate(url.value);
  });
  const start = () => {
    const state = SlicerClient.getExternalSlicerConnection();
    if (state.enabled) {
      void connectCandidate(state.endpoint, state.origin === 'auto-discovered' ? 'auto-discovered' : 'user');
    } else {
      const pending = SlicerClient.autoDiscoverExternalSlicer();
      const generation = SlicerClient.getExternalSlicerConnection().generation;
      void pending.then((result) => {
        if (disposed || generation !== SlicerClient.getExternalSlicerConnection().generation || !result.discovered)
          return;
        render();
        options.status(
          t('app.main.externalSlicerAutoDiscoveredAttested', 'External slicer auto-discovered — slicing on container.'),
        );
      });
    }
  };
  const view = root.defaultView;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    listeners.abort();
    SlicerClient.invalidateExternalSlicerProbe();
    mounted.delete(root);
  };
  if (view) {
    listen(view, 'storage', () => SlicerClient.refreshExternalSlicerPreferences());
    listen(view, 'pagehide', (event) => {
      if ((event as PageTransitionEvent).persisted) SlicerClient.invalidateExternalSlicerProbe();
      else dispose();
    });
    listen(view, 'pageshow', (event) => {
      if ((event as PageTransitionEvent).persisted) start();
    });
    const warning = root.getElementById('external-slicer-insecure-warning');
    const host = view.location.hostname;
    if (
      warning &&
      view.isSecureContext === false &&
      !['localhost', '127.0.0.1', '::1'].includes(host) &&
      !host.endsWith('.localhost')
    )
      warning.style.display = 'block';
  }
  render();
  start();
  const surface = { dispose };
  mounted.set(root, surface);
  return surface;
}
