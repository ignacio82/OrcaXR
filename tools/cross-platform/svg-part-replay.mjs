// SVG parts through a binding: cut every drawing of the browser's script from
// its file bytes (with its refusals) and page each cut's mesh, then open the
// browser-authored project as a real session and stage cuts as new parts and
// re-cuts, with undo and redo — comparing every reply with the TypeScript
// authority's own encoding, every mesh by SHA-256 (`sha256` resolves a hex
// digest; `bytes` decodes base64), and each step's outcome, revision, hash
// and undo label. Runs unchanged over WASM in Node and a browser worker, and
// over the JNI bridge.
export async function replaySvgParts(
  core,
  fixture,
  layout,
  stagingVersion,
  sha256,
  bytes,
) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const source = encode.encode(fixture.stateJson);
  const options = {
    documentBytes: source.length,
    documentNodes: 1_000_000,
    documentTextUnits: 2_000_000,
    numberBytes: 1024,
    depth: 128,
    assets: fixture.assets.length,
    assetBytes: 16 * 1024 * 1024,
    totalAssetBytes: 32 * 1024 * 1024,
    historyEntries: 100,
    historyBytes: 32 * 1024 * 1024,
  };
  const upload = new core.ProjectUpload(
    layout.version,
    source.length,
    Float64Array.from(layout.options.map((k) => options[k])),
  );
  try {
    for (let p = 0; p < source.length; p += layout.maxChunkBytes)
      upload.append_document(p, source.subarray(p, p + layout.maxChunkBytes));
    upload.seal_document();
    fixture.assets.forEach((asset, position) => {
      const data = Uint8Array.from(asset.bytes);
      if (upload.begin_asset(position) !== data.length)
        fail(`asset ${position} length`);
      for (let p = 0; p < data.length; p += layout.maxChunkBytes)
        upload.append_asset(p, data.subarray(p, p + layout.maxChunkBytes));
      upload.finish_asset();
    });
  } catch (e) {
    upload.free();
    throw e;
  }
  const generation = [1, 2, 3, 4];
  const session = upload.open(Float64Array.from(generation));
  let sequence = 0;
  const submit = (operation) => {
    const reply =
      session.submit(
        JSON.stringify({
          protocolVersion: 1,
          generation,
          requestId: ++sequence,
          operation,
        }),
      ) ?? session.run_next();
    return JSON.parse(reply.wire()).result;
  };
  const camel = {
    stale: "stale",
    invalid_request: "invalidRequest",
    resource_limit: "resourceLimit",
  };
  const cuts = new Map();
  const counts = {
    prepared: 0,
    refused: 0,
    meshes: 0,
    stages: 0,
    applied: 0,
    history: 0,
  };
  try {
    if (
      !submit({
        hello: {
          minProtocolVersion: 1,
          maxProtocolVersion: 1,
          projectSchemaVersion: 1,
          intentVersion: 1,
        },
      }).welcome
    )
      fail("hello");
    session.configure_staging(
      stagingVersion,
      Float64Array.from([4, 16, 64_000_000, 16_000_000]),
    );
    for (const [i, step] of fixture.steps.entries()) {
      const label = `step ${i}`;
      if ("prepare" in step) {
        const cut = core.prepare_svg_part(step.prepare, bytes(step.drawing));
        const reply = cut.reply();
        eq(reply, step.reply, label);
        const kind = Object.keys(JSON.parse(reply))[0];
        counts[kind]++;
        if (kind === "prepared") {
          const length = JSON.parse(reply).prepared.byteLength;
          eq(await sha256(cut.mesh(0, length)), step.mesh, `${label} mesh`);
          if ("window" in step)
            eq(await sha256(cut.mesh(16, 64)), step.window, `${label} window`);
          counts.meshes++;
        }
        cuts.get(step.svg)?.free();
        cuts.set(step.svg, cut);
        continue;
      }
      if ("stage" in step) {
        let outcome;
        try {
          const id = session.stage_svg_part(cuts.get(step.svg), step.stage);
          const result = submit({ executeStaged: { stagedId: id } });
          outcome =
            "acknowledged" in result
              ? result.acknowledged.changed
                ? "applied"
                : "unchanged"
              : result.error;
        } catch (e) {
          const code = Object.keys(camel).find((k) =>
            String(e?.message ?? e).includes(k),
          );
          if (!code) throw e;
          outcome = camel[code];
        }
        eq(outcome, step.outcome, `${label} outcome`);
        counts.stages++;
        if (outcome === "applied") counts.applied++;
      } else {
        const guard = submit({ query: {} }).acknowledged.guard;
        const result = submit({ [step.history]: guard });
        if (!("acknowledged" in result))
          fail(`${label}: ${JSON.stringify(result)}`);
        counts.history++;
      }
      const snapshot = session.snapshot();
      try {
        eq(snapshot.revision(), step.revision, `${label} revision`);
        eq(snapshot.hash(), step.hash, `${label} hash`);
      } finally {
        snapshot.free();
      }
      const history = session.history();
      try {
        const undo = history.has_label(true)
          ? Array.from(history.label_text(true, 0, history.label_length(true)))
          : null;
        eq(
          JSON.stringify(undo),
          JSON.stringify(step.undoLabel),
          `${label} undo`,
        );
      } finally {
        history.free();
      }
    }
  } finally {
    for (const cut of cuts.values()) cut.free();
    session.free();
  }
  return {
    svgPrepared: counts.prepared,
    svgRefused: counts.refused,
    svgMeshes: counts.meshes,
    svgStages: counts.stages,
    svgApplied: counts.applied,
    svgHistory: counts.history,
  };
}
