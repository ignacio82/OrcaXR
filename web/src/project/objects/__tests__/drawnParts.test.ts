import assert from 'node:assert/strict';

import { CommandBus, InMemoryAssetRepository, ProjectStore, SelectionStore, UuidIdSource, seededRandom } from '../..';
import type { VolumeId } from '../../domain/ids';
import { createProjectFixture } from '../../__tests__/fixtures';
import { drawnPart, drawnPartWire } from '../drawnPartExchange';
import { AddEmbossTextCommand, embossVolumeIdentity, prepareEmbossedVolume } from '../embossCommands';
import { DEFAULT_EMBOSS_TEXT_CONFIGURATION } from '../emboss';
import { embossCodePoints, embossGlyphsWire, prepareEmbossTextWire, readEmbossFontWire } from '../embossFontExchange';
import { prepareEmbossWire } from '../embossExchange';
import { SYNTHETIC_SANS, trueTypeFont } from './syntheticFonts';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const units = (text: string) => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
const wireRecipe = (text: string) => ({
  text: units(text),
  styleName: units('Sample'),
  fontDescriptor: units('sample.ttf'),
  fontDescriptorType: units('file_name'),
  font: { ...DEFAULT_EMBOSS_TEXT_CONFIGURATION.font },
  projection: { ...DEFAULT_EMBOSS_TEXT_CONFIGURATION.projection },
  family: { absent: {} },
  faceName: { absent: {} },
  style: { absent: {} },
  weight: { absent: {} },
});

test('a cut looks up each character once, line by line, a lone surrogate standing for itself', () => {
  assert.deepEqual(embossCodePoints('AOA\nOi\ud800😀'), [0x41, 0x4f, 0x69, 0xd800, 0x1f600]);
});

test('a font read for a host cuts as the outlines it reports do', () => {
  const { reply, font } = readEmbossFontWire({ collection: 0 }, trueTypeFont(SYNTHETIC_SANS));
  assert.deepEqual(reply, { read: { unitsPerEm: 1000, glyphCount: 11 } });
  assert.ok(font);
  const outlines = embossGlyphsWire(font, { text: units('AOz\nÄ') });
  assert.ok('glyphs' in outlines);
  assert.deepEqual(
    outlines.glyphs.glyphs.map((glyph) => glyph.codePoint),
    [0x41, 0x4f, 0xc4],
  );
  const direct = prepareEmbossTextWire(font, { configuration: wireRecipe('AOz\nÄ') });
  const relayed = prepareEmbossWire({ configuration: wireRecipe('AOz\nÄ'), font: outlines.glyphs });
  assert.deepEqual(direct.reply, relayed.reply);
  assert.ok('prepared' in direct.reply);
  assert.deepEqual(direct.reply.prepared.missingCodePoints, [0x7a]);
  // A font that cannot be read is a refusal, in the reader's words.
  assert.deepEqual(readEmbossFontWire({ collection: 0 }, new Uint8Array(3)).reply, {
    refused: { code: 'unsupportedFont', message: units('That file is too short to be a font') },
  });
});

test('a part answers whether it is embossed text, and an unknown one is refused', () => {
  const fixture = createProjectFixture();
  const project = new ProjectStore(fixture.state);
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const commands = new CommandBus({ project, selection: new SelectionStore(), assets });
  const object = project.getSnapshot().state.plates[0].objects[0];
  const plain = object.volumes[0].id;
  const { font } = readEmbossFontWire({ collection: 0 }, trueTypeFont(SYNTHETIC_SANS));
  assert.ok(font);
  const configuration = { ...DEFAULT_EMBOSS_TEXT_CONFIGURATION, text: 'AOi' };
  const identity = embossVolumeIdentity(new UuidIdSource(seededRandom(3)));
  const prepared = prepareEmbossedVolume(configuration, font, identity.assetId);
  commands.execute(
    new AddEmbossTextCommand(
      {
        objectId: object.id,
        ...identity,
        transform: { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      configuration,
      prepared,
    ),
  );
  const state = project.getSnapshot().state;
  assert.deepEqual(drawnPart(state, identity.volumeId), { text: true, svg: false });
  assert.deepEqual(drawnPart(state, plain), { text: false, svg: false });
  assert.equal(drawnPart(state, 'import:volume:missing' as VolumeId), undefined);
  assert.deepEqual(drawnPartWire(state, { volumeId: units('import:volume:missing') }), {
    refused: { message: units('Volume import:volume:missing is not in this project') },
  });
});

console.log(`\nDrawn parts: ${passed} tests passed.`);
