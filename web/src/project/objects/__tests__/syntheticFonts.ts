/**
 * Synthetic TrueType fonts, built here from glyph descriptions so the outline
 * reader (`truetypeOutlines.ts`) and the shared core's port of it are tested
 * against exact bytes without copying any third-party font into the
 * repository: the reader's tests and the cross-platform corpus
 * (tools/cross-platform/emboss-font-vectors.mjs) both use it.
 *
 * Everything the reader distinguishes can be written: on- and off-curve
 * points with every coordinate encoding (same, short positive and negative,
 * 16-bit) and repeated flags, skipped instructions, composite glyphs with
 * byte or word offsets, point-matched arguments and every scale form, empty
 * glyphs, short and long `loca`, `hmtx` with fewer metrics than glyphs, cmap
 * formats 4 (deltas and glyph arrays) and 12 under any encoding records, and
 * collections. Malformed fonts are written the same way: raw glyph bytes,
 * overridden counts and offsets, missing or extra tables.
 */

/** One outline point in font units. */
export interface SyntheticPoint {
  readonly x: number;
  readonly y: number;
  readonly on: boolean;
}

export interface SimpleGlyph {
  readonly contours: readonly (readonly SyntheticPoint[])[];
  /** Instruction bytes the reader skips. */
  readonly instructions?: number;
  /** Compress runs of equal flags with the repeat flag (default true). */
  readonly repeat?: boolean;
  /** Write every coordinate as a 16-bit delta, even where a byte would do. */
  readonly longCoordinates?: boolean;
  /** Contour end points as written, in place of the ones the contours imply. */
  readonly endPoints?: readonly number[];
}

export interface SyntheticComponent {
  readonly glyph: number;
  readonly dx?: number;
  readonly dy?: number;
  /** Offsets as 16-bit words (ARG_1_AND_2_ARE_WORDS) rather than bytes. */
  readonly words?: boolean;
  /** Offsets are x/y values (ARGS_ARE_XY_VALUES, default true), not point numbers. */
  readonly xyValues?: boolean;
  readonly scale?: number;
  readonly xyScale?: readonly [number, number];
  readonly twoByTwo?: readonly [number, number, number, number];
}

export type SyntheticGlyph =
  | { readonly simple: SimpleGlyph }
  | { readonly composite: readonly SyntheticComponent[] }
  | { readonly empty: true }
  /** A glyph's bytes exactly as written, from its contour count on. */
  | { readonly raw: readonly number[] };

export interface Format4Segment {
  readonly start: number;
  readonly end: number;
  readonly delta?: number;
  /** Glyph IDs for start..end through the glyph ID array. */
  readonly glyphs?: readonly number[];
  /** The idRangeOffset as written, in place of the computed one. */
  readonly rangeOffset?: number;
}

export type CmapSubtable =
  | {
      readonly format: 4;
      readonly segments: readonly Format4Segment[];
      /** segCountX2 as written, in place of twice the segment count. */
      readonly segCountX2?: number;
    }
  | { readonly format: 12; readonly groups: readonly { start: number; end: number; glyph: number }[] }
  /** A subtable's bytes exactly as written, from its format on. */
  | { readonly format: 'raw'; readonly bytes: readonly number[] };

export interface SyntheticFont {
  /** The sfnt version's four bytes; 0x00010000 by default. */
  readonly version?: readonly [number, number, number, number];
  readonly unitsPerEm?: number;
  readonly glyphs: readonly SyntheticGlyph[];
  /** maxp's glyph count as written, in place of the glyphs' count. */
  readonly numGlyphs?: number;
  /** Advances of the first glyphs: hmtx's long metrics (hhea's numberOfHMetrics). */
  readonly advances: readonly number[];
  readonly subtables: readonly CmapSubtable[];
  /** Encoding records, each naming a subtable by index; one (3,1) or (3,10) record by default. */
  readonly records?: readonly { platform: number; encoding: number; subtable: number }[];
  readonly longLoca?: boolean;
  /** head's indexToLocFormat as written; any value but 0 reads `loca` as long offsets. */
  readonly locFormat?: number;
  /** hhea's numberOfHMetrics as written, in place of the advances' count. */
  readonly hMetrics?: number;
  /** Tables left out. */
  readonly omit?: readonly string[];
  /** Further tables, by four-character tag. */
  readonly extra?: Readonly<Record<string, readonly number[]>>;
}

