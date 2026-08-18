/**
 * SVG geometry for embossed parts (P5.3.4).
 *
 * Resolves an SVG's shapes to closed contours in millimetres, ready for the
 * shared extruder. Deliberately UI-free and DOM-free: the canonical layer may
 * not reach for `DOMParser`, and a hand-written reader is also the only way to
 * say *exactly* what was dropped.
 *
 * That reporting is the point. An SVG carries plenty this cannot become solid
 * geometry — text that needs a font, raster images, gradients, clip paths,
 * filters, strokes with no fill. Silently ignoring those produces a part that
 * looks nothing like the drawing with no explanation, so every one is returned
 * as a typed note naming the element and why.
 */

import type { Contour } from './polygonTriangulation';

export const PINNED_SVG_SOURCE = Object.freeze({
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  shape: 'src/libslic3r/EmbossShape.hpp',
  persistence: 'src/libslic3r/Format/bbs_3mf.cpp',
});

/** Segments per curve. Fine enough that a 50 mm arc has no visible facets. */
const CURVE_SEGMENTS = 16;

/** CSS absolute units, in millimetres per unit, plus the 96dpi pixel. */
const UNIT_MM: Readonly<Record<string, number>> = Object.freeze({
  px: 25.4 / 96,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  mm: 1,
  cm: 10,
  in: 25.4,
  q: 0.25,
});

export type SvgUnsupportedReason =
  | 'needs-font'
  | 'raster-image'
  | 'external-reference'
  | 'paint-effect'
  | 'stroke-only'
  | 'unsupported-unit'
  | 'unsupported-command'
  | 'empty-shape'
  /** A CSS rule whose selector is more than this parser reads. */
  | 'css-selector';

/** One thing the drawing asked for that a solid part cannot express. */
export interface SvgUnsupportedFeature {
  readonly element: string;
  readonly reason: SvgUnsupportedReason;
  readonly detail: string;
}

export interface SvgShapes {
  /** Closed contours in millimetres, y up, centred on the drawing's origin. */
  readonly contours: readonly Contour[];
  /** Everything the drawing contains that could not become geometry. */
  readonly unsupported: readonly SvgUnsupportedFeature[];
  /** Width and height of the resolved geometry, in millimetres. */
  readonly sizeMm: readonly [number, number];
}

export class SvgError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid-svg' | 'no-geometry',
  ) {
    super(message);
    this.name = 'SvgError';
  }
}

