// Paint strokes through a binding: open the browser-authored project as a real
// session and run the host's script of strokes — opens and their refusals,
// samples, overlay pages and staged commits — comparing every reply with the
// TypeScript authority's own encoding and each commit's outcome, revision,
// hash and undo label; every live preview and canonical overlay packet is
// compared by SHA-256 (`sha256` resolves a hex digest). Runs unchanged over
// WASM in Node and a browser worker, and over the JNI bridge.
export async function replayPaintStrokes(
  core,
  fixture,
  layout,
  stagingVersion,
  sha256,
) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const refuses = (run, code, label) => {
    let refusal;
    try {
      run();
    } catch (e) {
      refusal = String(e?.message ?? e);
    }
    if (!refusal?.includes(code))
      fail(`${label}: ${refusal} does not refuse ${code}`);
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
      const bytes = Uint8Array.from(asset.bytes);
      if (upload.begin_asset(position) !== bytes.length)
        fail(`asset ${position} length`);
      for (let p = 0; p < bytes.length; p += layout.maxChunkBytes)
        upload.append_asset(p, bytes.subarray(p, p + layout.maxChunkBytes));
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
  const strokes = new Map();
  const counts = {
    opens: 0,
    refusals: 0,
    samples: 0,
    overlays: 0,
    commits: 0,
    packets: 0,
  };
  // One overlay capture against its recorded summary, packet and window.
  const packets = async (overlay, step, label) => {
    try {
      eq(overlay.summary(), step.summary, `${label} summary`);
      eq(
        await sha256(overlay.packet(0, 16384)),
        step.packet,
        `${label} packet`,
      );
      if ("window" in step)
        eq(await sha256(overlay.packet(1, 2)), step.window, `${label} window`);
    } finally {
      overlay.free();
    }
    counts.packets++;
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
    const open = (request) => {
      const guard = session.capture_guard();
      try {
        return session.paint_stroke(guard, request);
      } finally {
        guard.free();
      }
    };
    for (const [i, step] of fixture.steps.entries()) {
      const label = `step ${i}`;
      if ("preview" in step) {
        await packets(strokes.get(step.stroke).preview(), step, label);
      } else if ("canonical" in step) {
        if (!("refusal" in step))
          await packets(session.paint_overlay(step.canonical), step, label);
        else if ("count" in step) {
          const overlay = session.paint_overlay(step.canonical);
          try {
            refuses(() => overlay.packet(0, step.count), step.refusal, label);
          } finally {
            overlay.free();
          }
          counts.refusals++;
        } else {
          refuses(
            () => session.paint_overlay(step.canonical),
            step.refusal,
            label,
          );
          counts.refusals++;
        }
      } else if ("open" in step) {
        if ("refusal" in step) {
          refuses(() => open(step.open).free(), step.refusal, label);
          counts.refusals++;
        } else {
          strokes.set(step.stroke, open(step.open));
          counts.opens++;
        }
      } else if ("sample" in step) {
        eq(strokes.get(step.stroke).sample(step.sample), step.reply, label);
        counts.samples++;
      } else if ("overlay" in step) {
        const stroke = strokes.get(step.stroke);
        if ("refusal" in step) {
          refuses(() => stroke.overlay(step.overlay), step.refusal, label);
          counts.refusals++;
        } else {
          eq(stroke.overlay(step.overlay), step.reply, label);
          counts.overlays++;
        }
      } else {
        const stroke = strokes.get(step.stroke);
        strokes.delete(step.stroke);
        let outcome;
        try {
          const id = session.stage_paint_stroke(
            stroke,
            step.commit === null ? undefined : Uint16Array.from(step.commit),
          );
          if (id === 0) outcome = "noop";
          else {
            const result = submit({ executeStaged: { stagedId: id } });
            outcome = result.acknowledged.changed ? "applied" : "unchanged";
          }
        } catch (e) {
          if (!String(e?.message ?? e).includes("stale")) throw e;
          outcome = "stale";
        } finally {
          stroke.free();
        }
        eq(outcome, step.outcome, `${label} outcome`);
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
            ? Array.from(
                history.label_text(true, 0, history.label_length(true)),
              )
            : null;
          eq(
            JSON.stringify(undo),
            JSON.stringify(step.undoLabel),
            `${label} undo`,
          );
        } finally {
          history.free();
        }
        counts.commits++;
      }
    }
    if (strokes.size !== 0) fail("unfinished strokes");
  } finally {
    for (const stroke of strokes.values()) stroke.free();
    session.free();
  }
  return {
    paintStrokeOpens: counts.opens,
    paintStrokeSamples: counts.samples,
    paintStrokeOverlays: counts.overlays,
    paintStrokeCommits: counts.commits,
    paintStrokeRefusals: counts.refusals,
    paintOverlayPackets: counts.packets,
  };
}
