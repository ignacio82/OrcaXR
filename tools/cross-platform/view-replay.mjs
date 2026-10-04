// Binding qualification harness, not the production browser adapter.
import {
  decodeGcodeModel,
  decodeGcodePreview,
  decodeGcodeInspection,
  decodeGcodePlayback,
} from "/gcode-packets.mjs";
import { packetSnapshot } from "/packet-snapshot.mjs";
import { CoreGcodeSource } from "/gcode-source.mjs";
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
  const text = (units) => {
    let value = "";
    for (let i = 0; i < units.length; i += 8192)
      value += String.fromCharCode(...units.slice(i, i + 8192));
    return value;
  };
  const hostRequest = (wire) => {
    const request = { ...wire };
    for (const key of [
      "roleVisibility",
      "toolVisibility",
      "eventVisibility",
      "recordVisibility",
    ])
      if (request[key] !== undefined)
        request[key] = new Uint8Array(request[key]);
    if (request.layerTimes)
      request.layerTimes = {
        secondsByLayer: new Float32Array(
          new Uint32Array(request.layerTimes.secondsByLayerBits).buffer,
        ),
        provenance: text(request.layerTimes.provenance),
      };
    return request;
  };
  let views = 0,
    hostViews = 0,
    failures = 0,
    bytes = 0;
  for (const vector of corpus.vectors) {
    const owner = new GcodeSession(
      1,
      vector.sourceUnits.length,
      JSON.stringify(vector.options),
    );
    let host;
    try {
      const options = { ...vector.options };
      if (options.filamentColors)
        options.filamentColors = options.filamentColors.map(text);
      host = new CoreGcodeSource(
        GcodeSession,
        text(vector.sourceUnits),
        options,
      );
      const entries = [...host.entries()];
      check(
        entries.length === host.index.entryCount,
        vector.id + ": host pagination",
      );
      for (let offset = 0; offset < vector.sourceUnits.length; offset += 4093)
        owner.append(
          offset,
          new Uint16Array(vector.sourceUnits.slice(offset, offset + 4093)),
        );
      owner.seal();
      let selected, model, frame;
      for (const [i, view] of vector.views.entries()) {
        const selector = JSON.stringify(view.request.window);
        if (selector !== selected) {
          frame = host.openWindow(view.request.window);
          model = decodeGcodeModel(
            view.request.window.length
              ? owner.window(...view.request.window)
              : owner.whole(),
          );
          selected = selector;
        }
        let output, error;
        try {
          output = owner.view(JSON.stringify(view.request));
        } catch (e) {
          error = String(e);
        }
        const id = `${vector.id}.view${i}`;
        let hostOutput, hostError;
        try {
          const request = hostRequest(view.request.request);
          hostOutput =
            view.request.operation === "preview"
              ? frame.project(request)
              : view.request.operation === "inspection"
                ? frame.inspect(request, view.request.includeSource ?? false)
                : frame.playback(
                    request,
                    view.request.playback,
                    view.request.includeSource ?? false,
                  );
        } catch (error) {
          hostError = error;
        }
        if (view.error)
          check(
            hostError !== undefined,
            id + ": host accepted invalid request",
          );
        else {
          check(
            hostError === undefined,
            id + ": host failed: " + hostError?.stack,
          );
          same(packetSnapshot(hostOutput), view.expected, id + ".source-owner");
        }
        hostViews++;
        if (view.error) {
          check(error === view.error, id + ":error " + error);
          failures++;
        } else {
          check(!error, id + ":unexpected " + error);
          same(decode(output), view.expected, id);
          try {
            const decoded =
              view.request.operation === "preview"
                ? decodeGcodePreview(output, model)
                : view.request.operation === "inspection"
                  ? decodeGcodeInspection(output, model)
                  : decodeGcodePlayback(output, model);
            same(packetSnapshot(decoded), view.expected, id + ".host-decoder");
          } catch (error) {
            throw new Error(id + ".host-decoder: " + error.stack);
          }
          bytes += output.length;
        }
        views++;
      }
      const saved = structuredClone(frame.model, {
        transfer: [frame.model.columns.kind.buffer],
      });
      check(
        saved.sourceLength === vector.sourceUnits.length,
        vector.id + ": transferred model identity",
      );
      let transferred = false;
      try {
        frame.inspect();
      } catch {
        transferred = true;
      }
      check(transferred, vector.id + ": reused a detached host frame");
      const fresh = host.openWindow(frame.window);
      check(
        fresh.model.columns.count === saved.columns.count,
        vector.id + ": frame reopen",
      );
      fresh.inspect();
      host.dispose();
      host.dispose();
      let closed = false;
      try {
        frame.inspect();
      } catch {
        closed = true;
      }
      check(closed, vector.id + ": host accepted query after disposal");
    } finally {
      host?.dispose();
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
  const malformed = verifyMalformedPackets(GcodeSession, layout, check);
  return {
    metrics: {
      sources: corpus.vectors.length,
      views,
      hostViews,
      rejections: failures,
      packetBytes: bytes,
      malformedHostPackets: malformed,
    },
    owned,
  };
}

function verifyMalformedPackets(GcodeSession, layout, check) {
  const source = "M83\nG1 X1 E1 F600\nT1\n; PAUSE_PRINTING\r\n";
  const owner = new GcodeSession(1, source.length, "{}");
  let checked = 0;
  let released = false;
  try {
    owner.append(
      0,
      Uint16Array.from(source, (c) => c.charCodeAt(0)),
    );
    owner.seal();
    const model = decodeGcodeModel(owner.whole());
    const request = (operation, request, extra = {}) =>
      owner.view(
        JSON.stringify({
          version: 1,
          window: [],
          operation,
          request,
          ...extra,
        }),
      );
    const preview = request("preview", { mode: "Feedrate" });
    const inspection = request(
      "inspection",
      { showToolMarker: true },
      { includeSource: true },
    );
    const playback = request(
      "playback",
      {},
      { playback: { direction: 1, includeCurrent: true, wrap: true } },
    );
    const assertInvalid = (bytes, decode) => {
      let rejected = false;
      try {
        decode(bytes, model);
      } catch {
        rejected = true;
      }
      check(rejected, "Malformed host view packet accepted");
      checked++;
    };
    const metadata = (bytes, mutate) => {
      const header = new DataView(bytes.buffer),
        n = header.getUint32(12, true);
      const value = JSON.parse(
        new TextDecoder().decode(bytes.subarray(32, 32 + n)),
      );
      mutate(value);
      const json = new TextEncoder().encode(JSON.stringify(value));
      const before = (32 + n + 3) & ~3,
        after = (32 + json.length + 3) & ~3;
      const changed = new Uint8Array(after + bytes.length - before),
        data = new DataView(changed.buffer);
      changed.set(bytes.subarray(0, 32));
      data.setUint32(12, json.length, true);
      data.setUint32(28, changed.length, true);
      changed.set(json, 32);
      changed.set(bytes.subarray(before), after);
      return changed;
    };
    const field = (bytes, name, bits) => {
      const changed = bytes.slice(),
        data = new DataView(changed.buffer);
      const counts = {
        records: data.getUint32(16, true),
        layers: data.getUint32(20, true),
        ticks: data.getUint32(24, true),
      };
      let offset = (32 + data.getUint32(12, true) + 3) & ~3;
      const fields = Object.values(layout.kinds).find(
        (k) => k.id === data.getUint32(8, true),
      ).fields;
      for (const [key, type, counter, factor] of fields) {
        const size = type === "u8" ? 1 : 4;
        if (key === name) {
          check(counts[counter] > 0, "Mutation fixture needs a record");
          if (size === 1) data.setUint8(offset, bits);
          else data.setUint32(offset, bits, true);
          return changed;
        }
        offset = (offset + counts[counter] * factor * size + 3) & ~3;
      }
      throw new Error("Mutation field missing");
    };
    for (const mutate of [
      (m) => {
        m.extra = true;
      },
      (m) => {
        m.mode.label = "other";
      },
      (m) => {
        m.sourceRecordCount++;
      },
      (m) => {
        m.range.min = m.range.max + 1;
      },
      (m) => {
        m.legend[0].color[0] = null;
      },
    ])
      assertInvalid(metadata(preview, mutate), decodeGcodePreview);
    for (const [name, bits] of [
      ["recordIndices", 0xffffffff],
      ["valueValid", 2],
      ["values", 0x7f800000],
      ["colorsRgba", 0x7fc00000],
    ])
      assertInvalid(field(preview, name, bits), decodeGcodePreview);
    for (const mutate of [
      (m) => {
        m.current = null;
      },
      (m) => {
        m.current.ordinal = 999;
      },
      (m) => {
        m.current.positionMm[0] += 1;
      },
      (m) => {
        m.moveSelection.firstRecord = 999;
      },
      (m) => {
        m.layerSelection = null;
      },
      (m) => {
        m.toolMarker.record = 999;
      },
      (m) => {
        m.sourceWindow.lines[0].text = [65536];
      },
      (m) => {
        m.sourceWindow.currentLine++;
      },
      (m) => {
        m.sourceWindow.lines[0].number++;
      },
    ])
      assertInvalid(metadata(inspection, mutate), decodeGcodeInspection);
    for (const [name, bits] of [
      ["tickKind", 3],
      ["tickLabel", 0xffffffff],
      ["tickRecord", 0xffffffff],
      ["tickSourceLine", 0],
      ["layerFirstRecord", 0xffffffff],
      ["layerZMm", 0x7f800000],
    ])
      assertInvalid(field(inspection, name, bits), decodeGcodeInspection);
    assertInvalid(
      metadata(playback, (m) => {
        m.extra = true;
      }),
      decodeGcodePlayback,
    );
    assertInvalid(
      field(playback, "recordIndices", 0xffffffff),
      decodeGcodePlayback,
    );
    // Corrupting an independent transfer cannot change its immutable source or
    // future results, and the valid packet remains readable after disposal.
    owner.free();
    released = true;
    decodeGcodePreview(preview, model);
    decodeGcodeInspection(inspection, model);
    decodeGcodePlayback(playback, model);
    return checked;
  } finally {
    if (!released) owner.free();
  }
}
