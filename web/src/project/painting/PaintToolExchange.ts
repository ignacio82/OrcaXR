/**
 * The hosts' contract for the painter's settings (`paintSelectionInputs`): a
 * canonical JSON request names the channel, the pointer hit (volume-local
 * point and camera, the previous point of a drag, and where the part sits on
 * the bed), the paint tool's settings and the palette's displayed filament
 * order, and the reply is the paint stroke sample the workspace's painter
 * selects with, in the shared contract's encoding — or the painter's refusal.
 * The placement makes the sample's transform and the band's bed Z
 * (`placePaintHit`), so the brush measures bed millimetres.
 * The Rust core answers the same requests (`orcaxr_project::facets::paint_tool`).
 *
 * `{"channel","hit","settings","stateOrder"}` → `{"sample":"<PaintStrokeSample wire>"}`
 * or `{"error":"invalid_hit"|"invalid_settings","message"}`. A hit is
 * `{"localCameraPosition","localPoint","triangleIndex"}` with optional
 * `"placement"` (`{"instance","volume"}`, each a canonical transform
 * `{"rotation","scale","translationMm"}`) and `"previousLocalPoint"`; settings are `{"tool"}` with
 * optional `"clippingPlane"` (`{"normal","offset"}`), `"gapAreaMm2"`,
 * `"heightRangeMm"`, `"highlightByAngleDegrees"`, `"radiusMm"`,
 * `"smartFillAngleDegrees"` and `"triangleSplitting"`. A malformed request
 * is refused as `invalid_request`.
 */
import { encodeProjectPaintStrokeSample } from '../../../../contracts/generated/project-intents';
import { regionToolWire } from '../annotations/FacetRegionExchange';
import type { FacetClippingPlane } from '../annotations/FacetRegionSelection';
import { canonicalStringify } from '../domain/canonical';
import type { JsonValue, Transform, Vec3 } from '../domain/model';
import type { PaintPlacement } from './PaintPlacement';
import {
  paintSelectionInputs,
  PaintTargetError,
  type PaintChannel,
  type PaintTargetHit,
  type PaintToolKind,
  type PaintToolSettings,
} from './PaintStrokeService';

/** Why a request could not be read. */
export const INVALID_REQUEST = 'invalid_request';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const CHANNELS: readonly string[] = ['color', 'support', 'seam', 'fuzzySkin'];
const TOOLS: readonly string[] = ['circle', 'sphere', 'triangle', 'heightRange', 'fill', 'gapFill'];

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function object(value: Json | undefined, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) invalid();
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}
function has(fields: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key);
}
function finite(value: Json | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  return value;
}
function vector(value: Json | undefined): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) invalid();
  return [finite(value[0]), finite(value[1]), finite(value[2])];
}
function transform(value: Json | undefined): Transform {
  const fields = object(value, ['rotation', 'scale', 'translationMm']);
  const rotation = fields.rotation;
  if (!Array.isArray(rotation) || rotation.length !== 4) invalid();
  return {
    translationMm: vector(fields.translationMm),
    rotation: [finite(rotation[0]), finite(rotation[1]), finite(rotation[2]), finite(rotation[3])],
    scale: vector(fields.scale),
  };
}
function placement(value: Json | undefined): PaintPlacement {
  const fields = object(value, ['instance', 'volume']);
  return { instance: transform(fields.instance), volume: transform(fields.volume) };
}
function clippingPlane(value: Json | undefined): FacetClippingPlane {
  const fields = object(value, ['normal', 'offset']);
  return { normal: vector(fields.normal), offset: finite(fields.offset) };
}

function hitOf(value: Json | undefined): Omit<PaintTargetHit, 'volumeId'> {
  const fields = object(
    value,
    ['localCameraPosition', 'localPoint', 'triangleIndex'],
    ['placement', 'previousLocalPoint'],
  );
  const triangleIndex = finite(fields.triangleIndex);
  // The wire's facet counter: anything larger is not a facet any mesh holds.
  if (Math.abs(triangleIndex) > Number.MAX_SAFE_INTEGER) invalid();
  return {
    triangleIndex,
    localPoint: vector(fields.localPoint),
    localCameraPosition: vector(fields.localCameraPosition),
    ...(has(fields, 'previousLocalPoint') ? { previousLocalPoint: vector(fields.previousLocalPoint) } : {}),
    ...(has(fields, 'placement') ? { placement: placement(fields.placement) } : {}),
  };
}

function settingsOf(value: Json | undefined): PaintToolSettings {
  const fields = object(
    value,
    ['tool'],
    [
      'clippingPlane',
      'gapAreaMm2',
      'heightRangeMm',
      'highlightByAngleDegrees',
      'radiusMm',
      'smartFillAngleDegrees',
      'triangleSplitting',
    ],
  );
  if (typeof fields.tool !== 'string' || !TOOLS.includes(fields.tool)) invalid();
  const number = (key: string) => (has(fields, key) ? { [key]: finite(fields[key]) } : {});
  if (has(fields, 'triangleSplitting') && typeof fields.triangleSplitting !== 'boolean') invalid();
  return {
    tool: fields.tool as PaintToolKind,
    ...number('radiusMm'),
    ...number('smartFillAngleDegrees'),
    ...number('heightRangeMm'),
    ...number('gapAreaMm2'),
    ...number('highlightByAngleDegrees'),
    ...(has(fields, 'triangleSplitting') ? { triangleSplitting: fields.triangleSplitting as boolean } : {}),
    ...(has(fields, 'clippingPlane') ? { clippingPlane: clippingPlane(fields.clippingPlane) } : {}),
  };
}

/** `{"channel","hit","settings","stateOrder"}` → the sample, or the painter's refusal. */
export function paintToolSampleExchange(request: string): string {
  let parsed: Json;
  try {
    parsed = JSON.parse(request) as Json;
  } catch {
    return invalid();
  }
  const fields = object(parsed, ['channel', 'hit', 'settings', 'stateOrder']);
  if (typeof fields.channel !== 'string' || !CHANNELS.includes(fields.channel)) invalid();
  const channel = fields.channel as PaintChannel;
  if (!Array.isArray(fields.stateOrder)) invalid();
  const stateOrder: JsonValue[] = fields.stateOrder.map((entry) => {
    if (typeof entry !== 'string') invalid();
    return entry;
  });
  const hit = hitOf(fields.hit);
  const settings = settingsOf(fields.settings);
  try {
    const inputs = paintSelectionInputs(settings, hit, channel, () => stateOrder);
    const splits = 'triangleSplitting' in inputs.tool && inputs.tool.triangleSplitting === true;
    const sample = encodeProjectPaintStrokeSample({
      seedTriangle: inputs.seedTriangle,
      tool: regionToolWire(inputs.tool),
      triangleSplitting: splits,
      clippingPlane: inputs.clippingPlane
        ? { value: { normal: [...inputs.clippingPlane.normal], offset: inputs.clippingPlane.offset } }
        : { absent: {} },
      transform: inputs.transform
        ? {
            value: {
              linear: inputs.transform.linear.map((row) => [...row]),
              translation: [...inputs.transform.translation],
              scalingFactors: [...inputs.transform.scalingFactors],
            },
          }
        : { absent: {} },
      highlightByAngleDegrees:
        inputs.highlightByAngleDegrees === undefined ? { absent: {} } : { value: inputs.highlightByAngleDegrees },
    });
    return canonicalStringify({ sample });
  } catch (error) {
    if (!(error instanceof PaintTargetError)) throw error;
    return canonicalStringify({ error: error.code.replaceAll('-', '_'), message: error.message });
  }
}