class Bytes {
  readonly out: number[] = [];
  get length(): number {
    return this.out.length;
  }
  u8(value: number): this {
    this.out.push(value & 0xff);
    return this;
  }
  u16(value: number): this {
    return this.u8(value >>> 8).u8(value);
  }
  i16(value: number): this {
    return this.u16(value & 0xffff);
  }
  u32(value: number): this {
    return this.u16((value >>> 16) & 0xffff).u16(value & 0xffff);
  }
  tag(tag: string): this {
    for (let index = 0; index < 4; index += 1) this.u8(tag.charCodeAt(index));
    return this;
  }
  bytes(values: readonly number[]): this {
    for (const value of values) this.u8(value);
    return this;
  }
  align(to: number): this {
    while (this.out.length % to !== 0) this.u8(0);
    return this;
  }
}

const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;

function f2dot14(value: number): number {
  return Math.round(value * 16384);
}

function simpleGlyph(glyph: SimpleGlyph): number[] {
  const points = glyph.contours.flat();
  const out = new Bytes();
  let end = -1;
  const endPoints =
    glyph.endPoints ??
    glyph.contours.map((contour) => {
      end += contour.length;
      return end;
    });
  out.i16(endPoints.length);
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  out
    .i16(Math.min(0, ...xs))
    .i16(Math.min(0, ...ys))
    .i16(Math.max(0, ...xs))
    .i16(Math.max(0, ...ys));
  for (const point of endPoints) out.u16(point);
  const instructions = glyph.instructions ?? 0;
  out.u16(instructions);
  for (let index = 0; index < instructions; index += 1) out.u8(0xb0 + (index % 8));

  const flags: number[] = [];
  const xBytes = new Bytes();
  const yBytes = new Bytes();
  let x = 0;
  let y = 0;
  const encode = (delta: number, short: number, same: number, bytes: Bytes): number => {
    if (glyph.longCoordinates) {
      bytes.i16(delta);
      return 0;
    }
    if (delta === 0) return same;
    if (Math.abs(delta) < 256) {
      bytes.u8(Math.abs(delta));
      return short | (delta > 0 ? same : 0);
    }
    bytes.i16(delta);
    return 0;
  };
  for (const point of points) {
    const flag =
      (point.on ? ON_CURVE : 0) |
      encode(point.x - x, X_SHORT, X_SAME_OR_POSITIVE, xBytes) |
      encode(point.y - y, Y_SHORT, Y_SAME_OR_POSITIVE, yBytes);
    flags.push(flag);
    x = point.x;
    y = point.y;
  }
  for (let index = 0; index < flags.length;) {
    let run = 1;
    while (glyph.repeat !== false && index + run < flags.length && flags[index + run] === flags[index] && run < 256) {
      run += 1;
    }
    if (run > 1) out.u8(flags[index] | REPEAT).u8(run - 1);
    else out.u8(flags[index]);
    index += run;
  }
  return [...out.out, ...xBytes.out, ...yBytes.out];
}

function compositeGlyph(components: readonly SyntheticComponent[]): number[] {
  const out = new Bytes().i16(-1).i16(0).i16(0).i16(0).i16(0);
  components.forEach((component, index) => {
    let flags = component.xyValues === false ? 0 : 0x0002;
    if (component.words) flags |= 0x0001;
    if (component.scale !== undefined) flags |= 0x0008;
    else if (component.xyScale) flags |= 0x0040;
    else if (component.twoByTwo) flags |= 0x0080;
    if (index < components.length - 1) flags |= 0x0020;
    out.u16(flags).u16(component.glyph);
    const dx = component.dx ?? 0;
    const dy = component.dy ?? 0;
    if (component.words) out.i16(dx).i16(dy);
    else out.u8(dx).u8(dy);
    if (component.scale !== undefined) out.i16(f2dot14(component.scale));
    else if (component.xyScale) out.i16(f2dot14(component.xyScale[0])).i16(f2dot14(component.xyScale[1]));
    else if (component.twoByTwo) for (const value of component.twoByTwo) out.i16(f2dot14(value));
  });
  return out.out;
}

function glyphBytes(glyph: SyntheticGlyph): number[] {
  if ('simple' in glyph) return simpleGlyph(glyph.simple);
  if ('composite' in glyph) return compositeGlyph(glyph.composite);
  if ('raw' in glyph) return [...glyph.raw];
  return [];
}

