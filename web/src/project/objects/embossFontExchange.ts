/**
 * A font the operator picked, over the shared contract: read as the Emboss
 * tool reads it (`readTrueTypeOutlines`), its outlines for a text's
 * characters, and a recipe cut with it — what a host needs to emboss without
 * a font stack of its own. The Rust core answers the same requests
 * (`orcaxr_project::emboss::font`), outline for outline.
 *
 * A font is read from its file's bytes with a collection index (ignored
 * unless the file is a collection). Its outlines are read when a text asks
 * for them, as the browser's reader reads them, so a glyph the font cannot
 * give refuses then, with the reader's reason. The outlines for a text are
 * exactly the `GlyphFont` the cut reads: every character the cut looks up,
 * once, in the order it first does, the ones the font lacks left out; sent
 * through `prepareEmbossWire`, they cut the same mesh.
 */
import type {
  ProjectEmbossFontReplyWire,
  ProjectEmbossFontRequestWire,
  ProjectEmbossGlyphsReplyWire,
  ProjectEmbossGlyphsRequestWire,
  ProjectEmbossReplyWire,
  ProjectEmbossTextRequestWire,
  ProjectGlyphOutlineWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import { EmbossError, type GlyphOutlineSource } from './emboss';
import { EmbossRefusal, PreparedEmboss, embossConfigurationFromWire, prepareEmboss } from './embossExchange';
import { readTrueTypeOutlines, type TrueTypeOutlines } from './truetypeOutlines';

/** `EmbossFontRequest` and the font file's bytes → `EmbossFontReply`, with the font. */
export function readEmbossFontWire(
  request: ProjectEmbossFontRequestWire,
  bytes: Uint8Array,
): { reply: ProjectEmbossFontReplyWire; font?: TrueTypeOutlines } {
  try {
    const font = readTrueTypeOutlines(bytes, request.collection);
    return { reply: { read: { unitsPerEm: font.unitsPerEm, glyphCount: font.glyphCount } }, font };
  } catch (error) {
    if (!(error instanceof EmbossError)) throw error;
    return { reply: { refused: { code: 'unsupportedFont', message: wireUnits(error.message) } } };
  }
}

/**
 * The code points a cut of [text] looks up, each once, in the order it
 * first does (`buildEmbossedMesh`: line by line, character by character).
 */
export function embossCodePoints(text: string): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  for (const line of text.split('\n')) {
    for (const character of line) {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined || seen.has(codePoint)) continue;
      seen.add(codePoint);
      order.push(codePoint);
    }
  }
  return order;
}

/** `EmbossGlyphsRequest` → `EmbossGlyphsReply`: a text's outlines from [font]. */
export function embossGlyphsWire(
  font: GlyphOutlineSource,
  request: ProjectEmbossGlyphsRequestWire,
): ProjectEmbossGlyphsReplyWire {
  const glyphs: ProjectGlyphOutlineWire[] = [];
  try {
    for (const codePoint of embossCodePoints(wireText(request.text))) {
      const outline = font.outline(codePoint);
      if (!outline) continue;
      glyphs.push({
        codePoint,
        advance: outline.advance,
        contours: outline.contours.map((contour) => contour.points.map(([x, y]) => [x, y])),
      });
    }
  } catch (error) {
    if (!(error instanceof EmbossError)) throw error;
    return { refused: { code: 'unsupportedFont', message: wireUnits(error.message) } };
  }
  return { glyphs: { unitsPerEm: font.unitsPerEm, glyphs } };
}

/** `EmbossTextRequest` → `EmbossReply`: the recipe cut with [font], and the prepared cut. */
export function prepareEmbossTextWire(
  font: GlyphOutlineSource,
  request: ProjectEmbossTextRequestWire,
): { reply: ProjectEmbossReplyWire; emboss?: PreparedEmboss } {
  try {
    const emboss = prepareEmboss(embossConfigurationFromWire(request.configuration), font);
    return { reply: { prepared: emboss.summary() }, emboss };
  } catch (error) {
    if (!(error instanceof EmbossRefusal)) throw error;
    return { reply: { refused: { code: error.code, message: wireUnits(error.message) } } };
  }
}