/** 2D affine transform as SVG orders it: [a c e; b d f]. */
type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function applyMatrix(matrix: Matrix, x: number, y: number): readonly [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

/**
 * Read an SVG document into contours.
 *
 * `targetWidthMm` scales the whole drawing to that width, preserving aspect;
 * without it the document's own physical size is used, falling back to the
 * 96dpi pixel convention when it declares none.
 */
export function readSvgShapes(source: string, targetWidthMm?: number): SvgShapes {
  const unsupported: SvgUnsupportedFeature[] = [];
  const root = findRootElement(source);
  if (!root) throw new SvgError('That file has no <svg> element', 'invalid-svg');

  const viewBox = parseViewBox(root.attributes.viewbox);
  const declaredWidth = parseLength(root.attributes.width, unsupported, 'svg');
  const declaredHeight = parseLength(root.attributes.height, unsupported, 'svg');

  // User units become millimetres through the viewBox when there is one, and
  // through the 96dpi pixel convention when there is not.
  const userWidth = viewBox ? viewBox[2] : (declaredWidth ?? 0) / UNIT_MM.px;
  const userHeight = viewBox ? viewBox[3] : (declaredHeight ?? 0) / UNIT_MM.px;
  const widthMm = declaredWidth ?? userWidth * UNIT_MM.px;
  const heightMm = declaredHeight ?? userHeight * UNIT_MM.px;
  const scaleX = userWidth > 0 ? widthMm / userWidth : UNIT_MM.px;
  const scaleY = userHeight > 0 ? heightMm / userHeight : UNIT_MM.px;

  // SVG's y axis points down and a printed part's points up, so the document
  // transform flips it and moves the viewBox origin to 0,0.
  const documentMatrix: Matrix = [
    scaleX,
    0,
    0,
    -scaleY,
    -(viewBox ? viewBox[0] : 0) * scaleX,
    (viewBox ? viewBox[1] + viewBox[3] : userHeight) * scaleY,
  ];

  const contours: (readonly [number, number])[][] = [];
  const stylesheet = readStylesheet(source, unsupported);
  collectElement(source, root, documentMatrix, contours, unsupported, {}, stylesheet);

  if (contours.length === 0) {
    throw new SvgError(
      unsupported.length > 0
        ? `This SVG has nothing that can become a solid part: ${unsupported[0].detail}`
        : 'This SVG has no shapes to emboss',
      'no-geometry',
    );
  }

  let bounds = boundsOf(contours);
  if (targetWidthMm !== undefined) {
    if (!Number.isFinite(targetWidthMm) || targetWidthMm <= 0) {
      throw new SvgError('The requested SVG width must be greater than zero', 'invalid-svg');
    }
    const currentWidth = bounds.maxX - bounds.minX;
    if (currentWidth > 0) {
      const factor = targetWidthMm / currentWidth;
      for (const contour of contours) {
        for (let index = 0; index < contour.length; index += 1) {
          contour[index] = [contour[index][0] * factor, contour[index][1] * factor];
        }
      }
      bounds = boundsOf(contours);
    }
  }

  // Centre on the origin so the part lands where the operator placed it.
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;
  const centred = contours.map((contour) =>
    contour.map(([x, y]): readonly [number, number] => [x - centreX, y - centreY]),
  );

  return Object.freeze({
    contours: Object.freeze(centred),
    unsupported: Object.freeze(unsupported),
    sizeMm: Object.freeze([bounds.maxX - bounds.minX, bounds.maxY - bounds.minY]) as readonly [number, number],
  });
}

interface Element {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly start: number;
  readonly end: number;
  readonly selfClosing: boolean;
}

/** Elements that describe paint rather than a shape this can extrude. */
const UNSUPPORTED_ELEMENTS: Readonly<Record<string, { reason: SvgUnsupportedReason; detail: string }>> = Object.freeze({
  text: { reason: 'needs-font', detail: '<text> needs a font; add it with the text emboss tool instead' },
  tspan: { reason: 'needs-font', detail: '<tspan> needs a font; add it with the text emboss tool instead' },
  textpath: { reason: 'needs-font', detail: '<textPath> needs a font and a layout engine' },
  image: { reason: 'raster-image', detail: '<image> is a raster picture with no outline to cut' },
  use: { reason: 'external-reference', detail: '<use> repeats another element by reference, which is not resolved' },
  clippath: { reason: 'paint-effect', detail: '<clipPath> trims paint, which does not translate to a solid' },
  mask: { reason: 'paint-effect', detail: '<mask> blends paint, which does not translate to a solid' },
  filter: { reason: 'paint-effect', detail: '<filter> is a pixel effect with no geometry' },
  pattern: { reason: 'paint-effect', detail: '<pattern> is a paint server, not an outline' },
  lineargradient: { reason: 'paint-effect', detail: '<linearGradient> is a paint server, not an outline' },
  radialgradient: { reason: 'paint-effect', detail: '<radialGradient> is a paint server, not an outline' },
  marker: { reason: 'paint-effect', detail: '<marker> decorates a stroke, which is not cut' },
});

/**
 * `fill` and `stroke` rules from a document's `<style>` blocks.
 *
 * Not a CSS engine, and it says so: only the selector forms a drawing tool
 * actually emits — a bare element name, `.class`, `#id`, and comma-separated
 * lists of those — are read, and anything else is reported through the same
 * `unsupported` channel as every other thing this parser cannot honour.
 *
 * Ignoring stylesheets altogether was the previous behaviour and it was not
 * neutral: a path whose `fill:none` came from a class extruded as a solid, the
 * same silent wrong-geometry as inherited presentation. Every drawing tool that
 * writes classes rather than attributes hit it.
 */
export interface SvgStylesheet {
  readonly byElement: ReadonlyMap<string, InheritedPresentation>;
  readonly byClass: ReadonlyMap<string, InheritedPresentation>;
  readonly byId: ReadonlyMap<string, InheritedPresentation>;
}

const EMPTY_STYLESHEET: SvgStylesheet = {
  byElement: new Map(),
  byClass: new Map(),
  byId: new Map(),
};

function readStylesheet(source: string, unsupported: SvgUnsupportedFeature[]): SvgStylesheet {
  const byElement = new Map<string, InheritedPresentation>();
  const byClass = new Map<string, InheritedPresentation>();
  const byId = new Map<string, InheritedPresentation>();
  for (const block of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    // Comments first: a rule inside `/* … */` is not a rule, and reading one
    // would apply a setting the document deliberately disabled.
    const css = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = declarationsOf(rule[2]);
      if (declarations.fill === undefined && declarations.stroke === undefined) continue;
      for (const selector of rule[1].split(',').map((entry) => entry.trim())) {
        if (/^[a-zA-Z][\w-]*$/.test(selector)) merge(byElement, selector.toLowerCase(), declarations);
        else if (/^\.[\w-]+$/.test(selector)) merge(byClass, selector.slice(1), declarations);
        else if (/^#[\w-]+$/.test(selector)) merge(byId, selector.slice(1), declarations);
        else if (selector.length > 0) {
          unsupported.push({
            element: 'style',
            reason: 'css-selector',
            detail: `The rule "${selector}" is more than a simple element, class or id selector; its fill and stroke are not applied`,
          });
        }
      }
    }
  }
  return { byElement, byClass, byId };
}

function merge(into: Map<string, InheritedPresentation>, key: string, declarations: InheritedPresentation): void {
  // Later rules win, matching the cascade for equal specificity.
  into.set(key, { ...into.get(key), ...declarations });
}

function declarationsOf(body: string): InheritedPresentation {
  const fill = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim();
  const stroke = /(?:^|;)\s*stroke\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim();
  return { ...(fill === undefined ? {} : { fill }), ...(stroke === undefined ? {} : { stroke }) };
}

/** What the stylesheet says about one element, in specificity order. */
function stylesheetPresentation(
  stylesheet: SvgStylesheet,
  name: string,
  attributes: Readonly<Record<string, string>>,
): InheritedPresentation {
  let resolved: InheritedPresentation = { ...stylesheet.byElement.get(name.toLowerCase()) };
  for (const className of (attributes.class ?? '').split(/\s+/).filter(Boolean)) {
    resolved = { ...resolved, ...stylesheet.byClass.get(className) };
  }
  if (attributes.id) resolved = { ...resolved, ...stylesheet.byId.get(attributes.id) };
  return resolved;
}

/**
 * Presentation a child inherits from its ancestors.
 *
 * `fill` and `stroke` are inherited properties in SVG, and until now only an
 * element's *own* attributes were read. Every drawing tool wraps its output in
 * groups, so `<g fill="none" stroke="#000">` around a path — the ordinary
 * shape of line art from Illustrator, Inkscape or Figma — left the path with
 * no fill of its own and it was extruded as a solid. Silently: the
 * `stroke-only` notice that exists for exactly this never fired.
 */
interface InheritedPresentation {
  readonly fill?: string;
  readonly stroke?: string;
}

/**
 * One element's effective `fill` and `stroke`, in cascade order.
 *
 * The order is SVG's, not the intuitive one. A presentation *attribute*
 * (`fill="none"`) is the weakest of the three — weaker than any stylesheet
 * rule — while an inline `style=""` is the strongest. Getting that backwards
 * would silently pick the wrong paint for any document that sets both, which is
 * every document a drawing tool produces with a theme.
 */
function resolvePresentation(
  inherited: InheritedPresentation,
  attributes: Readonly<Record<string, string>>,
  stylesheet: SvgStylesheet = EMPTY_STYLESHEET,
  name = '',
): InheritedPresentation {
  const attribute: InheritedPresentation = {
    ...(attributes.fill === undefined ? {} : { fill: attributes.fill }),
    ...(attributes.stroke === undefined ? {} : { stroke: attributes.stroke }),
  };
  const inline = declarationsOf(attributes.style ?? '');
  return {
    ...inherited,
    ...attribute,
    ...stylesheetPresentation(stylesheet, name, attributes),
    ...inline,
  };
}

function collectElement(
  source: string,
  element: Element,
  parent: Matrix,
  contours: (readonly [number, number])[][],
  unsupported: SvgUnsupportedFeature[],
  inherited: InheritedPresentation = {},
  stylesheet: SvgStylesheet = EMPTY_STYLESHEET,
): void {
  const matrix = multiply(parent, parseTransform(element.attributes.transform, unsupported, element.name));
  const here = resolvePresentation(inherited, element.attributes, stylesheet, element.name);
  if (element.selfClosing || element.name === 'svg' || element.name === 'g') {
    // Containers only contribute their transform.
  }
  for (const child of childElements(source, element)) {
    const known = UNSUPPORTED_ELEMENTS[child.name];
    if (known) {
      unsupported.push({ element: child.name, reason: known.reason, detail: known.detail });
      continue;
    }
    if (child.name === 'defs') {
      // Definitions are only drawn through <use>, which is reported already.
      continue;
    }
    if (child.name === 'g' || child.name === 'svg' || child.name === 'a' || child.name === 'switch') {
      collectElement(source, child, matrix, contours, unsupported, here, stylesheet);
      continue;
    }
    const childMatrix = multiply(matrix, parseTransform(child.attributes.transform, unsupported, child.name));
    // Checked before emptiness: an open stroked path yields no contour at all,
    // and reporting it as "empty" would hide why it vanished.
    if (isStrokeOnly(resolvePresentation(here, child.attributes, stylesheet, child.name))) {
      unsupported.push({
        element: child.name,
        reason: 'stroke-only',
        detail: `<${child.name}> is stroked with no fill; only filled areas become solid`,
      });
      continue;
    }
    const shape = shapeContours(child, unsupported);
    if (shape.length === 0) continue;
    for (const contour of shape) {
      const mapped = contour.map(([x, y]) => applyMatrix(childMatrix, x, y));
      if (mapped.length >= 3) contours.push(mapped);
    }
  }
}

/**
 * `fill="none"` with a stroke draws a line, which has no area to extrude.
 *
 * Takes resolved presentation rather than raw attributes, so a value set on an
 * ancestor counts. Reading only the element's own attributes made this return
 * false for every grouped line drawing.
 */
function isStrokeOnly(presentation: InheritedPresentation): boolean {
  return (
    presentation.fill?.toLowerCase() === 'none' &&
    presentation.stroke !== undefined &&
    presentation.stroke.toLowerCase() !== 'none'
  );
}

function shapeContours(element: Element, unsupported: SvgUnsupportedFeature[]): (readonly [number, number])[][] {
  const attributes = element.attributes;
  switch (element.name) {
    case 'path':
      return parsePathData(attributes.d ?? '', unsupported);
    case 'rect':
      return rectContours(attributes);
    case 'circle': {
      const radius = number(attributes.r);
      if (radius <= 0) return [];
      return [ellipsePoints(number(attributes.cx), number(attributes.cy), radius, radius)];
    }
    case 'ellipse': {
      const rx = number(attributes.rx);
      const ry = number(attributes.ry);
      if (rx <= 0 || ry <= 0) return [];
      return [ellipsePoints(number(attributes.cx), number(attributes.cy), rx, ry)];
    }
    case 'polygon':
    case 'polyline': {
      const points = numberList(attributes.points ?? '');
      const contour: (readonly [number, number])[] = [];
      for (let index = 0; index + 1 < points.length; index += 2) contour.push([points[index], points[index + 1]]);
      return contour.length >= 3 ? [contour] : [];
    }
    case 'line':
      unsupported.push({
        element: 'line',
        reason: 'stroke-only',
        detail: '<line> has no area; only filled shapes become solid',
      });
      return [];
    default:
      return [];
  }
}

function rectContours(attributes: Readonly<Record<string, string>>): (readonly [number, number])[][] {
  const x = number(attributes.x);
  const y = number(attributes.y);
  const width = number(attributes.width);
  const height = number(attributes.height);
  if (width <= 0 || height <= 0) return [];
  const rx = Math.min(number(attributes.rx || attributes.ry), width / 2);
  const ry = Math.min(number(attributes.ry || attributes.rx), height / 2);
  if (rx <= 0 || ry <= 0) {
    return [
      [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
      ],
    ];
  }
  // Rounded corners, walked clockwise in SVG's own coordinate sense.
  const points: (readonly [number, number])[] = [];
  const corner = (cx: number, cy: number, from: number, to: number) => {
    for (let step = 0; step <= CURVE_SEGMENTS; step += 1) {
      const angle = from + ((to - from) * step) / CURVE_SEGMENTS;
      points.push([cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry]);
    }
  };
  corner(x + width - rx, y + ry, -Math.PI / 2, 0);
  corner(x + width - rx, y + height - ry, 0, Math.PI / 2);
  corner(x + rx, y + height - ry, Math.PI / 2, Math.PI);
  corner(x + rx, y + ry, Math.PI, (3 * Math.PI) / 2);
  return [points];
}

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): (readonly [number, number])[] {
  const steps = CURVE_SEGMENTS * 4;
  const points: (readonly [number, number])[] = [];
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    points.push([cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry]);
  }
  return points;
}

