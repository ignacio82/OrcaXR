// A slice's outputs through a binding (`slice-output-vectors.json` and
// `slice-sidecar-vectors.json`): every thumbnail list, block, injection,
// camera and slice plan of the browser's corpus, and every plate's profile
// snapshot, output binding and external route, answers the browser's reply
// byte for byte and every malformed request is refused; then the
// browser-authored placement scene, opened as a real session and asked for the
// U1's sizes and a JPEG, draws its first plate's pictures from the one-plate
// capture with exactly the bytes the Rust core draws
// (`orcaxr-archive/tests/thumbnail.rs`), its captured project plans both slices
// and snapshots every plate's profiles as the state-document exchanges do, and
// a sidecar binds an output to them on this device's route. Runs unchanged
// over WASM in Node and a browser worker, and over the JNI bridge: the host
// supplies SHA-256 (`sha256(bytes)` → lowercase hex) and base64 decoding.

/** The first plate's 48 × 48 and 300 × 300 PNGs and 144 × 144 JPEG, as Rust draws them. */
export const THUMBNAIL_DIGESTS = [
  "a379bc23c783bb20284d5491a07510c360439ab2b3e9cf4c2bf5ee1a7e6003e3",
  "715756a8fde33b8b72921ff09128b467251126ac8c52d0ad44064173fb4fadd1",
  "bf5e3788f2d66e9875cb17f33b20660a52f1c066f38021be98044111f563b4d0",
];

/** Profiles, bindings and routes answered; refusals; a capture's snapshots; sidecars. */
export const SLICE_SIDECAR_ANSWERS = [57, 73, 66, 21, 2, 3];

/** The pinned engine commit, and an artifact identity standing in for a packaged build's. */
const COMMIT = "9fd12ffb2b1b80c9fb4c14564754d2ec1573a626";
const ARTIFACT = `sha256:${"ab".repeat(32)}`;

