// Catalog profile selection and slicing configuration through a binding
// (`slicing-configuration-vectors.json`): the bundled and synthetic catalogs
// streamed in and built, then every exchange's reply compared with the
// browser's — large ones by the SHA-256 of their text (`sha256` resolves a hex
// digest of bytes) — each configuration and next state fed forward as a host
// feeds it, every malformed request refused, and live choices committed on
// real sessions opened from their states, with undo. Runs unchanged over WASM
// in Node and a browser worker, and over the JNI bridge. `collator` is an
// optional host collator; the JNI bridge passes none. A `verified` sink, when
// given, receives each configuration and next-state reply once checked.
export async function replaySlicingConfiguration(
  core,
  fixture,
  bundledBytes,
  collator,
  layout,
  stagingVersion,
  sha256,
  verified = undefined,
) {
  const encoder = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const refuses = (fn, label) => {
    let refused = false;
    try {
      fn();
    } catch (e) {
      if (!String(e?.message ?? e).includes("invalid_request")) throw e;
      refused = true;
    }
    if (!refused) fail(`${label} was not refused`);
  };
  const limits = Float64Array.from([8 << 20, 1 << 20, 8 << 20, 64, 64]);
  const build = (bytes, host) => {
    const upload = new core.ProfileCatalogUpload(bytes.length, limits);
    try {
      for (let p = 0; p < bytes.length; p += 65536) upload.append(p, bytes.subarray(p, p + 65536));
      return upload.build(host);
    } finally {
      upload.free();
    }
  };
  const catalogs = {
    bundled: build(bundledBytes, collator),
    synthetic: build(encoder.encode(fixture.syntheticCatalogJson), collator),
  };
  const counts = { replies: 0, refusals: 0, commits: 0, undone: 0 };
  /** A reply pinned by its text, or by the SHA-256 and UTF-16 length of its text. */
  const pinned = async (reply, entry, label) => {
    if ("replyJson" in entry) return eq(reply, entry.replyJson, label);
    eq(reply.length, entry.replyLength, `${label} length`);
    eq(await sha256(encoder.encode(reply)), entry.replySha256, label);
  };
  try {
    for (const [i, c] of fixture.choices.entries()) {
      eq(catalogs[c.catalog].slicing_choices(c.requestJson), c.replyJson, `choices ${i}`);
      counts.replies++;
    }
    for (const [i, c] of fixture.matches.entries()) {
      eq(core.slicing_match(c.requestJson), c.replyJson, `match ${i}`);
      counts.replies++;
    }
    for (const [i, c] of fixture.selections.entries()) {
      const catalog = catalogs[c.catalog];
      const reply =
        c.kind === "ids"
          ? catalog.slicing_select(c.requestJson)
          : c.kind === "names"
            ? catalog.slicing_select_by_names(c.requestJson)
            : catalog.slicing_default(c.requestJson);
      eq(reply, c.replyJson, `selection ${i}`);
      counts.replies++;
    }
    const configurations = [];
    for (const [i, c] of fixture.configurations.entries()) {
      const request = JSON.stringify({ live: c.live, stateJson: fixture.states[c.state] });
      const reply = catalogs[c.catalog].slicing_configuration(request);
      await pinned(reply, c, `configuration ${i}`);
      configurations.push(JSON.parse(reply));
      verified?.configurations.push(reply);
      counts.replies++;
    }
    const nextStates = [];
    for (const [i, c] of fixture.nextStates.entries()) {
      const stateJson = "state" in c ? fixture.states[c.state] : nextStates[c.after].stateJson;
      const configurationJson =
        "configuration" in c ? configurations[c.configuration].configurationJson : c.configurationJson;
      const request = JSON.stringify({ autoPairs: c.autoPairs, configurationJson, stateJson });
      const reply = core.slicing_next_state(request, Float64Array.from(c.words));
      await pinned(reply, c, `next state ${i}`);
      nextStates.push(JSON.parse(reply));
      verified?.nextStates.push(reply);
      counts.replies++;
    }
    const exchanges = {
      choices: (r) => catalogs.bundled.slicing_choices(r),
      match: (r) => core.slicing_match(r),
      select: (r) => catalogs.bundled.slicing_select(r),
      names: (r) => catalogs.bundled.slicing_select_by_names(r),
      default: (r) => catalogs.bundled.slicing_default(r),
      configuration: (r) => catalogs.bundled.slicing_configuration(r),
      next: (r) => core.slicing_next_state(r, new Float64Array(0)),
    };
    for (const [i, r] of fixture.refusals.entries()) {
      refuses(() => exchanges[r.exchange](r.requestJson), `refusal ${i}`);
      counts.refusals++;
    }
    for (const [i, c] of fixture.commits.entries()) {
      const label = `commit ${i}`;
      const source = encoder.encode(fixture.states[c.state]);
      const options = {
        documentBytes: source.length,
        documentNodes: 1_000_000,
        documentTextUnits: 2_000_000,
        numberBytes: 1024,
        depth: 128,
        assets: 0,
        assetBytes: 16 * 1024 * 1024,
        totalAssetBytes: 32 * 1024 * 1024,
        historyEntries: 16,
        historyBytes: 64 * 1024 * 1024,
      };
      const upload = new core.ProjectUpload(layout.version, source.length, Float64Array.from(layout.options.map((k) => options[k])));
      try {
        for (let p = 0; p < source.length; p += layout.maxChunkBytes)
          upload.append_document(p, source.subarray(p, p + layout.maxChunkBytes));
        upload.seal_document();
      } catch (e) {
        upload.free();
        throw e;
      }
      const generation = [1, 2, 3, 4];
      const session = upload.open(Float64Array.from(generation));
      let sequence = 0;
      const submit = (operation) => {
        const reply =
          session.submit(JSON.stringify({ protocolVersion: 1, generation, requestId: ++sequence, operation })) ??
          session.run_next();
        return JSON.parse(reply.wire()).result;
      };
      const hash = () => {
        const snapshot = session.snapshot();
        try {
          return snapshot.hash();
        } finally {
          snapshot.free();
        }
      };
      try {
        if (!submit({ hello: { minProtocolVersion: 1, maxProtocolVersion: 1, projectSchemaVersion: 1, intentVersion: 1 } }).welcome)
          fail(`${label} hello`);
        session.configure_staging(stagingVersion, Float64Array.from([4, 4, 64_000_000, 0]));
        const before = hash();
        const request = JSON.stringify({ autoPairs: c.autoPairs, live: c.live });
        const reply = session.stage_slicing_configuration(catalogs[c.catalog], request, Float64Array.from(c.words));
        const expected = JSON.parse(c.expectedJson);
        if (!("stateHash" in expected)) {
          eq(reply, c.expectedJson, label);
          eq(hash(), before, `${label} untouched`);
          continue;
        }
        const staged = JSON.parse(reply).staged;
        if (typeof staged !== "number") fail(`${label}: ${reply}`);
        const result = submit({ executeStaged: { stagedId: staged } });
        if (result.acknowledged?.changed !== true) fail(`${label}: ${JSON.stringify(result)}`);
        eq(hash(), expected.stateHash, `${label} state`);
        const history = session.history();
        try {
          eq(
            String.fromCharCode(...history.label_text(true, 0, history.label_length(true))),
            "Update slicing configuration",
            `${label} undo label`,
          );
        } finally {
          history.free();
        }
        counts.commits++;
        const guard = submit({ query: {} }).acknowledged.guard;
        if (!("acknowledged" in submit({ undo: guard }))) fail(`${label} undo`);
        eq(hash(), before, `${label} undone`);
        counts.undone++;
      } finally {
        session.free();
      }
    }
  } finally {
    for (const catalog of Object.values(catalogs)) catalog.free();
  }
  return {
    slicingConfigurationAnswers: [counts.replies, counts.refusals, counts.commits, counts.undone, fixture.commits.length],
  };
}