function subtableBytes(subtable: CmapSubtable): number[] {
  if (subtable.format === 'raw') return [...subtable.bytes];
  if (subtable.format === 12) {
    const out = new Bytes()
      .u16(12)
      .u16(0)
      .u32(16 + subtable.groups.length * 12)
      .u32(0)
      .u32(subtable.groups.length);
    for (const group of subtable.groups) out.u32(group.start).u32(group.end).u32(group.glyph);
    return out.out;
  }
  const segments = subtable.segments;
  const count = segments.length;
  const glyphArray: number[] = [];
  const offsets = segments.map((segment, index) => {
    if (segment.rangeOffset !== undefined) return segment.rangeOffset;
    if (!segment.glyphs) return 0;
    const offset = (count - index) * 2 + glyphArray.length * 2;
    glyphArray.push(...segment.glyphs);
    return offset;
  });
  const out = new Bytes()
    .u16(4)
    .u16(Math.min(0xffff, 16 + count * 8 + glyphArray.length * 2))
    .u16(0);
  const searchRange = 2 * 2 ** Math.floor(Math.log2(Math.max(1, count)));
  out
    .u16(subtable.segCountX2 ?? count * 2)
    .u16(searchRange)
    .u16(Math.log2(searchRange / 2))
    .u16(count * 2 - searchRange);
  for (const segment of segments) out.u16(segment.end);
  out.u16(0);
  for (const segment of segments) out.u16(segment.start);
  for (const segment of segments) out.i16(segment.delta ?? 0);
  for (const offset of offsets) out.u16(offset);
  for (const glyph of glyphArray) out.u16(glyph);
  return out.out;
}

function cmapTable(font: SyntheticFont): number[] {
  const records =
    font.records ??
    font.subtables.map((subtable, index) => ({
      platform: 3,
      encoding: subtable.format === 12 ? 10 : 1,
      subtable: index,
    }));
  const bodies = font.subtables.map(subtableBytes);
  const head = 4 + records.length * 8;
  const at: number[] = [];
  let offset = head;
  for (const body of bodies) {
    at.push(offset);
    offset += body.length + ((4 - (body.length % 4)) % 4);
  }
  const out = new Bytes().u16(0).u16(records.length);
  for (const record of records) out.u16(record.platform).u16(record.encoding).u32(at[record.subtable]);
  for (const body of bodies) out.bytes(body).align(4);
  return out.out;
}

/** One font's tables, by tag, in the order they are written. */
function tables(font: SyntheticFont): [string, number[]][] {
  const glyf = new Bytes();
  const loca: number[] = [];
  for (const glyph of font.glyphs) {
    loca.push(glyf.length);
    glyf.bytes(glyphBytes(glyph)).align(2);
  }
  loca.push(glyf.length);
  const numGlyphs = font.numGlyphs ?? font.glyphs.length;
  const locFormat = font.locFormat ?? (font.longLoca ? 1 : 0);
  const longLoca = locFormat !== 0;
  const locaBytes = new Bytes();
  for (const offset of loca) {
    if (longLoca) locaBytes.u32(offset);
    else locaBytes.u16(offset / 2);
  }
  const head = new Bytes()
    .u32(0x00010000)
    .u32(0x00010000)
    .u32(0)
    .u32(0x5f0f3cf5)
    .u16(0)
    .u16(font.unitsPerEm ?? 1000)
    .bytes(new Array(16).fill(0))
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .u16(0)
    .u16(8)
    .i16(2)
    .i16(locFormat)
    .i16(0);
  const hhea = new Bytes()
    .u32(0x00010000)
    .bytes(new Array(30).fill(0))
    .u16(font.hMetrics ?? font.advances.length);
  const hmtx = new Bytes();
  for (const advance of font.advances) hmtx.u16(advance).i16(0);
  for (let index = font.advances.length; index < numGlyphs; index += 1) hmtx.i16(0);
  const maxp = new Bytes().u32(0x00005000).u16(numGlyphs);
  const all: [string, number[]][] = [
    ['cmap', cmapTable(font)],
    ['glyf', glyf.out],
    ['head', head.out],
    ['hhea', hhea.out],
    ['hmtx', hmtx.out],
    ['loca', locaBytes.out],
    ['maxp', maxp.out],
    ...Object.entries(font.extra ?? {}).map(([tag, bytes]): [string, number[]] => [tag, [...bytes]]),
  ];
  return all.filter(([tag]) => !(font.omit ?? []).includes(tag));
}

