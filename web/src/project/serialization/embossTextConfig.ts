/**
 * Pinned BBS emboss persistence (P5.3.3).
 *
 * `slic3rpe:text` and `slic3rpe:shape` exactly as `bbs_3mf.cpp` writes and
 * reads them at `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`. Getting this right
 * is what makes a saved project reopen with its text still editable.
 *
 * Two details are easy to get wrong and are pinned by test: vertical
 * `center` serialises as **`middle`**, not `center`; and every optional
 * attribute is *omitted* when absent rather than written as a default, so a
 * value upstream never stored does not reappear as one we invented.
 */

import type {
  EmbossHorizontalAlign,
  EmbossProjection,
  EmbossTextConfiguration,
  EmbossVerticalAlign,
} from '../objects/emboss';
import { DEFAULT_EMBOSS_FONT_PROPERTY } from '../objects/emboss';

export const EMBOSS_TEXT_TAG = 'slic3rpe:text';
export const EMBOSS_SHAPE_TAG = 'slic3rpe:shape';

/** Pinned `TextConfigurationSerialization::type_to_name`. */
export const EMBOSS_FONT_DESCRIPTOR_TYPES = Object.freeze([
  'file_name',
  'wxFontDescriptor_Windows',
  'wxFontDescriptor_Linux',
  'wxFontDescriptor_MacOsX',
  'undefined',
]);

const VERTICAL_TO_NAME: Readonly<Record<EmbossVerticalAlign, string>> = Object.freeze({
  top: 'top',
  center: 'middle',
  bottom: 'bottom',
});

const NAME_TO_VERTICAL: Readonly<Record<string, EmbossVerticalAlign>> = Object.freeze({
  top: 'top',
  middle: 'center',
  bottom: 'bottom',
});

const HORIZONTAL_NAMES = new Set<EmbossHorizontalAlign>(['left', 'center', 'right']);

/** Serialize one volume's text configuration, matching the pinned writer. */
export function encodeEmbossTextConfiguration(configuration: EmbossTextConfiguration): string {
  const font = configuration.font;
  const parts: string[] = [
    `text="${escapeAttribute(configuration.text)}"`,
    `style_name="${escapeAttribute(configuration.styleName)}"`,
    `font_descriptor="${escapeAttribute(configuration.fontDescriptor)}"`,
    `font_descriptor_type="${escapeAttribute(configuration.fontDescriptorType || 'undefined')}"`,
  ];
  // Upstream writes an optional only when the value is present. Zero is a real
  // stored value; absence is what stays absent.
  if (font.charGapMm !== 0) parts.push(`char_gap="${formatNumber(font.charGapMm)}"`);
  if (font.lineGapMm !== 0) parts.push(`line_gap="${formatNumber(font.lineGapMm)}"`);
  parts.push(`line_height="${formatNumber(font.lineHeightMm)}"`);
  if (font.boldnessMm !== 0) parts.push(`boldness="${formatNumber(font.boldnessMm)}"`);
  if (font.skew !== 0) parts.push(`skew="${formatNumber(font.skew)}"`);
  if (font.perGlyph) parts.push('per_glyph="1"');
  parts.push(`horizontal="${font.horizontal}"`, `vertical="${VERTICAL_TO_NAME[font.vertical]}"`);
  if (font.collection !== 0) parts.push(`collection="${font.collection}"`);
  if (configuration.family) parts.push(`family="${escapeAttribute(configuration.family)}"`);
  if (configuration.faceName) parts.push(`face_name="${escapeAttribute(configuration.faceName)}"`);
  if (configuration.style) parts.push(`style="${escapeAttribute(configuration.style)}"`);
  if (configuration.weight) parts.push(`weight="${escapeAttribute(configuration.weight)}"`);
  return `<${EMBOSS_TEXT_TAG} ${parts.join(' ')}/>`;
}

/** Serialize the projection half, which upstream keeps on `slic3rpe:shape`. */
export function encodeEmbossShape(projection: EmbossProjection, scale?: number, unhealed?: boolean): string {
  const parts: string[] = [`depth="${formatNumber(projection.depthMm)}"`];
  if (projection.useSurface) parts.push('use_surface="1"');
  if (scale !== undefined) parts.push(`scale="${formatNumber(scale)}"`);
  if (unhealed) parts.push('unhealed="1"');
  return `<${EMBOSS_SHAPE_TAG} ${parts.join(' ')}/>`;
}

