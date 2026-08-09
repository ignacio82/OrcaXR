import assert from 'node:assert/strict';

import { DEFAULT_EMBOSS_FONT_PROPERTY, type EmbossTextConfiguration } from '../objects/emboss';
import {
  EMBOSS_SHAPE_TAG,
  EMBOSS_TEXT_TAG,
  decodeEmbossTextConfiguration,
  encodeEmbossShape,
  encodeEmbossTextConfiguration,
} from './embossTextConfig';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function configuration(overrides: Partial<EmbossTextConfiguration> = {}): EmbossTextConfiguration {
  return {
    text: 'OrcaXR',
    styleName: 'My style',
    fontDescriptor: '/usr/share/fonts/x.ttf',
    fontDescriptorType: 'file_name',
    font: DEFAULT_EMBOSS_FONT_PROPERTY,
    projection: { depthMm: 1.5, useSurface: false },
    ...overrides,
  };
}

test('writes the pinned tag names and only the attributes upstream stores', () => {
  assert.equal(EMBOSS_TEXT_TAG, 'slic3rpe:text');
  assert.equal(EMBOSS_SHAPE_TAG, 'slic3rpe:shape');

  const xml = encodeEmbossTextConfiguration(configuration());
  assert.match(xml, /^<slic3rpe:text /);
  assert.match(xml, /text="OrcaXR"/);
  assert.match(xml, /line_height="10"/);
  assert.match(xml, /horizontal="center"/);
  // Absent optionals stay absent; a default must not reappear as a stored value.
  for (const absent of ['char_gap', 'line_gap', 'boldness', 'skew', 'per_glyph', 'collection', 'family']) {
    assert.equal(xml.includes(`${absent}=`), false, `${absent} must be omitted when unset`);
  }
});

test('vertical center serialises as the pinned "middle"', () => {
  const xml = encodeEmbossTextConfiguration(configuration());
  assert.match(xml, /vertical="middle"/, 'upstream writes middle, not center');
  assert.equal(xml.includes('vertical="center"'), false);

  const decoded = decodeEmbossTextConfiguration(xml);
  assert.equal(decoded.configuration?.font.vertical, 'center', 'and reads back as our canonical center');

  for (const [name, expected] of [
    ['top', 'top'],
    ['bottom', 'bottom'],
  ] as const) {
    const round = decodeEmbossTextConfiguration(
      encodeEmbossTextConfiguration(configuration({ font: { ...DEFAULT_EMBOSS_FONT_PROPERTY, vertical: expected } })),
    );
    assert.equal(round.configuration?.font.vertical, expected, `${name} round-trips`);
  }
});

test('a fully populated configuration round-trips exactly', () => {
  const full = configuration({
    text: 'Line one\nLine "two" & <three>',
    font: {
      charGapMm: 0.5,
      lineGapMm: 1.25,
      lineHeightMm: 12,
      boldnessMm: 0.2,
      skew: 0.15,
      perGlyph: true,
      horizontal: 'right',
      vertical: 'bottom',
      collection: 2,
    },
    projection: { depthMm: 2.5, useSurface: true },
    family: 'Inter',
    faceName: 'Inter Regular',
    style: 'Regular',
    weight: '400',
  });
  const decoded = decodeEmbossTextConfiguration(
    encodeEmbossTextConfiguration(full),
    encodeEmbossShape(full.projection),
  );
  assert.deepEqual(decoded.warnings, []);
  assert.deepEqual(decoded.configuration, full, 'every stored field survives a round trip');
});

test('quotes, newlines, and markup in the text survive escaping', () => {
  const tricky = configuration({ text: 'a "b" & <c>\nd' });
  const xml = encodeEmbossTextConfiguration(tricky);
  assert.equal(xml.includes('\n'), false, 'the element stays on one line');
  assert.equal(decodeEmbossTextConfiguration(xml).configuration?.text, tricky.text);
});

test('the projection lives on the shape tag and defaults honestly', () => {
  const shape = encodeEmbossShape({ depthMm: 3, useSurface: true }, 1.5, true);
  assert.match(shape, /depth="3"/);
  assert.match(shape, /use_surface="1"/);
  assert.match(shape, /scale="1.5"/);
  assert.match(shape, /unhealed="1"/);

  // No shape element at all: the pinned 1 mm default applies, without a warning
  // — there was nothing malformed to report.
  const noShape = decodeEmbossTextConfiguration(encodeEmbossTextConfiguration(configuration()));
  assert.equal(noShape.configuration?.projection.depthMm, 1);
  assert.deepEqual(noShape.warnings, []);

  // A shape element that carries no usable depth *is* reported.
  const badShape = decodeEmbossTextConfiguration(
    encodeEmbossTextConfiguration(configuration()),
    '<slic3rpe:shape depth="0"/>',
  );
  assert.equal(badShape.configuration?.projection.depthMm, 1);
  assert.match(badShape.warnings.join(' '), /no usable depth/);
});

test('an unusable element is refused instead of being half-read', () => {
  const noText = decodeEmbossTextConfiguration('<slic3rpe:text style_name="x" line_height="10"/>');
  assert.equal(noText.configuration, undefined);
  assert.match(noText.warnings.join(' '), /no text attribute/);

  const noHeight = decodeEmbossTextConfiguration('<slic3rpe:text text="hi"/>');
  assert.equal(noHeight.configuration, undefined);
  assert.match(noHeight.warnings.join(' '), /no usable line_height/);
});

test('unknown alignment names fall back and say so', () => {
  const decoded = decodeEmbossTextConfiguration(
    '<slic3rpe:text text="hi" line_height="10" horizontal="justified" vertical="baseline"/>',
  );
  assert.equal(decoded.configuration?.font.horizontal, DEFAULT_EMBOSS_FONT_PROPERTY.horizontal);
  assert.equal(decoded.configuration?.font.vertical, DEFAULT_EMBOSS_FONT_PROPERTY.vertical);
  assert.match(decoded.warnings.join(' '), /Unknown horizontal alignment justified/);
  assert.match(decoded.warnings.join(' '), /Unknown vertical alignment baseline/);
});

console.log(`\nEmboss text persistence: ${passed} tests passed.`);
