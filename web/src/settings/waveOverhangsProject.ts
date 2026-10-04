/**
 * Whether a project prints wave overhangs — the one wave question the slice
 * route asks, kept apart from `waveOverhangs.ts` on purpose.
 *
 * The route check runs in the main bundle. The option table's labels, tooltips
 * and guidance are only needed once a panel opens, and importing them from the
 * route would pull every one of them into the bundle that has to load before
 * the app can start. So this module carries no text, and `waveOverhangs.ts`
 * builds on it rather than the other way round.
 */

export const WAVE_MASTER_KEY = 'wave_overhangs';

/** A stored boolean as the engine reads it (`1`/`0`, `true`/`false`), or `undefined` when it would refuse it. */
export function parseWaveBool(raw: unknown): boolean | undefined {
  const scalar = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (typeof scalar === 'boolean') return scalar;
  if (scalar === 1 || scalar === '1' || scalar === 'true') return true;
  if (scalar === 0 || scalar === '0' || scalar === 'false') return false;
  return undefined;
}

interface WaveConfigNode {
  readonly config: Readonly<Record<string, unknown>>;
}

/** The parts of a project an engine slice layers config from (a `ProjectState` fits). */
export interface WaveProjectShape extends WaveConfigNode {
  readonly plates: readonly (WaveConfigNode & {
    readonly objects: readonly (WaveConfigNode & {
      readonly volumes: readonly (WaveConfigNode & { readonly role: string })[];
      readonly layerRanges: readonly WaveConfigNode[];
    })[];
  })[];
}

/**
 * Whether any object in the project slices with wave overhangs on.
 *
 * `wave_overhangs` is a region setting, so an object, one of its parts, or a
 * height range can switch it on (or off) for its own share of the print — an
 * imported project can carry exactly that. Each chain is resolved the way the
 * engine layers it: project, plate, object, then a part or a height range. A
 * stored value the engine would refuse leaves the inherited one in force.
 */
export function projectUsesWaveOverhangs(project: WaveProjectShape): boolean {
  const resolve = (node: WaveConfigNode, inherited: boolean): boolean => {
    if (!Object.prototype.hasOwnProperty.call(node.config, WAVE_MASTER_KEY)) return inherited;
    return parseWaveBool(node.config[WAVE_MASTER_KEY]) ?? inherited;
  };
  const onProject = resolve(project, false);
  for (const plate of project.plates) {
    const onPlate = resolve(plate, onProject);
    for (const object of plate.objects) {
      const onObject = resolve(object, onPlate);
      // Each part and modifier is a region of its own; the object prints waves unless every one turns them off.
      const regions = object.volumes.filter(
        (volume) => volume.role === 'model' || volume.role === 'parameter-modifier',
      );
      if (regions.length === 0 ? onObject : regions.some((volume) => resolve(volume, onObject))) return true;
      if (object.layerRanges.some((range) => resolve(range, onObject))) return true;
    }
  }
  return false;
}