export async function replaySliceOutputs(core, fixture, sidecarFixture, placement, layout, sha256, b64) {
  const fail = (label) => {
    throw Error(label);
  };
  const replay = (sections) => {
    const answers = [];
    let refusals = 0;
    for (const [section, refused, answer] of sections) {
      let count = 0;
      for (const [i, c] of section.entries()) {
        const reply = answer(c.request);
        if (reply !== c.reply) fail(`${c.name ?? i}: ${String(reply).slice(0, 200)}`);
        count++;
      }
      answers.push(count);
      for (const c of refused) {
        let thrown = false;
        try {
          answer(c.request);
        } catch (e) {
          if (!String(e?.message ?? e).includes("invalid_request")) throw e;
          thrown = true;
        }
        if (!thrown) fail(`${String(c.request).slice(0, 80)} was accepted`);
        refusals++;
      }
    }
    answers.push(refusals);
    return answers;
  };
  const answers = replay([
    [fixture.lists, fixture.listRefusals, core.slice_thumbnail_list],
    [fixture.blocks, fixture.blockRefusals, core.slice_thumbnail_block],
    [fixture.injections, fixture.injectRefusals, core.slice_thumbnail_inject],
    [fixture.views, fixture.viewRefusals, core.slice_thumbnail_view],
    [fixture.plans, fixture.planRefusals, core.slice_plan],
  ]);
  const sidecarAnswers = replay([
    [sidecarFixture.profiles, sidecarFixture.profileRefusals, core.slice_profiles],
    [sidecarFixture.bindings, sidecarFixture.bindingRefusals, core.slice_binding],
    [sidecarFixture.routes, sidecarFixture.routeRefusals, core.external_slicer_route],
  ]);

  // The placement scene, its configuration asking for three pictures and one size no engine accepts.
  const state = JSON.parse(placement.stateJson);
  state.config.thumbnails = "48x48/PNG, 300x300/PNG, 144x144/JPG, 5000x5000";
  const stateJson = JSON.stringify(state);
  const source = new TextEncoder().encode(stateJson);
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
  let snapshots = 0;
  let profiles;
  try {
    const guard = session.capture_guard();
    const capture = session.capture_export(guard);
    try {
      const plate = capture.plate(JSON.stringify(state.plates[0].id));
      try {
        const drawn = JSON.parse(plate.thumbnails());
        if (JSON.stringify(drawn.problems) !== '[{"entry":"5000x5000","reason":"out-of-range"}]') fail("thumbnail problems");
        const digests = [];
        for (const t of drawn.thumbnails) {
          const lines = t.block.split("\n");
          const begin = lines.findIndex((l) => / begin \d+x\d+ \d+$/.test(l));
          const end = lines.findIndex((l) => / end$/.test(l) && !l.includes("BLOCK"));
          const base64 = lines
            .slice(begin + 1, end)
            .map((l) => l.slice(2))
            .join("");
          if (Number(lines[begin].split(" ").at(-1)) !== base64.length) fail("block length");
          digests.push(await sha256(b64(base64)));
        }
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
          const expected = core.slice_plan(JSON.stringify({ scope, stateJson }));
          if (project.slice_plan(scope) !== expected) fail(`captured ${scope} plan`);
        }
        // Every plate's profiles, and an unknown plate's refusal, as the state document's.
        for (const plateId of [...state.plates.map((p) => p.id), "import:plate:unknown"]) {
          const expected = core.slice_profiles(JSON.stringify({ plateId, stateJson }));
          if (project.slice_profiles(JSON.stringify(plateId)) !== expected) fail(`captured profiles of ${plateId}`);
          snapshots++;
        }
        profiles = JSON.parse(project.slice_profiles(JSON.stringify(state.plates[0].id)));
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

  // This device's route, named by its engine; an engine it cannot name is refused.
  const engine = { artifactHash: ARTIFACT, commit: COMMIT };
  const route = core.slice_native_route(JSON.stringify({ engine }));
  if (route !== `{"engine":{"artifactHash":"${ARTIFACT}","commit":"${COMMIT}"},"id":"slicer-client:android-native:${ARTIFACT}","kind":"android-native","protocolVersion":1}`)
    fail(`native route ${route}`);
  if (!core.slice_native_route(JSON.stringify({ engine: { ...engine, commit: "HEAD" } })).startsWith('{"error":'))
    fail("an unnamed engine made a route");

  // A sidecar binds one output to the plate's profiles on that route, and nothing else.
  const request = {
    binding: {
      jobId: "slice-1",
      plateId: state.plates[0].id,
      sourceRevision: 1,
      sourceHash: "fnv1a64:0123456789abcdef",
      sourceAssetHash: "fnv1a64:fedcba9876543210",
      projectInputHash: `sha256:${"01".repeat(32)}`,
      gcodeOutputHash: `sha256:${"02".repeat(32)}`,
      effectiveConfigHash: profiles.effectiveConfigHash,
      engineCommit: COMMIT,
      engineArtifactHash: ARTIFACT,
    },
    gcodeBytes: 4096,
    profiles,
    route: JSON.parse(route),
    summary: { empty: false, layerCount: 12, perTool: [{ material: "PLA", toolIndex: 0, weightG: 1.5 }] },
    warnings: [],
  };
  const sidecar = JSON.parse(core.slice_sidecar(JSON.stringify(request)));
  if (
    sidecar.schema !== "orcaxr.slice-output" ||
    sidecar.version !== 1 ||
    JSON.stringify(sidecar.binding) !== JSON.stringify(Object.fromEntries(Object.entries(request.binding).sort(([a], [b]) => (a < b ? -1 : 1)))) ||
    JSON.stringify(sidecar.statistics) !== JSON.stringify({ gcodeBytes: 4096, route: "android-native", summary: request.summary })
  )
    fail("sidecar");
  const stale = { ...request, binding: { ...request.binding, effectiveConfigHash: `sha256:${"03".repeat(32)}` } };
  if (!core.slice_sidecar(JSON.stringify(stale)).startsWith('{"error":"binding.effectiveConfigHash'))
    fail("a sidecar bound another configuration");
  const foreign = { ...request, binding: { ...request.binding, engineArtifactHash: `sha256:${"04".repeat(32)}` } };
  if (core.slice_sidecar(JSON.stringify(foreign)) !== `{"error":"binding's engine is not the route's engine"}`)
    fail("a sidecar bound another engine");
  sidecarAnswers.push(snapshots, 3);
  return { sliceOutputAnswers: answers, sliceSidecarAnswers: sidecarAnswers };
}
