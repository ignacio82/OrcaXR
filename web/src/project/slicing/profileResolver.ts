import { canonicalStringify, cloneJson, deepFreeze } from '../domain/canonical';
import type { PlateId } from '../domain/ids';
import type { MixedFilament, PhysicalFilament, ProjectState } from '../domain/model';
import { findPlate } from '../domain/selectors';
import { Sha256SliceContentHasher } from './hash';
import type {
  SliceContentHasherPort,
  SliceProfileReference,
  SliceProfileResolverPort,
  SliceProfileSnapshot,
} from './types';

const encoder = new TextEncoder();
const CANONICAL_SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * Hashes the effective canonical settings used by one plate. Explicit profile
 * canonical hashes from the project remain authoritative. Missing or legacy
 * non-canonical hashes are converted into SHA-256 identities over the exact
 * canonical configuration that is submitted to the engine.
 */
export class CanonicalStateProfileResolver implements SliceProfileResolverPort {
  constructor(private readonly hasher: SliceContentHasherPort = new Sha256SliceContentHasher()) {}

  async capture(state: ProjectState, plateId: PlateId): Promise<SliceProfileSnapshot> {
    const plate = findPlate(state, plateId);
    if (!plate) throw new Error(`Cannot resolve slice profiles for unknown plate ${plateId}`);

    const effective = {
      printer: state.printer,
      projectConfig: state.config,
      plate: {
        id: plate.id,
        config: plate.config,
        objects: plate.objects.map((object) => ({
          id: object.id,
          config: object.config,
          filamentId: object.filamentId ?? null,
          volumes: object.volumes.map((volume) => ({
            id: volume.id,
            role: volume.role,
            config: volume.config,
            filamentId: volume.filamentId ?? null,
          })),
          layerRanges: object.layerRanges.map((range) => ({
            id: range.id,
            minZMm: range.minZMm,
            maxZMm: range.maxZMm,
            config: range.config,
            filamentId: range.filamentId ?? null,
          })),
        })),
      },
      filaments: state.filaments,
    };
    const effectiveConfigHash = await digestCanonical(this.hasher, effective);
    const references: SliceProfileReference[] = [];

    const printerId = state.printer.profileId?.trim() || 'canonical:effective-printer';
    references.push({
      kind: 'printer',
      id: printerId,
      hash: await canonicalProfileHash(this.hasher, state.printer.profileHash, {
        kind: 'printer',
        id: printerId,
        printer: state.printer,
        projectConfig: state.config,
      }),
    });

    const processId = configString(state.config.print_settings_id) || 'canonical:effective-process';
    references.push({
      kind: 'process',
      id: processId,
      hash: await digestCanonical(this.hasher, {
        kind: 'process',
        id: processId,
        projectConfig: state.config,
        plateConfig: plate.config,
      }),
    });

    for (const [tool, filament] of state.filaments.physical.entries()) {
      references.push(await physicalFilamentReference(this.hasher, filament, tool));
    }

    let tool = state.filaments.physical.length;
    for (const filament of state.filaments.mixed) {
      if (!filament.enabled) continue;
      references.push(await mixedFilamentReference(this.hasher, filament, tool));
      tool += 1;
    }

    return deepFreeze(
      cloneJson({
        references,
        effectiveConfigHash,
      }),
    );
  }
}

async function physicalFilamentReference(
  hasher: SliceContentHasherPort,
  filament: PhysicalFilament,
  tool: number,
): Promise<SliceProfileReference> {
  const id = physicalProfileId(filament);
  return {
    kind: 'filament',
    id,
    hash: await canonicalProfileHash(hasher, filament.presetHash, {
      kind: 'physical-filament',
      id,
      material: filament.material,
      vendor: filament.vendor ?? null,
      nozzleDiameterMm: filament.nozzleDiameterMm ?? null,
      config: filament.config,
    }),
    tool,
  };
}

async function mixedFilamentReference(
  hasher: SliceContentHasherPort,
  filament: MixedFilament,
  tool: number,
): Promise<SliceProfileReference> {
  return {
    kind: 'filament',
    id: filament.id,
    hash: await digestCanonical(hasher, {
      kind: 'mixed-filament',
      id: filament.id,
      name: filament.name,
      displayColor: filament.displayColor,
      components: filament.components,
      distribution: filament.distribution,
      fullSpectrum: filament.fullSpectrum ?? null,
      config: filament.config,
    }),
    tool,
  };
}

async function canonicalProfileHash(
  hasher: SliceContentHasherPort,
  explicitHash: string | undefined,
  effectiveProfile: unknown,
): Promise<string> {
  const normalized = explicitHash?.trim();
  if (normalized && CANONICAL_SHA256.test(normalized)) return normalized;
  return digestCanonical(hasher, {
    schema: 'orcaxr.slice-profile-reference.v1',
    explicitHash: normalized || null,
    effectiveProfile,
  });
}

function physicalProfileId(filament: PhysicalFilament): string {
  return filament.presetId?.trim() || filament.id;
}

async function digestCanonical(hasher: SliceContentHasherPort, value: unknown): Promise<string> {
  const hash = await hasher.digest(encoder.encode(canonicalStringify(value)));
  if (!CANONICAL_SHA256.test(hash))
    throw new Error('Slice profile hashing did not return a canonical SHA-256 identity');
  return hash;
}

function configString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
