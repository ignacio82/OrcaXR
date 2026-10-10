// The workspace bed through a binding (`workspace-bed-vectors.json`): every
// configuration's bed, printable area, height and tower keep-out compared
// byte for byte with the browser's reply, every malformed request refused,
// and each recorded project opened as a real session whose captured project
// answers for each of its plates. Runs unchanged over WASM in Node and a
// browser worker, and over the JNI bridge.
export function replayWorkspaceBeds(core, fixture, layout) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  let beds = 0;
  let refusals = 0;
  let projectBeds = 0;
  for (const c of fixture.cases) {
    if (core.workspace_bed(c.request) !== c.reply) fail(`bed ${c.name}: reply differs`);
    beds++;
  }
  for (const r of fixture.refusals) {
    let refused = false;
    try {
      core.workspace_bed(r.request);
    } catch (e) {
      if (!String(e?.message ?? e).includes("invalid_request")) throw e;
      refused = true;
    }
    if (!refused) fail(`bed refusal ${r.name} was accepted`);
    refusals++;
  }
  for (const project of fixture.states) {
    const source = encode.encode(project.stateJson);
    const options = {
      documentBytes: source.length,
      documentNodes: 1_000_000,
      documentTextUnits: 2_000_000,
      numberBytes: 1024,
      depth: 128,
      assets: 0,
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
    } catch (e) {
      upload.free();
      throw e;
    }
    const session = upload.open(Float64Array.from([1, 2, 3, 4]));
    try {
      const captured = session.snapshot();
      try {
        for (const bed of project.beds) {
          if (captured.workspace_bed(bed.request) !== bed.reply)
            fail(`${project.name} ${bed.request}: reply differs`);
          projectBeds++;
        }
        let refused = false;
        try {
          captured.workspace_bed('{"plateId":3}');
        } catch (e) {
          if (!String(e?.message ?? e).includes("invalid_request")) throw e;
          refused = true;
        }
        if (!refused) fail(`${project.name}: a numeric plate was accepted`);
      } finally {
        captured.free();
      }
    } finally {
      session.free();
    }
  }
  return { beds, bedRefusals: refusals, projectBeds };
}
