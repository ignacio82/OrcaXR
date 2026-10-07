// Browser-compatible replay of bounded projections against independent TS data.
export function replayProjectQueries(
  core,
  fixture,
  layout,
  validatePacket = () => {},
) {
  const eq = (actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error("Project query mismatch");
  };
  let queryCaptures = 0,
    queryNodes = 0,
    queryPages = 0,
    queryRefusals = 0,
    engineRefusals = 0;
  const refuses = (work) => {
    try {
      work();
    } catch {
      queryRefusals++;
      return;
    }
    throw Error("Expected query refusal");
  };
  let ownedQueryText, ownedQueryExpected;
  for (const c of fixture.cases) {
    const state = JSON.parse(c.stateJson);
    const assets = state.sourceAssets.map((a) =>
      fixture.assets.find(
        (b) => b.digest === a.digest && b.bytes.length === a.byteLength,
      ),
    );
    if (assets.some((a) => !a)) continue; // Library-only metadata corpus has no attested payload for this case.
    // Admission delegates timestamps to this engine's Date.parse. The corpus is
    // generated under Node's 32-bit Smi date parser; Chromium's 31-bit parser
    // refuses some legacy offsets, so its own verdict is the oracle here.
    const engineRefuses = ![state.createdAt, state.updatedAt].every((t) =>
      Number.isFinite(Date.parse(t)),
    );
    const bytes = new TextEncoder().encode(c.stateJson);
    const upload = new core.ProjectUpload(
      1,
      bytes.length,
      new Float64Array([
        bytes.length,
        2_000_000,
        4_000_000,
        1024,
        128,
        1024,
        32 * 1024 * 1024,
        64 * 1024 * 1024,
        100,
        32 * 1024 * 1024,
      ]),
    );
    let session;
    try {
      for (let p = 0; p < bytes.length; p += 65536)
        upload.append_document(p, bytes.subarray(p, p + 65536));
      upload.seal_document();
      for (let i = 0; i < assets.length; i++) {
        eq(upload.begin_asset(i), assets[i].bytes.length);
        upload.append_asset(0, Uint8Array.from(assets[i].bytes));
        upload.finish_asset();
      }
      session = upload.open(new Float64Array([1, 2, 3, 4]));
    } catch (e) {
      upload.free();
      if (engineRefuses && String(e).includes("invalid_document")) {
        engineRefusals++;
        continue;
      }
      throw e;
    }
    if (engineRefuses) {
      session.free();
      throw Error("Admitted a timestamp this engine refuses");
    }
    const snapshot = session.snapshot(),
      revision = snapshot.revision(),
      hash = snapshot.hash();
    refuses(() => snapshot.query(layout.version + 1));
    const root = snapshot.query(layout.version);
    snapshot.free();
    session.free();
    const expected = new Map(c.nodes.map((n) => [JSON.stringify(n.path), n]));
    const identity = (owner) => {
      const copy = owner.snapshot();
      try {
        eq(copy.revision(), revision);
        eq(copy.hash(), hash);
      } finally {
        copy.free();
      }
    };
    function visit(node, path) {
      try {
        const reference = expected.get(JSON.stringify(path));
        if (!reference) throw Error("Unknown query path");
        const packet = node.metadata();
        eq(Array.from(packet), reference.packet);
        validatePacket(packet, false);
        identity(node);
        packet.fill(-1);
        eq(Array.from(node.metadata()), reference.packet);
        for (const [field, index] of Object.entries(reference.texts)) {
          const key = layout.texts.indexOf(field),
            text = index === null ? null : fixture.texts[index];
          eq(node.text_length(key), text === null ? -1 : text.length);
          if (text === null) {
            refuses(() => node.text(key, 0, 0));
            continue;
          }
          const actual = [];
          for (let p = 0; p < text.length; p += 997)
            actual.push(...node.text(key, p, Math.min(997, text.length - p)));
          eq(actual, text);
          eq(Array.from(node.text(key, text.length, 0)), []);
          refuses(() => node.text(key, 0, layout.maxTextChunkUnits + 1));
          refuses(() => node.text(key, text.length + 1, 0));
          if (!ownedQueryText && text.length) {
            ownedQueryText = node.text(key, 0, Math.min(997, text.length));
            ownedQueryExpected = text.slice(0, 997);
          }
        }
        refuses(() => node.text_length(layout.texts.length));
        for (const [relation, length] of Object.entries(reference.children)) {
          const key = Object.keys(layout.relations).indexOf(relation);
          if ((relation === "plates" || relation === "layerRanges") && length)
            refuses(() => node.children(key, length - 1));
          const list = node.children(key, Math.max(length, 1));
          identity(list);
          try {
            eq(list.count(), length);
            for (let start = 0; start < length; start += layout.maxPageRows) {
              const count = Math.min(layout.maxPageRows, length - start),
                wanted = [layout.version, length, start, count];
              for (let p = start; p < start + count; p++) {
                const row = expected.get(
                  JSON.stringify([...path, relation, p]),
                ).packet;
                wanted.push(row.length, ...row);
              }
              const packet = list.page(start, count);
              eq(Array.from(packet), wanted);
              validatePacket(packet, true);
              queryPages++;
              packet.fill(-1);
              eq(Array.from(list.page(start, count)), wanted);
            }
            eq(Array.from(list.page(length, 0)), [
              layout.version,
              length,
              length,
              0,
            ]);
            refuses(() => list.page(0, layout.maxPageRows + 1));
            refuses(() => list.node(length));
            refuses(() => list.page(length + 1, 0));
            for (let p = 0; p < length; p++)
              visit(list.node(p), [...path, relation, p]);
          } finally {
            list.free();
          }
        }
        queryNodes++;
      } finally {
        node.free();
      }
    }
    visit(root, []);
    queryCaptures++;
  }
  if (queryCaptures < 180 || queryNodes < 2000 || !ownedQueryText)
    throw Error("Incomplete project query binding corpus");
  eq(Array.from(ownedQueryText), ownedQueryExpected);
  return {
    queryCaptures,
    queryNodes,
    queryPages,
    queryRefusals,
    engineRefusals,
    ownedQueryText,
    ownedQueryExpected,
  };
}
