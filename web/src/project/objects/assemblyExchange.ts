/**
 * Assembly alignment over a session's shared contract: which pinned
 * alignments two picked surface features allow, the instance transform one
 * produces for the second pick's instance (committed by the host through the
 * same guarded transform intent a drag uses), and the view-only exploded
 * layout (`assembly.ts`). Features are the measure contract's, in the frame
 * the host picked them. A result that is not finite — origins or distances so
 * large the placement overflows — is refused rather than sent. The Rust core
 * answers the same requests (`orcaxr_project::assembly`).
 */
import type {
  ProjectAssemblyAlignmentKindWire,
  ProjectAssemblyAlignmentReplyWire,
  ProjectAssemblyAlignmentRequestWire,
  ProjectAssemblyAvailabilityReplyWire,
  ProjectAssemblyPairWire,
  ProjectAssemblyRefusalCodeWire,
  ProjectExplosionReplyWire,
  ProjectExplosionRequestWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { Quaternion, Vec3 } from '../domain/model';
import {
  AssemblyError,
  inspectAssemblyActions,
  planAssemblyAlignment,
  projectExplosion,
  type AssemblyAlignmentKind,
} from './assembly';
import { featureFromWire } from './measureExchange';

const KINDS: Readonly<Record<ProjectAssemblyAlignmentKindWire, AssemblyAlignmentKind>> = {
  parallel: 'parallel',
  centerCoincidence: 'center-coincidence',
  parallelDistance: 'parallel-distance',
  reverseRotation: 'reverse-rotation',
  aroundFaceCenter: 'around-face-center',
};

const CODES: Readonly<Record<AssemblyError['code'], ProjectAssemblyRefusalCodeWire>> = {
  'unsupported-feature-pair': 'unsupportedFeaturePair',
  'unavailable-action': 'unavailableAction',
  'invalid-parameter': 'invalidParameter',
  'degenerate-axis': 'degenerateAxis',
};

const NOT_FINITE = { code: 'nonFinite', message: wireUnits('The result is not a finite placement') } as const;

function refused(error: unknown) {
  if (!(error instanceof AssemblyError)) throw error;
  return { refused: { code: CODES[error.code], message: wireUnits(error.message) } };
}

/** `AssemblyPair` → `AssemblyAvailabilityReply`. */
export function assemblyAvailabilityWire(request: ProjectAssemblyPairWire): ProjectAssemblyAvailabilityReplyWire {
  try {
    const available = inspectAssemblyActions(featureFromWire(request.first), featureFromWire(request.second));
    if (!Number.isFinite(available.parallelDistanceMm) || !Number.isFinite(available.angleRadians)) {
      return { refused: NOT_FINITE };
    }
    return { available: { ...available } };
  } catch (error) {
    return refused(error);
  }
}

/** `AssemblyAlignmentRequest` → `AssemblyAlignmentReply`. */
export function assemblyAlignmentWire(request: ProjectAssemblyAlignmentRequestWire): ProjectAssemblyAlignmentReplyWire {
  const { translationMm: t, rotation: r, scale: s } = request.movingTransform;
  try {
    const plan = planAssemblyAlignment({
      kind: KINDS[request.kind],
      first: featureFromWire(request.first),
      second: featureFromWire(request.second),
      movingTransform: {
        translationMm: [t[0], t[1], t[2]] as unknown as Vec3,
        rotation: [r[0], r[1], r[2], r[3]] as unknown as Quaternion,
        scale: [s[0], s[1], s[2]] as unknown as Vec3,
      },
      ...('value' in request.parameter ? { parameter: request.parameter.value } : {}),
      ...('value' in request.reverseFeature
        ? { reverseFeature: request.reverseFeature.value === 'first' ? 1 : 2 }
        : {}),
    });
    const { translationMm, rotation, scale } = plan.transform;
    if (![...translationMm, ...rotation, ...scale].every(Number.isFinite)) return { refused: NOT_FINITE };
    return {
      planned: {
        transform: { translationMm: [...translationMm], rotation: [...rotation], scale: [...scale] },
        noop: plan.noop,
      },
    };
  } catch (error) {
    return refused(error);
  }
}

/** `ExplosionRequest` → `ExplosionReply`: view-only offsets. */
export function explosionWire(request: ProjectExplosionRequestWire): ProjectExplosionReplyWire {
  try {
    const offsets = projectExplosion(
      request.parts.map((part) => ({
        id: wireText(part.id),
        centerMm: [part.centerMm[0], part.centerMm[1], part.centerMm[2]] as unknown as Vec3,
      })),
      request.factor,
    );
    if (!offsets.every((offset) => offset.offsetMm.every(Number.isFinite))) return { refused: NOT_FINITE };
    return { exploded: offsets.map((offset) => ({ id: wireUnits(offset.id), offsetMm: [...offset.offsetMm] })) };
  } catch (error) {
    return refused(error);
  }
}
