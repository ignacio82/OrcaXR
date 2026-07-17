/**
 * Persisted project references are branded so IDs from different entity
 * families cannot be mixed accidentally. The brand is erased at runtime and
 * every ID remains ordinary serializable text.
 */
declare const entityIdBrand: unique symbol;

export type EntityId<Kind extends string> = string & {
  readonly [entityIdBrand]: Kind;
};

export type ProjectId = EntityId<'project'>;
export type PlateId = EntityId<'plate'>;
export type ObjectId = EntityId<'object'>;
export type VolumeId = EntityId<'volume'>;
export type InstanceId = EntityId<'instance'>;
export type LayerRangeId = EntityId<'layer-range'>;
export type PhysicalFilamentId = EntityId<'physical-filament'>;
export type MixedFilamentId = EntityId<'mixed-filament'>;
export type FilamentId = PhysicalFilamentId | MixedFilamentId;
export type AssetId = EntityId<'asset'>;
export type ThumbnailId = EntityId<'thumbnail'>;
export type ExtensionBlobId = EntityId<'extension-blob'>;
export type CustomGcodeId = EntityId<'custom-gcode'>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMPORTED_ID_PATTERN = /^import:[a-z0-9][a-z0-9._-]*:[^\s]+$/i;

/** Imported stable identifiers must be explicitly namespaced. */
export function isStableEntityId(value: string): boolean {
  return UUID_PATTERN.test(value) || IMPORTED_ID_PATTERN.test(value);
}

export function entityId<Kind extends string>(value: string): EntityId<Kind> {
  if (!isStableEntityId(value)) {
    throw new Error(`Invalid stable entity ID "${value}"; expected a UUID or import:<source>:<id>`);
  }
  return value as EntityId<Kind>;
}

export interface IdSource {
  next<Kind extends string>(kind: Kind): EntityId<Kind>;
}

export type RandomWordSource = () => number;

/**
 * Platform-neutral UUIDv4 source. Production composition roots may inject a
 * cryptographically strong random-word source; deterministic tests can inject
 * a seeded source without leaking that concern into the project domain.
 */
export class UuidIdSource implements IdSource {
  constructor(private readonly randomWord: RandomWordSource = Math.random) {}

  next<Kind extends string>(_kind: Kind): EntityId<Kind> {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(this.randomWord() * 256) & 0xff;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    const value = `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
      .slice(6, 8)
      .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
    return value as EntityId<Kind>;
  }
}

/** Small deterministic PRNG used by property-style tests and fixture builders. */
export function seededRandom(seed: number): RandomWordSource {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