/** Parse a `d` attribute into closed contours, flattening every curve. */
function parsePathData(data: string, unsupported: SvgUnsupportedFeature[]): (readonly [number, number])[][] {
  const contours: (readonly [number, number])[][] = [];
  let current: (readonly [number, number])[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastControl: readonly [number, number] | undefined;
  let lastCommand = '';

  const finish = () => {
    if (current.length >= 3) contours.push(current);
    current = [];
  };

  for (const { command, values } of tokenizePath(data, unsupported)) {
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    // A repeated coordinate set after a move is an implicit line.
    const stride = COMMAND_STRIDE[upper];
    if (stride === undefined) {
      unsupported.push({
        element: 'path',
        reason: 'unsupported-command',
        detail: `Path command "${command}" is not one this reader understands`,
      });
      continue;
    }
    const groups = stride === 0 ? [[]] : chunk(values, stride);
    for (const [groupIndex, group] of groups.entries()) {
      switch (upper) {
        case 'M': {
          const [px, py] = [group[0], group[1]];
          x = relative ? x + px : px;
          y = relative ? y + py : py;
          // Only the first pair moves; the rest are implicit line-tos.
          if (groupIndex === 0) {
            finish();
            startX = x;
            startY = y;
            current = [[x, y]];
          } else {
            current.push([x, y]);
          }
          break;
        }
        case 'L': {
          x = relative ? x + group[0] : group[0];
          y = relative ? y + group[1] : group[1];
          current.push([x, y]);
          break;
        }
        case 'H': {
          x = relative ? x + group[0] : group[0];
          current.push([x, y]);
          break;
        }
        case 'V': {
          y = relative ? y + group[0] : group[0];
          current.push([x, y]);
          break;
        }
        case 'C': {
          const c1: readonly [number, number] = [
            relative ? x + group[0] : group[0],
            relative ? y + group[1] : group[1],
          ];
          const c2: readonly [number, number] = [
            relative ? x + group[2] : group[2],
            relative ? y + group[3] : group[3],
          ];
          const to: readonly [number, number] = [
            relative ? x + group[4] : group[4],
            relative ? y + group[5] : group[5],
          ];
          appendCubic(current, [x, y], c1, c2, to);
          lastControl = c2;
          [x, y] = to;
          break;
        }
        case 'S': {
          const reflected = reflect([x, y], lastControl, lastCommand, 'CS');
          const c2: readonly [number, number] = [
            relative ? x + group[0] : group[0],
            relative ? y + group[1] : group[1],
          ];
          const to: readonly [number, number] = [
            relative ? x + group[2] : group[2],
            relative ? y + group[3] : group[3],
          ];
          appendCubic(current, [x, y], reflected, c2, to);
          lastControl = c2;
          [x, y] = to;
          break;
        }
        case 'Q': {
          const control: readonly [number, number] = [
            relative ? x + group[0] : group[0],
            relative ? y + group[1] : group[1],
          ];
          const to: readonly [number, number] = [
            relative ? x + group[2] : group[2],
            relative ? y + group[3] : group[3],
          ];
          appendQuadratic(current, [x, y], control, to);
          lastControl = control;
          [x, y] = to;
          break;
        }
        case 'T': {
          const control = reflect([x, y], lastControl, lastCommand, 'QT');
          const to: readonly [number, number] = [
            relative ? x + group[0] : group[0],
            relative ? y + group[1] : group[1],
          ];
          appendQuadratic(current, [x, y], control, to);
          lastControl = control;
          [x, y] = to;
          break;
        }
        case 'A': {
          const to: readonly [number, number] = [
            relative ? x + group[5] : group[5],
            relative ? y + group[6] : group[6],
          ];
          appendArc(current, [x, y], group[0], group[1], group[2], group[3] !== 0, group[4] !== 0, to);
          [x, y] = to;
          break;
        }
        case 'Z': {
          if (current.length >= 3) contours.push(current);
          current = [];
          x = startX;
          y = startY;
          break;
        }
      }
      if (upper !== 'C' && upper !== 'S' && upper !== 'Q' && upper !== 'T') lastControl = undefined;
      lastCommand = upper;
    }
  }
  finish();
  return contours;
}

const COMMAND_STRIDE: Readonly<Record<string, number>> = Object.freeze({
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
});

function reflect(
  point: readonly [number, number],
  control: readonly [number, number] | undefined,
  lastCommand: string,
  family: string,
): readonly [number, number] {
  // A smooth command reflects the previous control point only when the
  // previous command was of the matching family; otherwise it starts flat.
  if (!control || !family.includes(lastCommand)) return point;
  return [2 * point[0] - control[0], 2 * point[1] - control[1]];
}

function appendCubic(
  out: (readonly [number, number])[],
  from: readonly [number, number],
  c1: readonly [number, number],
  c2: readonly [number, number],
  to: readonly [number, number],
): void {
  for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
    const t = step / CURVE_SEGMENTS;
    const u = 1 - t;
    out.push([
      u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * to[0],
      u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * to[1],
    ]);
  }
}