function checksum(bytes: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 4) {
    const word =
      ((bytes[index] ?? 0) << 24) |
      ((bytes[index + 1] ?? 0) << 16) |
      ((bytes[index + 2] ?? 0) << 8) |
      (bytes[index + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/** Fonts laid out with each one's directory first, then every table, offsets from the file's start. */
function assemble(fonts: readonly SyntheticFont[], collection: boolean): Uint8Array {
  const built = fonts.map((font) => ({ font, tables: tables(font) }));
  const header = collection ? 12 + fonts.length * 4 : 0;
  const directories: number[] = [];
  let offset = header;
  for (const { tables: list } of built) {
    directories.push(offset);
    offset += 12 + list.length * 16;
  }
  const placed = built.map(({ tables: list }) =>
    list.map(([tag, bytes]) => {
      const at = offset;
      offset += bytes.length + ((4 - (bytes.length % 4)) % 4);
      return { tag, bytes, at };
    }),
  );
  const out = new Bytes();
  if (collection) {
    out.tag('ttcf').u32(0x00010000).u32(fonts.length);
    for (const at of directories) out.u32(at);
  }
  built.forEach(({ font }, index) => {
    const list = placed[index];
    out.bytes(font.version ?? [0, 1, 0, 0]).u16(list.length);
    const searchRange = 16 * 2 ** Math.floor(Math.log2(Math.max(1, list.length)));
    out
      .u16(searchRange)
      .u16(Math.log2(searchRange / 16))
      .u16(list.length * 16 - searchRange);
    for (const { tag, bytes, at } of list) out.tag(tag).u32(checksum(bytes)).u32(at).u32(bytes.length);
  });
  for (const list of placed) for (const { bytes } of list) out.bytes(bytes).align(4);
  return Uint8Array.from(out.out);
}

/** One TrueType font's bytes. */
export function trueTypeFont(font: SyntheticFont): Uint8Array {
  return assemble([font], false);
}

/** A TrueType collection (`ttcf`) of [fonts], in order. */
export function trueTypeCollection(fonts: readonly SyntheticFont[]): Uint8Array {
  return assemble(fonts, true);
}

/** A closed contour of on-curve points. */
export function polygon(points: readonly (readonly [number, number])[]): SyntheticPoint[] {
  return points.map(([x, y]) => ({ x, y, on: true }));
}

/** An axis-aligned rectangle, counter-clockwise unless [clockwise]. */
export function box(x0: number, y0: number, x1: number, y1: number, clockwise = false): SyntheticPoint[] {
  const points = polygon([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
  return clockwise ? points.reverse() : points;
}

const on = (x: number, y: number): SyntheticPoint => ({ x, y, on: true });
const off = (x: number, y: number): SyntheticPoint => ({ x, y, on: false });
const simple = (contours: readonly (readonly SyntheticPoint[])[], extra: Omit<SimpleGlyph, 'contours'> = {}) => ({
  simple: { contours, ...extra },
});
function ring(cx: number, cy: number, r: number, n: number, onCurve: (index: number) => boolean, clockwise = false) {
  const points = Array.from({ length: n }, (_, index) => {
    const angle = (2 * Math.PI * index) / n;
    return { x: Math.round(cx + r * Math.cos(angle)), y: Math.round(cy + r * Math.sin(angle)), on: onCurve(index) };
  });
  return clockwise ? points.reverse() : points;
}

/** Glyphs the sample font is made of, for fonts built around them. */
export const SYNTHETIC_GLYPHS = Object.freeze({
  notdef: simple([box(50, 0, 450, 700), box(100, 50, 400, 650, true)]),
  // A: straight sides, a curved crossbar, quadratics with implied midpoints, a
  // counter, skipped instructions and long deltas.
  a: simple(
    [
      [on(0, 0), on(150, 0), off(200, 180), off(450, 180), on(500, 0), on(650, 0), on(400, 700), on(250, 700)],
      [on(260, 320), off(325, 560), on(390, 320)].reverse(),
    ],
    { instructions: 7 },
  ),
  // O: an all-off-curve outer contour (it starts at an implied midpoint) and an inner one.
  o: simple([ring(350, 350, 340, 16, () => false), ring(350, 350, 200, 12, (index) => index % 3 === 0, true)]),
  // i: a stem, a dot, and a one-point contour the reader drops.
  i: simple([box(100, 0, 200, 450), box(100, 550, 200, 650), [on(150, 800)]]),
  // ¨: two small dots for a composite.
  dieresis: simple([box(0, 0, 80, 80), box(160, 0, 240, 80)]),
  // L: every delta written as 16 bits, flags never repeated.
  l: simple(
    [
      polygon([
        [0, 0],
        [400, 0],
        [400, 100],
        [100, 100],
        [100, 700],
        [0, 700],
      ]),
    ],
    { longCoordinates: true, repeat: false },
  ),
  // E: an empty contour between two (equal end points).
  e: simple([box(0, 0, 100, 700), box(100, 0, 400, 100)], { endPoints: [3, 3, 7] }),
} satisfies Record<string, SyntheticGlyph>);

/**
 * The sample font: "A", "O", "i", "L", "E", a space, "Ä" (a composite), "#"
 * (word offsets and every scale form) and "8" (a composite of composites),
 * mapped through every kind of format 4 segment, with fewer metrics than
 * glyphs. Everything the reader reads of a well-formed font, in 11 glyphs.
 */
export const SYNTHETIC_SANS: SyntheticFont = Object.freeze<SyntheticFont>({
  glyphs: [
    SYNTHETIC_GLYPHS.notdef, // 0
    SYNTHETIC_GLYPHS.a, // 1
    SYNTHETIC_GLYPHS.o, // 2
    SYNTHETIC_GLYPHS.i, // 3
    { empty: true }, // 4: space
    // 5 Ä: A with its dieresis, byte offsets and a uniform scale.
    { composite: [{ glyph: 1 }, { glyph: 6, dx: 120, dy: -100, scale: 0.75 }] },
    SYNTHETIC_GLYPHS.dieresis, // 6
    // 7 #: word offsets, an x/y scale, a two-by-two and point-matched arguments (ignored).
    {
      composite: [
        { glyph: 3, dx: -300, dy: 1000, words: true, xyScale: [1.5, 0.5] },
        { glyph: 6, dx: 10, dy: 20, twoByTwo: [0, 1, -1, 0] },
        { glyph: 2, dx: 5, dy: 5, xyValues: false, scale: -0.25 },
      ],
    },
    // 8 8: a composite of a composite, offset by a negative byte.
    {
      composite: [
        { glyph: 5, dx: -20, dy: 0 },
        { glyph: 7, dx: 100, dy: 30, words: true },
      ],
    },
    SYNTHETIC_GLYPHS.l, // 9
    SYNTHETIC_GLYPHS.e, // 10
  ],
  advances: [500, 650, 700, 300, 250, 650],
  subtables: [
    {
      format: 4,
      segments: [
        { start: 0x20, end: 0x20, delta: 4 - 0x20 },
        { start: 0x23, end: 0x23, delta: 7 - 0x23 },
        { start: 0x38, end: 0x38, delta: 8 - 0x38 },
        { start: 0x41, end: 0x41, delta: 1 - 0x41 },
        { start: 0x45, end: 0x45, glyphs: [10] },
        { start: 0x49, end: 0x49, delta: 3 - 0x49 },
        { start: 0x4c, end: 0x4f, glyphs: [9, 0, 0, 2] },
        // Overlapping the glyph array: the later segment wins where it maps.
        { start: 0x4d, end: 0x4e, delta: 3 - 0x4d },
        { start: 0x69, end: 0x69, delta: 3 - 0x69 },
        { start: 0xa8, end: 0xa8, delta: 6 - 0xa8 },
        { start: 0xc4, end: 0xc4, glyphs: [5] },
        // Deltas wrapping past 0xFFFF: to glyph 1, and to glyph 0 (unmapped).
        { start: 0x100, end: 0x101, delta: 0x10000 - 0x100 + 1 },
        // A lone high surrogate, as a text can hold one.
        { start: 0xd800, end: 0xd800, delta: 3 - 0xd800 },
        { start: 0xffff, end: 0xffff, delta: 1 },
      ],
    },
  ],
});
