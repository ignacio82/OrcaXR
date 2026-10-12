// A slice's outputs through a binding (`slice-output-vectors.json`): every
// thumbnail list, block, injection, camera and slice plan of the browser's
// corpus answers the browser's reply byte for byte and every malformed request
// is refused; then the browser-authored placement scene, opened as a real
// session and asked for the U1's sizes and a JPEG, draws its first plate's
// pictures from the one-plate capture with exactly the bytes the Rust core
// draws (`orcaxr-archive/tests/thumbnail.rs`), and its captured project plans
// both slices as the state-document exchange does. Runs unchanged over WASM in
// Node and a browser worker, and over the JNI bridge.
import { createHash } from "node:crypto";

/** The first plate's 48 × 48 and 300 × 300 PNGs and 144 × 144 JPEG, as Rust draws them. */
export const THUMBNAIL_DIGESTS = [
  "a379bc23c783bb20284d5491a07510c360439ab2b3e9cf4c2bf5ee1a7e6003e3",
  "715756a8fde33b8b72921ff09128b467251126ac8c52d0ad44064173fb4fadd1",
  "bf5e3788f2d66e9875cb17f33b20660a52f1c066f38021be98044111f563b4d0",
];

export function replaySliceOutputs(core, fixture, placement, layout) {
  const fail = (label) => {
    throw Error(label);
  };
  const sections = [
    ["lists", "listRefusals", core.slice_thumbnail_list],
    ["blocks", "blockRefusals", core.slice_thumbnail_block],
    ["injections", "injectRefusals", core.slice_thumbnail_inject],
    ["views", "viewRefusals", core.slice_thumbnail_view],
    ["plans", "planRefusals", core.slice_plan],
  ];
  const answers = [];
  let refusals = 0;
  for (const [section, refused, answer] of sections) {
    let count = 0;
    for (const [i, c] of fixture[section].entries()) {
      const reply = answer(c.request);
      if (reply !== c.reply) fail(`${section} ${i}: ${String(reply).slice(0, 200)}`);
      count++;
    }
    answers.push(count);
    for (const c of fixture[refused]) {
      let thrown = false;
      try {
        answer(c.request);
      } catch (e) {
        if (!String(e?.message ?? e).includes("invalid_request")) throw e;
        thrown = true;
      }
      if (!thrown) fail(`${refused} ${c.name} was accepted`);
      refusals++;
    }
  }
  answers.push(refusals);

  // The placement scene, its configuration asking for three pictures and one size no engine accepts.
  const state = JSON.parse(placement.stateJson);
  state.config.thumbnails = "48x48/PNG, 300x300/PNG, 144x144/JPG, 5000x5000";
  const source = new TextEncoder().encode(JSON.stringify(state));
  const options = {
    documentBytes: source.length,
    documentNodes: 1_000_000,
    documentTextUnits: 2_000_000,
    numberBytes: 1024,
    depth: 128,
    assets: placement.assets.length,
    assetBytes: 16 * 1024 * 1024,
    totalAssetBytes: 32 * 1024 * 1024,
    historyEntries: 100,
    historyBytes: 32 * 1024 * 1024,
  };
  const upload = new core.ProjectUpload(layout.version, source.length, Float64Array.from(layout.options.map((k) => options[k])));
  try {
    for (let p = 0; p < source.length; p += layout.maxChunkBytes)
      upload.append_document(p, source.subarray(p, p + layout.maxChunkBytes));
    upload.seal_document();
    placement.assets.forEach((asset, position) => {
      const bytes = Uint8Array.from(asset.bytes);
      if (upload.begin_asset(position) !== bytes.length) fail(`asset ${position} length`);
      for (let p = 0; p < bytes.length; p += layout.maxChunkBytes)
        upload.append_asset(p, bytes.subarray(p, p + layout.maxChunkBytes));
      upload.finish_asset();
    });
  } catch (e) {
    upload.free();
    throw e;
  }
  const session = upload.open(Float64Array.from([1, 2, 3, 4]));
  let pictures = 0;
  try {
    const guard = session.capture_guard();
    const capture = session.capture_export(guard);
    try {
      const plate = capture.plate(JSON.stringify(state.plates[0].id));
      try {
        const drawn = JSON.parse(plate.thumbnails());
        if (JSON.stringify(drawn.problems) !== '[{"entry":"5000x5000","reason":"out-of-range"}]') fail("thumbnail problems");
        const digests = drawn.thumbnails.map((t) => {
          const lines = t.block.split("\n");
          const begin = lines.findIndex((l) => / begin \d+x\d+ \d+$/.test(l));
          const end = lines.findIndex((l) => / end$/.test(l) && !l.includes("BLOCK"));
          const base64 = lines.slice(begin + 1, end).map((l) => l.slice(2)).join("");
          if (Number(lines[begin].split(" ").at(-1)) !== base64.length) fail("block length");
          return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
        });
        if (JSON.stringify(digests) !== JSON.stringify(THUMBNAIL_DIGESTS)) fail(`thumbnail bytes ${digests}`);
        if (drawn.thumbnails.map((t) => `${t.width}x${t.height}/${t.format}`).join() !== "48x48/PNG,300x300/PNG,144x144/JPG")
          fail("thumbnail sizes");
        pictures += digests.length;
      } finally {
        plate.free();
      }
      const project = capture.project();
      try {
        for (const scope of ["current-plate", "all-plates"]) {
          const expected = core.slice_plan(JSON.stringify({ scope, stateJson: JSON.stringify(state) }));
          if (project.slice_plan(scope) !== expected) fail(`captured ${scope} plan`);
        }
      } finally {
        project.free();
      }
    } finally {
      capture.free();
      guard.free();
    }
  } finally {
    session.free();
  }
  answers.push(pictures);
  return { sliceOutputAnswers: answers };
}