function appendQuadratic(
  out: (readonly [number, number])[],
  from: readonly [number, number],
  control: readonly [number, number],
  to: readonly [number, number],
): void {
  for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
    const t = step / CURVE_SEGMENTS;
    const u = 1 - t;
    out.push([
      u * u * from[0] + 2 * u * t * control[0] + t * t * to[0],
      u * u * from[1] + 2 * u * t * control[1] + t * t * to[1],
    ]);
  }
}

/** Endpoint-parameterized elliptical arc, per the SVG implementation notes. */
function appendArc(
  out: (readonly [number, number])[],
  from: readonly [number, number],
  rxInput: number,
  ryInput: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  to: readonly [number, number],
): void {
  let rx = Math.abs(rxInput);
  let ry = Math.abs(ryInput);
  if (rx === 0 || ry === 0 || (from[0] === to[0] && from[1] === to[1])) {
    out.push(to);
    return;
  }
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1 = cosPhi * dx + sinPhi * dy;
  const y1 = -sinPhi * dx + cosPhi * dy;

  // Grow radii that cannot span the endpoints, exactly as the spec directs.
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    const factor = Math.sqrt(lambda);
    rx *= factor;
    ry *= factor;
  }

  const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const ratio = Math.sqrt(Math.max(0, numerator / denominator)) * (largeArc === sweep ? -1 : 1);
  const cx1 = (ratio * rx * y1) / ry;
  const cy1 = (-ratio * ry * x1) / rx;
  const cx = cosPhi * cx1 - sinPhi * cy1 + (from[0] + to[0]) / 2;
  const cy = sinPhi * cx1 + cosPhi * cy1 + (from[1] + to[1]) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const length = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const value = Math.acos(Math.min(1, Math.max(-1, dot / (length || 1))));
    return ux * vy - uy * vx < 0 ? -value : value;
  };
  const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let sweepAngle = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && sweepAngle > 0) sweepAngle -= Math.PI * 2;
  if (sweep && sweepAngle < 0) sweepAngle += Math.PI * 2;

  const steps = Math.max(2, Math.ceil((Math.abs(sweepAngle) / (Math.PI / 2)) * CURVE_SEGMENTS));
  for (let step = 1; step <= steps; step += 1) {
    const theta = start + (sweepAngle * step) / steps;
    const px = Math.cos(theta) * rx;
    const py = Math.sin(theta) * ry;
    out.push([cosPhi * px - sinPhi * py + cx, sinPhi * px + cosPhi * py + cy]);
  }
}

