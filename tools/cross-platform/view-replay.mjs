// Binding qualification harness, not the production browser adapter.
export async function replayViews(GcodeSession) {
  const corpus = await (await fetch("/view-vectors.json")).json();
  const layout = await (await fetch("/gcode-view-buffer.json")).json();
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
  };
  const same = (a, b, path) => {
    if (a && typeof a === "object") {
      check(b && typeof b === "object", path);
      check(
        JSON.stringify(Object.keys(a).sort()) ===
          JSON.stringify(Object.keys(b).sort()),
        path + ":keys",
      );
      for (const key of Object.keys(a)) same(a[key], b[key], path + "." + key);
    } else check(a === b, path + `: ${a} != ${b}`);
  };
  const decode = (bytes) => {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const word = (i) => data.getUint32(i, true);
    check(
      bytes.length >= 32 &&
        bytes.length <= layout.maxPacketBytes &&
        word(0) === 0x5647584f &&
        word(4) === layout.version,
      "view packet identity",
    );
    const kind = word(8),
      n = word(12),
      counts = [word(16), word(20), word(24)];
    check(
      n >= 2 &&
        n <= layout.maxMetadataBytes &&
        32 + n <= bytes.length &&
        word(28) === bytes.length,
      "view packet size",
    );
    check(
      counts[0] <= layout.maxRecords &&
        counts[1] <= layout.maxLayers &&
        counts[2] <= layout.maxTicks,
      "view counts",
    );
    check(kind === 2 || (counts[1] === 0 && counts[2] === 0), "unused counts");
    const descriptor = Object.values(layout.kinds).find((k) => k.id === kind);
    check(descriptor, "unknown view kind");
    const columns = {};
    let offset = (32 + n + 3) & ~3;
    for (const [name, type, counter, factor] of descriptor.fields) {
      const count =
          counts[["records", "layers", "ticks"].indexOf(counter)] * factor,
        size = type === "u8" ? 1 : 4;
      check(offset + count * size <= bytes.length, "view column overflow");
      const values = Array.from({ length: count }, (_, i) =>
        size === 1 ? data.getUint8(offset + i) : word(offset + 4 * i),
      );
      columns[name] = type === "f32" ? { $f32: values } : values;
      offset = (offset + count * size + 3) & ~3;
    }
    check(offset === bytes.length, "view trailing data");
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(32, 32 + n),
      ),
    );
    if (kind === 3) return columns.recordIndices;
    if (kind === 1) {
      if (value.status === "ready")
        Object.assign(value, { count: counts[0] }, columns);
      else check(counts[0] === 0, "unsupported projection columns");
      return value;
    }
    value.recordIndices = columns.recordIndices;
    value.layers = {
      count: counts[1],
      layerIds: columns.layerIds,
      zMm: columns.layerZMm,
      firstRecord: columns.layerFirstRecord,
      lastRecord: columns.layerLastRecord,
    };
    const labels = value.tickLabels;
    delete value.tickLabels;
    const floats = new Float32Array(
      new Uint32Array(columns.tickZMm.$f32).buffer,
    );
    value.ticks = Array.from({ length: counts[2] }, (_, i) => {
      const kind = layout.tickKinds[columns.tickKind[i]],
        record = columns.tickRecord[i];
      check(
        kind && typeof labels[columns.tickLabel[i]] === "string",
        "invalid tick",
      );
      return {
        id: `${kind}:${record}`,
        kind,
        label: labels[columns.tickLabel[i]],
        record,
        layer: columns.tickLayer[i],
        zMm: floats[i],
        sourceLine: columns.tickSourceLine[i],
        sourceStartOffset: columns.tickStartOffset[i],
        sourceEndOffset: columns.tickEndOffset[i],
      };
    });
    return value;
  };
  let views = 0,
    failures = 0,
    bytes = 0;
  for (const vector of corpus.vectors) {
    const owner = new GcodeSession(
      1,
      vector.sourceUnits.length,
      JSON.stringify(vector.options),
    );
    try {
      for (let offset = 0; offset < vector.sourceUnits.length; offset += 4093)
        owner.append(
          offset,
          new Uint16Array(vector.sourceUnits.slice(offset, offset + 4093)),
        );
      owner.seal();
      for (const [i, view] of vector.views.entries()) {
        let output, error;
        try {
          output = owner.view(JSON.stringify(view.request));
        } catch (e) {
          error = String(e);
        }
        const id = `${vector.id}.view${i}`;
        if (view.error) {
          check(error === view.error, id + ":error " + error);
          failures++;
        } else {
          check(!error, id + ":unexpected " + error);
          same(decode(output), view.expected, id);
          bytes += output.length;
        }
        views++;
      }
    } finally {
      owner.free();
    }
  }
  const owner = new GcodeSession(1, 0, "{}");
  let owned;
  const request = {
    version: 1,
    operation: "inspection",
    window: [],
    request: {},
  };
  try {
    owner.seal();
    owned = owner.view(JSON.stringify(request));
    for (const invalid of [
      "null",
      JSON.stringify({ ...request, window: [1, 0] }),
      JSON.stringify({ ...request, window: undefined }),
      JSON.stringify({ ...request, request: { gcodeSource: "other" } }),
      JSON.stringify({ ...request, extra: true }),
    ]) {
      let error;
      try {
        owner.view(invalid);
      } catch (e) {
        error = String(e);
      }
      check(error === "invalid_request", "malformed request accepted");
    }
    let error;
    try {
      owner.view(JSON.stringify({ ...request, version: 99 }));
    } catch (e) {
      error = String(e);
    }
    check(error === "unsupported_protocol", "future request accepted");
  } finally {
    owner.free();
  }
  check(
    decode(owned).sourceRecordCount === 0,
    "view invalid after session disposal",
  );
  return {
    metrics: {
      sources: corpus.vectors.length,
      views,
      rejections: failures,
      packetBytes: bytes,
    },
    owned,
  };
}
