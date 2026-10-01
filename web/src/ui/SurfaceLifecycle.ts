import { InitializationScope } from '../startup/FeatureInitialization';

/** Owns a mounted surface's resources without knowing its workspace or actions. */
export class SurfaceLifecycle extends InitializationScope {
  listen<K extends keyof WindowEventMap>(target: Window, type: K, listener: (event: WindowEventMap[K]) => void): void;
  listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
  ): void;
  listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void;
  listen(target: EventTarget, type: string, listener: (event: never) => void): void {
    this.assertActive();
    const handler = (event: Event) => {
      if (!this.signal.aborted) listener(event as never);
    };
    target.addEventListener(type, handler);
    this.defer(() => target.removeEventListener(type, handler));
  }

  /** Restore only our own binding, so disposal cannot overwrite a newer owner. */
  bind<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
    this.assertActive();
    const previous = target[key];
    target[key] = value;
    this.defer(() => {
      if (target[key] === value) target[key] = previous;
    });
  }

  /** Link a separately registered feature to the surface that requested it. */
  attach(child: InitializationScope): void {
    if (this.signal.aborted) child.dispose();
    this.assertActive();
    const abort = () => child.dispose();
    this.signal.addEventListener('abort', abort, { once: true });
    child.defer(() => this.signal.removeEventListener('abort', abort));
  }

  observe<T extends { disconnect(): void }>(observer: T): T {
    this.defer(() => observer.disconnect());
    this.assertActive();
    return observer;
  }
}

/** A cached document keeps its surfaces; only permanent departure releases them. */
export function ownPageLifetime(target: Window, owner: InitializationScope, dispose: () => void): void {
  const pagehide = (event: PageTransitionEvent) => {
    if (!event.persisted) dispose();
  };
  owner.assertActive();
  target.addEventListener('pagehide', pagehide);
  owner.defer(() => target.removeEventListener('pagehide', pagehide));
}
