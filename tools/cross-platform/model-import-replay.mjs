// Model import through an actual project binding (WASM or the JNI bridge),
// replayed against the production browser's transaction corpus
// (model-transaction-vectors.json): identical previews, confirmation refusals,
// committed state, ID-ordered assets and history, and undo/redo through the
// session wire protocol. Runs unchanged in Node, a browser worker and the JVM.
export async function replayModelImports(core, hostLayout, modelLayout, corpus, staging, decoding, sha256, readPath, base64) {
  const encode = new TextEncoder();
  const decode = new TextDecoder("utf-8", { fatal: true });
  const units = (text) => Uint16Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  const fromUnits = (value) => (typeof value === "string" ? value : String.fromCharCode(...value));
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
  };
  const rows = new Map(decoding.cases.map((c) => [c.name, c]));
  const bytesOf = (row) => (row.bytesBase64 ? base64(row.bytesBase64) : readPath(row.path));
  const optionsOf = (row) =>
    Float64Array.from(modelLayout.options.map((key, i) => row.limits?.[key] ?? modelLayout.defaults[i]));
  const importedAt = units(corpus.importedAt);
  const chunks = (total, size, each) => {
    for (let p = 0; p < total; p += size) each(p, Math.min(size, total - p));
  };
  const read = (owner, length, chunk) => {
    const out = new Uint8Array(length);
    chunks(length, chunk, (p, n) => out.set(owner.read(p, n), p));
    return out;
  };
  const hostOptions = (bytes) =>
    Float64Array.from([bytes, 1_000_000, 8_000_000, 1024, 128, 4096, 512 * 2 ** 20, 2 ** 31, 100, 64 * 2 ** 20]);

  /** A session holding `stateJson` and asset payloads in declaration order. */
  const open = (stateJson, assets) => {
    const bytes = encode.encode(stateJson);
    let upload = new core.ProjectUpload(hostLayout.version, bytes.length, hostOptions(bytes.length));
    try {
      chunks(bytes.length, hostLayout.maxChunkBytes, (p, n) => upload.append_document(p, bytes.subarray(p, p + n)));
      upload.seal_document();
      const byId = new Map(assets.map((a) => [a.id, a.bytes]));
      for (const [i, declared] of JSON.parse(stateJson).sourceAssets.entries()) {
        const payload = byId.get(declared.id);
        check(upload.begin_asset(i) === payload.length, "asset length");
        chunks(payload.length, hostLayout.maxChunkBytes, (p, n) => upload.append_asset(p, payload.subarray(p, p + n)));
        upload.finish_asset();
      }
      const owned = upload;
      upload = undefined;
      return owned.open(Float64Array.from([0, 1, 2, 3]));
    } finally {
      upload?.free();
    }
  };
  const stateJson = (owner) => {
    const capture = owner.snapshot();
    try {
      const exported = capture.export_json(512 * 2 ** 20);
      try {
        return decode.decode(read(exported, exported.length(), hostLayout.maxChunkBytes));
      } finally {
        exported.free();
      }
    } finally {
      capture.free();
    }
  };
  const stateRecord = async (json) =>
    json.length <= 64 * 1024 ? { stateJson: json } : { stateSha256: await sha256(encode.encode(json)) };
  /** Asset descriptors and payloads, ID-ordered like the browser's list(). */
  const assets = async (owner) => {
    const declared = JSON.parse(stateJson(owner)).sourceAssets;
    const out = [];
    for (let i = 0; i < declared.length; i++) {
      const asset = owner.asset(i);
      try {
        const metadata = asset.metadata(1 << 20);
        let descriptorJson;
        try {
          descriptorJson = decode.decode(read(metadata, metadata.length(), hostLayout.maxChunkBytes));
        } finally {
          metadata.free();
        }
        const bytes = read(asset, asset.length(), hostLayout.maxChunkBytes);
        out.push({ id: declared[i].id, bytes, descriptorJson, bytesSha256: await sha256(bytes) });
      } finally {
        asset.free();
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };
  const assetRecord = (list) => list.map(({ descriptorJson, bytesSha256 }) => ({ descriptorJson, bytesSha256 }));
  const history = (owner) => {
    const h = owner.history();
    try {
      const label = (undo) =>
        h.has_label(undo) ? fromUnits(Array.from(h.label_text(undo, 0, h.label_length(undo)))) : undefined;
      const value = {
        dirtyCategories: h.dirty_categories() ? h.dirty_categories().split(",") : [],
        redoCount: h.redo_count(),
        ...(label(false) === undefined ? {} : { redoLabel: label(false) }),
        undoCount: h.undo_count(),
        ...(label(true) === undefined ? {} : { undoLabel: label(true) }),
      };
      return JSON.stringify(value);
    } finally {
      h.free();
    }
  };
  let requestId = 0;
  const wire = (owner, operation) => {
    const request = { protocolVersion: 1, generation: [0, 1, 2, 3], requestId: ++requestId, operation };
    let reply = owner.submit(JSON.stringify(request));
    reply ??= owner.run_next();
    try {
      return JSON.parse(reply.wire());
    } finally {
      reply.free();
    }
  };
  const connect = (owner) =>
    wire(owner, { hello: { minProtocolVersion: 1, maxProtocolVersion: 1, projectSchemaVersion: 1, intentVersion: 1 } });
  const guard = (owner) => wire(owner, { query: {} }).result.acknowledged.guard;
  const historyStep = (owner, operation) => {
    const reply = wire(owner, { [operation]: guard(owner) });
    check(reply.result.acknowledged, `${operation}: ${JSON.stringify(reply.result)}`);
  };
  const placement = (name) => staging.placements[name] ?? {};

  /** Stage `row` into `owner`; returns the preview handle or an error string. */
  const prepare = (owner, row, place, namespace) => {
    const base = owner.capture_import_base();
    try {
      const bytes = bytesOf(row);
      const upload = new core.ProjectModelUpload(modelLayout.version, bytes.length, optionsOf(row));
      chunks(bytes.length, modelLayout.maxChunkBytes, (p, n) => upload.append(p, bytes.subarray(p, p + n)));
      try {
        return base.prepare_model(
          upload,
          units(fromUnits(row.filename)),
          importedAt,
          // The printable area as `[xMin, yMin, xMax, yMax]`, or none.
          Float64Array.from(place.bedAreaMm ? [place.bedAreaMm.xMin, place.bedAreaMm.yMin, place.bedAreaMm.xMax, place.bedAreaMm.yMax] : []),
          place.dropToBed === true,
          new Uint8Array(0),
          namespace,
        );
      } catch (error) {
        return String(error);
      }
    } finally {
      base.free();
    }
  };
  const previewJson = (preview) => decode.decode(read(preview, preview.length(), modelLayout.maxChunkBytes));
  const commit = (owner, preview, acknowledged) => {
    try {
      owner.commit_import(preview, acknowledged).free();
      return null;
    } catch (error) {
      return String(error);
    }
  };

  const empty = { stateJson: staging.bases.empty, assets: [] };
  const secondActive = { stateJson: staging.bases["second-active"], assets: [] };
  // The holding base is the committed cube import, as the browser builds it.
  const holding = await (async () => {
    const owner = open(empty.stateJson, []);
    try {
      const preview = prepare(owner, rows.get("stl-binary/cube"), placement("bed"), "base");
      check(typeof preview !== "string", `holding: ${preview}`);
      check(commit(owner, preview, JSON.parse(previewJson(preview)).requiredAcknowledgementIds) === null, "holding commit");
      preview.free();
      return { stateJson: stateJson(owner), assets: (await assets(owner)).map(({ id, bytes }) => ({ id, bytes })) };
    } finally {
      owner.free();
    }
  })();
  const bases = { empty, holding, "second-active": secondActive };

  const counts = { cases: 0, committed: 0, refused: 0 };
  for (const c of corpus.cases) {
    counts.cases++;
    const row = rows.get(c.decode);
    const base = bases[c.base];
    const expected = c.expected;
    if (c.cancelled) {
      // Cancellation is the host dropping the candidate; nothing remains.
      check(JSON.stringify(expected.commitError) === '["ImportCancelledError"]', `${c.name}: cancellation`);
      counts.refused++;
      continue;
    }
    const owner = open(base.stateJson, base.assets);
    try {
      const preview = prepare(owner, row, placement(c.placement), c.namespace);
      if (typeof preview === "string") {
        check(expected.prepareError === "ImportPreparationError", `${c.name}: prepare ${preview}`);
        counts.refused++;
        continue;
      }
      try {
        if (c.stale) {
          connect(owner);
          const plate = JSON.parse(stateJson(owner)).plates[0].id;
          const reply = wire(owner, {
            execute: {
              guard: guard(owner),
              intent: { version: 1, command: { renamePlate: { plateId: Array.from(units(plate)), name: Array.from(units("Edited meanwhile")) } } },
            },
          });
          check(reply.result.acknowledged, `${c.name}: rename`);
          const required = JSON.parse(previewJson(preview)).requiredAcknowledgementIds;
          check(String(commit(owner, preview, required)).includes("stale"), `${c.name}: stale`);
          check(history(owner) === expected.history, `${c.name}: stale history`);
          check(JSON.stringify(await stateRecord(stateJson(owner))) === JSON.stringify(expected.state), `${c.name}: stale state`);
          counts.refused++;
          continue;
        }
        const json = previewJson(preview);
        check(json === expected.preview, `${c.name}: preview`);
        const required = JSON.parse(json).requiredAcknowledgementIds;
        const before = stateJson(owner);
        // The browser reports a blocked preview before missing acknowledgements.
        const refusal = (error) =>
          String(error).includes("import_blocked")
            ? '["ImportConfirmationError",[]]'
            : String(error).includes("missing_acknowledgements")
              ? JSON.stringify(["ImportConfirmationError", required])
              : String(error);
        if (required.length > 0) {
          const refused = commit(owner, preview, []);
          check(refusal(refused) === JSON.stringify(expected.unacknowledged), `${c.name}: unacknowledged ${refused}`);
        }
        const result = commit(owner, preview, required);
        if (result !== null) {
          check(refusal(result) === JSON.stringify(expected.commitError), `${c.name}: ${result}`);
          counts.refused++;
          continue;
        }
        const committed = stateJson(owner);
        check(
          JSON.stringify({ ...(await stateRecord(committed)), assets: assetRecord(await assets(owner)), history: history(owner) }) ===
            JSON.stringify(expected.committed),
          `${c.name}: committed`,
        );
        connect(owner);
        historyStep(owner, "undo");
        check(
          JSON.stringify({ restoresBase: stateJson(owner) === before, assets: assetRecord(await assets(owner)), history: history(owner) }) ===
            JSON.stringify(expected.undone),
          `${c.name}: undo`,
        );
        historyStep(owner, "redo");
        check(
          JSON.stringify({ restoresCommitted: stateJson(owner) === committed, history: history(owner) }) === JSON.stringify(expected.redone),
          `${c.name}: redo`,
        );
        counts.committed++;
      } finally {
        preview.free();
      }
    } finally {
      owner.free();
    }
  }
  // Malformed uploads are refused before any decode work.
  const refuses = (fn, label) => {
    try {
      fn();
    } catch {
      return;
    }
    throw new Error(label);
  };
  const defaults = Float64Array.from(modelLayout.defaults);
  refuses(() => new core.ProjectModelUpload(modelLayout.version + 1, 10, defaults), "version");
  refuses(() => new core.ProjectModelUpload(modelLayout.version, 10, defaults.subarray(1)), "options shape");
  const tight = Float64Array.from(defaults);
  tight[0] = 4;
  refuses(() => new core.ProjectModelUpload(modelLayout.version, 5, tight), "byte budget");
  const unsized = new core.ProjectModelUpload(modelLayout.version, undefined, tight);
  unsized.append(0, new Uint8Array(4));
  refuses(() => unsized.append(4, new Uint8Array(1)), "open-ended byte budget");
  unsized.free();
  return counts;
}