export interface DecodedEmbossVolume {
  readonly configuration: EmbossTextConfiguration;
  readonly warnings: readonly string[];
}

/**
 * Read a `slic3rpe:text` element, optionally paired with `slic3rpe:shape`.
 * A missing required attribute makes the whole element unusable and is
 * reported rather than filled in with a guess.
 */
export function decodeEmbossTextConfiguration(
  textXml: string,
  shapeXml?: string,
): DecodedEmbossVolume | { readonly configuration?: undefined; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const text = attribute(textXml, 'text');
  if (text === undefined) {
    return { warnings: [`${EMBOSS_TEXT_TAG} has no text attribute; the volume is not editable text`] };
  }
  const lineHeight = numberAttribute(textXml, 'line_height');
  if (lineHeight === undefined || lineHeight <= 0) {
    return { warnings: [`${EMBOSS_TEXT_TAG} has no usable line_height; the volume is not editable text`] };
  }

  const horizontalRaw = attribute(textXml, 'horizontal') ?? 'center';
  const horizontal = HORIZONTAL_NAMES.has(horizontalRaw as EmbossHorizontalAlign)
    ? (horizontalRaw as EmbossHorizontalAlign)
    : DEFAULT_EMBOSS_FONT_PROPERTY.horizontal;
  if (horizontal !== horizontalRaw) warnings.push(`Unknown horizontal alignment ${horizontalRaw}; used ${horizontal}`);

  const verticalRaw = attribute(textXml, 'vertical') ?? 'middle';
  const vertical = NAME_TO_VERTICAL[verticalRaw] ?? DEFAULT_EMBOSS_FONT_PROPERTY.vertical;
  if (NAME_TO_VERTICAL[verticalRaw] === undefined) {
    warnings.push(`Unknown vertical alignment ${verticalRaw}; used ${vertical}`);
  }

  const depth = shapeXml ? numberAttribute(shapeXml, 'depth') : undefined;
  const projection: EmbossProjection = Object.freeze({
    depthMm: depth !== undefined && depth > 0 ? depth : 1,
    useSurface: shapeXml ? attribute(shapeXml, 'use_surface') === '1' : false,
  });
  if (shapeXml && (depth === undefined || depth <= 0)) {
    warnings.push(`${EMBOSS_SHAPE_TAG} has no usable depth; used the pinned default of 1 mm`);
  }

  const configuration: EmbossTextConfiguration = Object.freeze({
    text,
    styleName: attribute(textXml, 'style_name') ?? '',
    fontDescriptor: attribute(textXml, 'font_descriptor') ?? '',
    fontDescriptorType: attribute(textXml, 'font_descriptor_type') ?? 'undefined',
    font: Object.freeze({
      charGapMm: numberAttribute(textXml, 'char_gap') ?? 0,
      lineGapMm: numberAttribute(textXml, 'line_gap') ?? 0,
      lineHeightMm: lineHeight,
      boldnessMm: numberAttribute(textXml, 'boldness') ?? 0,
      skew: numberAttribute(textXml, 'skew') ?? 0,
      perGlyph: attribute(textXml, 'per_glyph') === '1',
      horizontal,
      vertical,
      collection: Math.max(0, Math.trunc(numberAttribute(textXml, 'collection') ?? 0)),
    }),
    projection,
    ...optional('family', attribute(textXml, 'family')),
    ...optional('faceName', attribute(textXml, 'face_name')),
    ...optional('style', attribute(textXml, 'style')),
    ...optional('weight', attribute(textXml, 'weight')),
  });
  return { configuration, warnings: Object.freeze(warnings) };
}

function optional<Key extends string>(key: Key, value: string | undefined): Record<Key, string> | Record<never, never> {
  return value === undefined || value === '' ? {} : ({ [key]: value } as Record<Key, string>);
}

function attribute(xml: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(xml);
  return match ? unescapeAttribute(match[1]) : undefined;
}

function numberAttribute(xml: string, name: string): number | undefined {
  const raw = attribute(xml, name);
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Match the pinned writer's shortest round-trippable numeric text. */
function formatNumber(value: number): string {
  return `${Number(value.toFixed(6))}`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\n', '&#10;');
}

function unescapeAttribute(value: string): string {
  return value
    .replaceAll('&#10;', '\n')
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}
