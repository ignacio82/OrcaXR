// Mesh renderer packets through a binding: open the browser-authored project
// with every asset as a real session, request each packet of the browser's
// script and page its bytes — comparing every reply with the TypeScript
// authority's own encoding and the bytes by SHA-256 (`sha256` resolves a hex
// digest), and refusing a page past the end. Runs unchanged over WASM in
// Node and a browser worker, and over the JNI bridge.
export async function replayMeshPackets(core, fixture, layout, sha256) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const refuses = (call, label) => {
    let refused = false;
    try {
      call();
    } catch {
      refused = true;
    }
    if (!refused) fail(`${label} was not refused`);
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
  const session = upload.open(Float64Array.from([1, 2, 3, 4]));
  const counts = { prepared: 0, refused: 0, chunks: 0, bytes: 0 };
  const page = 16 * 1024 * 1024;
  try {
    for (const [i, step] of fixture.steps.entries()) {
      const label = `step ${i}`;
      const packet = session.mesh_packet(step.request);
      try {
        const reply = packet.reply();
        eq(reply, step.reply, label);
        const decoded = JSON.parse(reply);
        if (!("prepared" in decoded)) {
          refuses(() => packet.bytes(0, 1), `${label} bytes`);
          counts.refused++;
          continue;
        }
        const { byteLength, chunkCount } = decoded.prepared;
        const all = new Uint8Array(byteLength);
        for (let at = 0; at < byteLength; at += page)
          all.set(packet.bytes(at, Math.min(page, byteLength - at)), at);
        eq(await sha256(all), step.bytes, `${label} bytes`);
        if ("window" in step)
          eq(await sha256(packet.bytes(16, 64)), step.window, `${label} window`);
        refuses(() => packet.bytes(byteLength, 1), `${label} past the end`);
        counts.prepared++;
        counts.chunks += chunkCount;
        counts.bytes += byteLength;
      } finally {
        packet.free();
      }
    }
  } finally {
    session.free();
  }
  return {
    meshPacketsPrepared: counts.prepared,
    meshPacketsRefused: counts.refused,
    meshPacketChunks: counts.chunks,
    meshPacketBytes: counts.bytes,
  };
}
