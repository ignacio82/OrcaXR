/**
 * SVG parts over a live session, in the shared contract's encoding: a
 * drawing's bytes and a recipe cut into a mesh (`svgCommands.ts` over
 * `svgShapes.ts`), then staged as a new part of an object or as a re-cut of
 * an existing SVG part.
 *
 * The drawing arrives as the file's bytes and is read as the browser reads a
 * picked file (`File.text()`: UTF-8, a leading byte-order mark dropped and
 * malformed sequences replaced); that text, re-encoded, is what the part
 * stores. A preparation reports the cut's counts and size, the first
 * unsupported features with their total, and the digests of the mesh and of
 * the drawing as stored. Names are given at staging, since the archive path
 * hangs off the volume. The Rust core answers the same requests
 * (`orcaxr_project::svg`).
 */
import type {
  ProjectSvgPartPreviewWire,
  ProjectSvgPartRefusalCodeWire,
  ProjectSvgPartReplyWire,
  ProjectSvgPartRequestWire,
  ProjectSvgPartStageWire,
  ProjectSvgUnsupportedReasonWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import { contentDigest } from '../assets';
import type { AssetId, ObjectId, VolumeId } from '../domain/ids';
import { isStableEntityId } from '../domain/ids';
import {
  StagedInputError,
  captureAddSvgPartCommand,
  captureEditSvgPartCommand,
  singleStagedWork,
  type StagedInputLimits,
  type StagedProjectWork,
} from '../StagedProjectCommands';
import { cutSvgDrawing, packageSvgPart, svgPartName, type SvgCut } from './svgCommands';
import { SvgError, type SvgUnsupportedReason } from './svgShapes';

/** Features a reply lists; `unsupportedCount` counts them all. */
export const MAX_REPLY_FEATURES = 64;
/**
 * UTF-16 units of an element name or detail a reply carries, and of a
 * refusal's message: each can echo arbitrary drawing text.
 */
const MAX_FEATURE_ELEMENT = 64;
const MAX_FEATURE_DETAIL = 512;
const MAX_MESSAGE = 1024;

const REASONS: Readonly<Record<SvgUnsupportedReason, ProjectSvgUnsupportedReasonWire>> = {
  'needs-font': 'needsFont',
  'raster-image': 'rasterImage',
  'external-reference': 'externalReference',
  'paint-effect': 'paintEffect',
  'stroke-only': 'strokeOnly',
  'unsupported-unit': 'unsupportedUnit',
  'unsupported-command': 'unsupportedCommand',
  'empty-shape': 'emptyShape',
  'css-selector': 'cssSelector',
};

const KERNEL_CODES: Readonly<Record<SvgError['code'], ProjectSvgPartRefusalCodeWire>> = {
  'invalid-svg': 'invalidSvg',
  'no-geometry': 'noGeometry',
  'invalid-mesh': 'invalidMesh',
};

/** The recipe a cut was made with, kept for naming it at staging. */
interface SvgPartRecipe {
  readonly fileName: string;
  readonly depthMm: number;
  readonly useSurface: boolean;
  readonly sourcePath?: string;
}

/** One drawing's cut, encoded but not yet named. */
export class PreparedSvgPartCut {
  constructor(
    readonly recipe: SvgPartRecipe,
    readonly cut: SvgCut,
  ) {}

  summary(): ProjectSvgPartPreviewWire {
    const { shapes, mesh, preview, svgBytes } = this.cut;
    return {
      triangleCount: mesh.triangleCount,
      vertexCount: mesh.positions.length / 3,
      openEdgeCount: mesh.openEdgeCount,
      coincidentEdgeCount: mesh.coincidentEdgeCount,
      sizeMm: [shapes.sizeMm[0], shapes.sizeMm[1]],
      unsupported: shapes.unsupported.slice(0, MAX_REPLY_FEATURES).map((feature) => ({
        element: wireUnits(feature.element.slice(0, MAX_FEATURE_ELEMENT)),
        reason: REASONS[feature.reason],
        detail: wireUnits(feature.detail.slice(0, MAX_FEATURE_DETAIL)),
      })),
      unsupportedCount: shapes.unsupported.length,
      digest: wireUnits(preview.descriptor.digest),
      byteLength: preview.descriptor.byteLength,
      drawingDigest: wireUnits(contentDigest(svgBytes)),
      drawingByteLength: svgBytes.byteLength,
    };
  }

  /** A new part of an object, or a re-cut of an existing SVG part. */
  work(stage: ProjectSvgPartStageWire, limits: StagedInputLimits): StagedProjectWork {
    const ids = 'add' in stage ? stage.add : stage.edit;
    const assetId = wireText(ids.assetId) as AssetId;
    const drawingAssetId = wireText(ids.drawingAssetId) as AssetId;
    if (!isStableEntityId(assetId) || !isStableEntityId(drawingAssetId)) throw new StagedInputError('invalid');
    const volumeId = wireText(ids.volumeId) as VolumeId;
    // Each staging owns its own bytes.
    const cut: SvgCut = {
      ...this.cut,
      preview: { descriptor: this.cut.preview.descriptor, bytes: this.cut.preview.bytes.slice() },
      svgBytes: this.cut.svgBytes.slice(),
    };
    const prepared = packageSvgPart(cut, { ...this.recipe, volumeId, assetId, drawingAssetId });
    if ('add' in stage) {
      const { objectId, transform } = stage.add;
      return singleStagedWork(
        captureAddSvgPartCommand(
          {
            objectId: wireText(objectId) as ObjectId,
            volumeId,
            assetId,
            transform: {
              translationMm: [transform.translationMm[0], transform.translationMm[1], transform.translationMm[2]],
              rotation: [transform.rotation[0], transform.rotation[1], transform.rotation[2], transform.rotation[3]],
              scale: [transform.scale[0], transform.scale[1], transform.scale[2]],
            },
          },
          prepared,
          svgPartName(this.recipe.fileName),
          limits,
        ),
      );
    }
    return singleStagedWork(captureEditSvgPartCommand(volumeId, prepared, limits));
  }
}

/** `SvgPartRequest` and the drawing's bytes → `SvgPartReply`, with the cut. */
export function prepareSvgPartWire(
  request: ProjectSvgPartRequestWire,
  drawing: Uint8Array,
): { reply: ProjectSvgPartReplyWire; svg?: PreparedSvgPartCut } {
  const sourcePath = 'value' in request.sourcePath ? wireText(request.sourcePath.value) : '';
  const recipe: SvgPartRecipe = {
    fileName: wireText(request.fileName),
    depthMm: request.depthMm,
    useSurface: request.useSurface,
    // An empty path is no path.
    ...(sourcePath ? { sourcePath } : {}),
  };
  try {
    const cut = cutSvgDrawing(new TextDecoder().decode(drawing), {
      fileName: recipe.fileName,
      depthMm: recipe.depthMm,
      ...('value' in request.widthMm ? { widthMm: request.widthMm.value } : {}),
    });
    const svg = new PreparedSvgPartCut(recipe, cut);
    return { reply: { prepared: svg.summary() }, svg };
  } catch (error) {
    if (!(error instanceof SvgError)) throw error;
    return {
      reply: {
        refused: { code: KERNEL_CODES[error.code], message: wireUnits(error.message.slice(0, MAX_MESSAGE)) },
      },
    };
  }
}
