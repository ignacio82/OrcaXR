/**
 * Which transport the browser transport tests drive. They run as written
 * against the browser `MoonrakerTransport`; `moonraker-transport-shared.test.ts`
 * selects the shared core's before importing them, so one suite holds both
 * implementations to the same behaviour.
 */
import { MoonrakerTransport, type MoonrakerTransportConfig, type MoonrakerTransportDependencies } from '..';

export type MoonrakerTransportFactory = (
  config: MoonrakerTransportConfig,
  dependencies: MoonrakerTransportDependencies,
) => MoonrakerTransport;

let factory: MoonrakerTransportFactory = (config, dependencies) => new MoonrakerTransport(config, dependencies);

export function useMoonrakerTransport(next: MoonrakerTransportFactory): void {
  factory = next;
}

export function createMoonrakerTransport(
  config: MoonrakerTransportConfig,
  dependencies: MoonrakerTransportDependencies,
): MoonrakerTransport {
  return factory(config, dependencies);
}
