/**
 * Text embossing over a live session, in the shared contract's encoding: the
 * workspace's Emboss cut from a recipe and the host's glyph outlines, then
 * staged as a new text part or as a re-cut of an existing one.
 *
 * The browser reads glyphs through a font adapter; a native host reads them
 * with its own font stack. Either way the core receives outlines already
 * flattened to contours in font units, keyed by code point, and lays out,
 * triangulates and extrudes them (`emboss.ts`). A preparation reports the
 * mesh's counts, the code points the font lacked, any open or coincident
 * edges and the encoded result's digest; its bytes are the payload staging
 * installs. The Rust core answers the same requests
 * (`orcaxr_project::emboss`).
 */
import type {
  ProjectEmbossConfigurationWire,
  ProjectEmbossPreviewWire,
  ProjectEmbossRefusalCodeWire,
  ProjectEmbossReplyWire,
  ProjectEmbossRequestWire,
  ProjectEmbossStageWire,
  ProjectGlyphFontWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { AssetPayload } from '../assets';
import type { AssetId, ObjectId, VolumeId } from '../domain/ids';
import { encodeIndexedMeshAsset } from '../meshCodec';
import {
  StagedInputError,
  captureAddEmbossTextCommand,
  captureEditEmbossTextCommand,
  singleStagedWork,
  type StagedInputLimits,
  type StagedProjectWork,
} from '../StagedProjectCommands';
import {
  EmbossError,
  buildEmbossedMesh,
  type EmbossTextConfiguration,
  type EmbossedMesh,
  type GlyphOutline,
  type GlyphOutlineSource,
} from './emboss';
import { isStableEntityId } from '../domain/ids';

/** The asset ID a preview is encoded under until staging names it. */
const PREVIEW_ASSET_ID = 'import:emboss:preview' as AssetId;

export function embossConfigurationFromWire(wire: ProjectEmbossConfigurationWire): EmbossTextConfiguration {
  const optional = (value: { readonly value: readonly number[] } | { readonly absent: object }) =>
    'value' in value ? wireText(value.value) : undefined;
  const family = optional(wire.family);
  const faceName = optional(wire.faceName);
  const style = optional(wire.style);
  const weight = optional(wire.weight);
  return {
    text: wireText(wire.text),
    styleName: wireText(wire.styleName),
    fontDescriptor: wireText(wire.fontDescriptor),
    fontDescriptorType: wireText(wire.fontDescriptorType),
    font: { ...wire.font },
    projection: { ...wire.projection },
    ...(family === undefined ? {} : { family }),
    ...(faceName === undefined ? {} : { faceName }),
    ...(style === undefined ? {} : { style }),
    ...(weight === undefined ? {} : { weight }),
  };
}

/** The host's outlines as a source; a later outline for a code point wins. */
export function glyphSourceFromWire(wire: ProjectGlyphFontWire): GlyphOutlineSource {
  const glyphs = new Map<number, GlyphOutline>();
  for (const glyph of wire.glyphs) {
    glyphs.set(glyph.codePoint, {
      advance: glyph.advance,
      contours: glyph.contours.map((contour) => ({
        points: contour.map(([x, y]) => [x, y] as const),
      })),
    });
  }
  return { unitsPerEm: wire.unitsPerEm, outline: (codePoint) => glyphs.get(codePoint) };
}

/** Why a recipe and font do not emboss. */
export class EmbossRefusal extends Error {
  constructor(
    message: string,
    readonly code: ProjectEmbossRefusalCodeWire,
  ) {
    super(message);
    this.name = 'EmbossRefusal';
  }
}

const KERNEL_CODES: Readonly<Record<EmbossError['code'], ProjectEmbossRefusalCodeWire>> = {
  'invalid-configuration': 'invalidConfiguration',
  'unsupported-font': 'unsupportedFont',
  'no-glyphs': 'noGlyphs',
  'degenerate-outline': 'invalidMesh',
};

/** One recipe's mesh, encoded but not yet named. */
export class PreparedEmboss {
  constructor(
    readonly configuration: EmbossTextConfiguration,
    readonly mesh: EmbossedMesh,
    /** The mesh encoded under a placeholder asset ID. */
    readonly preview: AssetPayload,
  ) {}

  summary(): ProjectEmbossPreviewWire {
    return {
      triangleCount: this.mesh.triangleCount,
      vertexCount: this.mesh.positions.length / 3,
      missingCodePoints: [...this.mesh.missingCodePoints],
      openEdgeCount: this.mesh.openEdgeCount,
      coincidentEdgeCount: this.mesh.coincidentEdgeCount,
      digest: wireUnits(this.preview.descriptor.digest),
      byteLength: this.preview.descriptor.byteLength,
    };
  }

  /** The previewed payload under its own asset ID. */
  asset(assetId: AssetId): AssetPayload {
    return { descriptor: { ...this.preview.descriptor, id: assetId }, bytes: this.preview.bytes.slice() };
  }

  /** A new text part of an object, or a re-cut of an existing text part. */
  work(stage: ProjectEmbossStageWire, limits: StagedInputLimits): StagedProjectWork {
    if ('add' in stage) {
      const { objectId, volumeId, assetId, transform } = stage.add;
      const id = wireText(assetId) as AssetId;
      if (!isStableEntityId(id)) throw new StagedInputError('invalid');
      return singleStagedWork(
        captureAddEmbossTextCommand(
          {
            objectId: wireText(objectId) as ObjectId,
            volumeId: wireText(volumeId) as VolumeId,
            assetId: id,
            transform: {
              translationMm: [transform.translationMm[0], transform.translationMm[1], transform.translationMm[2]],
              rotation: [transform.rotation[0], transform.rotation[1], transform.rotation[2], transform.rotation[3]],
              scale: [transform.scale[0], transform.scale[1], transform.scale[2]],
            },
          },
          this.configuration,
          { asset: this.asset(id), mesh: this.mesh },
          limits,
        ),
      );
    }
    const id = wireText(stage.edit.assetId) as AssetId;
    if (!isStableEntityId(id)) throw new StagedInputError('invalid');
    return singleStagedWork(
      captureEditEmbossTextCommand(
        wireText(stage.edit.volumeId) as VolumeId,
        this.configuration,
        { asset: this.asset(id), mesh: this.mesh },
        limits,
      ),
    );
  }
}

/** Cut a recipe with a font. Throws `EmbossRefusal`. */
export function prepareEmboss(configuration: EmbossTextConfiguration, font: GlyphOutlineSource): PreparedEmboss {
  let mesh: EmbossedMesh;
  try {
    mesh = buildEmbossedMesh(configuration, font);
  } catch (error) {
    if (!(error instanceof EmbossError)) throw error;
    throw new EmbossRefusal(error.message, KERNEL_CODES[error.code]);
  }
  let preview: AssetPayload;
  try {
    preview = encodeIndexedMeshAsset({
      id: PREVIEW_ASSET_ID,
      positions: mesh.positions,
      indices: mesh.indices,
      sourceFilename: `${configuration.text.split('\n')[0].slice(0, 40) || 'text'}.emboss`,
    });
  } catch (error) {
    // A glyph scaled past float32 range.
    throw new EmbossRefusal((error as Error).message, 'invalidMesh');
  }
  return new PreparedEmboss(configuration, mesh, preview);
}

/** `EmbossRequest` → `EmbossReply`, with the prepared cut. */
export function prepareEmbossWire(request: ProjectEmbossRequestWire): {
  reply: ProjectEmbossReplyWire;
  emboss?: PreparedEmboss;
} {
  try {
    const emboss = prepareEmboss(embossConfigurationFromWire(request.configuration), glyphSourceFromWire(request.font));
    return { reply: { prepared: emboss.summary() }, emboss };
  } catch (error) {
    if (!(error instanceof EmbossRefusal)) throw error;
    return { reply: { refused: { code: error.code, message: wireUnits(error.message) } } };
  }
}
