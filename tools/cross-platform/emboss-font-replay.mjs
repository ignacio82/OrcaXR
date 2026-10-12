// Emboss fonts through a binding: read every synthetic font of the browser's
// corpus (with its refusals), read texts' outlines from each and cut recipes
// with it — comparing every reply with the TypeScript authority's own
// encoding and every mesh by SHA-256 (`sha256` resolves a hex digest; `bytes`
// decodes base64). Runs unchanged over WASM in Node and a browser worker, and
// over the JNI bridge.
export async function replayEmbossFonts(core, fixture, sha256, bytes) {
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const files = new Map(fixture.fonts.map((font) => [font.name, bytes(font.bytes)]));
  const fonts = new Map();
  const counts = { read: 0, refused: 0, glyphs: 0, cuts: 0, meshes: 0 };
  try {
    for (const [i, step] of fixture.steps.entries()) {
      const label = `step ${i}`;
      if ("read" in step) {
        const font = core.read_emboss_font(step.read, files.get(step.file));
        fonts.get(step.handle)?.free();
        fonts.set(step.handle, font);
        const reply = font.reply();
        eq(reply, step.reply, label);
        counts[Object.keys(JSON.parse(reply))[0]]++;
      } else if ("glyphs" in step) {
        eq(fonts.get(step.handle).glyphs(step.glyphs), step.reply, label);
        counts.glyphs++;
      } else {
        const cut = fonts.get(step.handle).prepare(step.prepare);
        try {
          const reply = cut.reply();
          eq(reply, step.reply, label);
          counts.cuts++;
          if ("prepared" in JSON.parse(reply)) {
            const length = JSON.parse(reply).prepared.byteLength;
            eq(await sha256(cut.mesh(0, length)), step.mesh, `${label} mesh`);
            if ("window" in step) eq(await sha256(cut.mesh(16, 64)), step.window, `${label} window`);
            counts.meshes++;
          }
        } finally {
          cut.free();
        }
      }
    }
    // A refused font has no outlines and cuts nothing.
    const refused = core.read_emboss_font('{"collection":0}', new Uint8Array(3));
    try {
      let threw = 0;
      try {
        refused.glyphs('{"text":[65]}');
      } catch {
        threw++;
      }
      try {
        refused.prepare(fixture.steps.find((step) => "prepare" in step).prepare).free();
      } catch {
        threw++;
      }
      eq(threw, 2, "refused font");
    } finally {
      refused.free();
    }
  } finally {
    for (const font of fonts.values()) font.free();
  }
  return {
    embossFontReads: counts.read,
    embossFontRefused: counts.refused,
    embossFontGlyphs: counts.glyphs,
    embossFontCuts: counts.cuts,
    embossFontMeshes: counts.meshes,
  };
}