function tokenizePath(data: string, unsupported: SvgUnsupportedFeature[]): { command: string; values: number[] }[] {
  const tokens: { command: string; values: number[] }[] = [];
  const pattern = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let match: RegExpExecArray | null;
  let matchedAny = false;
  while ((match = pattern.exec(data)) !== null) {
    matchedAny = true;
    tokens.push({ command: match[1], values: numberList(match[2]) });
  }
  if (!matchedAny && data.trim().length > 0) {
    unsupported.push({
      element: 'path',
      reason: 'unsupported-command',
      detail: 'A path had data this reader could not read as commands',
    });
  }
  return tokens;
}

function chunk(values: readonly number[], size: number): number[][] {
  const groups: number[][] = [];
  for (let index = 0; index + size <= values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  // A trailing partial group is malformed; dropping it beats inventing zeros.
  return groups.length > 0 ? groups : [];
}

function parseTransform(value: string | undefined, unsupported: SvgUnsupportedFeature[], element: string): Matrix {
  if (!value) return IDENTITY;
  let matrix: Matrix = IDENTITY;
  const pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const name = match[1].toLowerCase();
    const args = numberList(match[2]);
    switch (name) {
      case 'matrix':
        if (args.length === 6) matrix = multiply(matrix, args as unknown as Matrix);
        break;
      case 'translate':
        matrix = multiply(matrix, [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]);
        break;
      case 'scale': {
        const sx = args[0] ?? 1;
        matrix = multiply(matrix, [sx, 0, 0, args[1] ?? sx, 0, 0]);
        break;
      }
      case 'rotate': {
        const radians = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const cx = args[1] ?? 0;
        const cy = args[2] ?? 0;
        matrix = multiply(matrix, [1, 0, 0, 1, cx, cy]);
        matrix = multiply(matrix, [cos, sin, -sin, cos, 0, 0]);
        matrix = multiply(matrix, [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'skewx':
        matrix = multiply(matrix, [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0]);
        break;
      case 'skewy':
        matrix = multiply(matrix, [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]);
        break;
      default:
        unsupported.push({
          element,
          reason: 'unsupported-command',
          detail: `Transform "${name}" is not one this reader understands`,
        });
    }
  }
  return matrix;
}

function parseViewBox(value: string | undefined): readonly [number, number, number, number] | undefined {
  if (!value) return undefined;
  const parts = numberList(value);
  if (parts.length !== 4 || parts[2] <= 0 || parts[3] <= 0) return undefined;
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** A length with an absolute unit, in millimetres. Percentages have no size. */
function parseLength(
  value: string | undefined,
  unsupported: SvgUnsupportedFeature[],
  element: string,
): number | undefined {
  if (!value) return undefined;
  const match = /^\s*([+-]?[\d.]+(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value);
  if (!match) return undefined;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude)) return undefined;
  const unit = match[2].toLowerCase();
  if (unit === '') return magnitude * UNIT_MM.px;
  const factor = UNIT_MM[unit];
  if (factor === undefined) {
    unsupported.push({
      element,
      reason: 'unsupported-unit',
      detail:
        unit === '%'
          ? 'A size in % depends on the page it is drawn into, so the viewBox was used instead'
          : `Unit "${unit}" has no fixed physical size, so the viewBox was used instead`,
    });
    return undefined;
  }
  return magnitude * factor;
}

function numberList(value: string): number[] {
  const found = value.match(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g);
  return found ? found.map(Number).filter((entry) => Number.isFinite(entry)) : [];
}

function number(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundsOf(contours: readonly (readonly (readonly [number, number])[])[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of contours) {
    for (const [x, y] of contour) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------------
// A small, strict XML reader. The canonical layer has no DOM, and a real
// parser here would also hide exactly the things this module must report.
// ---------------------------------------------------------------------------

function findRootElement(source: string): Element | undefined {
  const pattern = /<svg\b/i.exec(source);
  if (!pattern) return undefined;
  return readElementAt(source, pattern.index);
}

function readElementAt(source: string, at: number): Element | undefined {
  const close = source.indexOf('>', at);
  if (close === -1) return undefined;
  const raw = source.slice(at + 1, close);
  const selfClosing = raw.trimEnd().endsWith('/');
  const nameMatch = /^[^\s/>]+/.exec(raw);
  if (!nameMatch) return undefined;
  const name = nameMatch[0].toLowerCase().replace(/^.*:/, '');
  return {
    name,
    attributes: parseAttributes(raw.slice(nameMatch[0].length)),
    start: at,
    end: close,
    selfClosing,
  };
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/]+)\s*=\s*"([^"]*)"|([^\s=/]+)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = (match[1] ?? match[3]).toLowerCase();
    attributes[name] = unescapeXml(match[2] ?? match[4]);
  }
  return attributes;
}

/** Direct element children of `parent`, in document order. */
function childElements(source: string, parent: Element): Element[] {
  if (parent.selfClosing) return [];
  const children: Element[] = [];
  let depth = 0;
  let cursor = parent.end + 1;
  while (cursor < source.length) {
    const next = source.indexOf('<', cursor);
    if (next === -1) break;
    if (source.startsWith('<!--', next)) {
      const commentEnd = source.indexOf('-->', next);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', next)) {
      const cdataEnd = source.indexOf(']]>', next);
      cursor = cdataEnd === -1 ? source.length : cdataEnd + 3;
      continue;
    }
    if (source.startsWith('</', next)) {
      if (depth === 0) break;
      depth -= 1;
      cursor = source.indexOf('>', next) + 1 || source.length;
      continue;
    }
    if (source.startsWith('<?', next) || source.startsWith('<!', next)) {
      cursor = source.indexOf('>', next) + 1 || source.length;
      continue;
    }
    const element = readElementAt(source, next);
    if (!element) break;
    if (depth === 0) children.push(element);
    if (!element.selfClosing) depth += 1;
    cursor = element.end + 1;
  }
  return children;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
