// Runs unchanged in Node and a real browser worker. Expectations are produced
// by the TypeScript authority, never by this binding or the Rust implementation.
export function projectReader(core, fixture, layout) {
  const encode = new TextEncoder(),
    decode = new TextDecoder("utf-8", { fatal: true });
  const normalize = (v) =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, normalize(v[k])]),
          )
        : v;
  const eq = (a, b, label = "project replay") => {
    if (JSON.stringify(normalize(a)) !== JSON.stringify(normalize(b)))
      throw Error(label);
  };
  const refuses = (fn, label) => {
    let rejected = false;
    try {
      fn();
    } catch {
      rejected = true;
    }
    if (!rejected) throw Error(label);
  };
  const bytes = (capture) => {
    try {
      const out = new Uint8Array(capture.length());
      for (let p = 0; p < out.length; p += layout.maxChunkBytes)
        out.set(
          capture.read(p, Math.min(layout.maxChunkBytes, out.length - p)),
          p,
        );
      return out;
    } finally {
      capture.free();
    }
  };
  const units = (length, read) => {
    const out = [];
    for (let p = 0; p < length; p += layout.maxTextChunkUnits)
      out.push(...read(p, Math.min(layout.maxTextChunkUnits, length - p)));
    return out;
  };
  const categories = (v) => (v === "" ? [] : v.split(","));
  const selection = (capture) => {
    try {
      const refs = Array.from({ length: capture.count() }, (_, i) => ({
        kind: layout.selectionKinds[capture.kind(i)],
        ...(capture.kind(i) === 0
          ? {}
          : { id: units(capture.id_length(i), (p, n) => capture.id(i, p, n)) }),
      }));
      return {
        refs,
        primary:
          capture.primary_index() === -1 ? null : refs[capture.primary_index()],
      };
    } finally {
      capture.free();
    }
  };
  const history = (capture) => {
    try {
      return {
        undoCount: capture.undo_count(),
        redoCount: capture.redo_count(),
        undoLabel: capture.has_label(true)
          ? units(capture.label_length(true), (p, n) =>
              capture.label_text(true, p, n),
            )
          : null,
        redoLabel: capture.has_label(false)
          ? units(capture.label_length(false), (p, n) =>
              capture.label_text(false, p, n),
            )
          : null,
        dirtyCategories: categories(capture.dirty_categories()),
      };
    } finally {
      capture.free();
    }
  };
  const snapshot = (capture) => {
    try {
      const value = decode.decode(bytes(capture.export_json(8 * 1024 * 1024)));
      const content = fixture.contents.indexOf(value);
      if (content < 0) throw Error("Complete canonical snapshot mismatch");
      const id = JSON.parse(value).id;
      eq(
        units(capture.id_length(), (p, n) => capture.id(p, n)),
        Array.from({ length: id.length }, (_, i) => id.charCodeAt(i)),
        "captured project ID",
      );
      return { revision: capture.revision(), hash: capture.hash(), content };
    } finally {
      capture.free();
    }
  };
  const effects = (capture) => {
    try {
      return Array.from({ length: capture.count() }, (_, i) => {
        const kind = layout.effects[capture.kind(i)];
        if (kind === "project")
          return {
            kind,
            previous: snapshot(capture.project(i, true)),
            current: snapshot(capture.project(i, false)),
            reason: units(capture.reason_length(i), (p, n) =>
              capture.reason(i, p, n),
            ),
            dirtyCategories: categories(capture.dirty_categories(i)),
          };
        if (kind === "selection")
          return {
            kind,
            previous: selection(capture.selection(i, true)),
            current: selection(capture.selection(i, false)),
          };
        return {
          kind,
          previous: history(capture.history(i, true)),
          current: history(capture.history(i, false)),
        };
      });
    } finally {
      capture.free();
    }
  };
  const observe = (session) => ({
    snapshot: snapshot(session.snapshot()),
    selection: selection(session.selection()),
    history: history(session.history()),
    historyRevision: session.history_revision(),
    assets: session.asset_fingerprint(),
  });
  return { encode, decode, eq, refuses, bytes, effects, snapshot, observe };
}
export async function replayProject(core, fixture, layout) {
  const { encode, decode, eq, refuses, bytes, effects, observe } =
    projectReader(core, fixture, layout);
  let requests = 0,
    groups = 0,
    owned;
  for (const trace of fixture.traces) {
    const source = encode.encode(trace.stateJson);
    const options = {
      documentBytes: source.length,
      documentNodes: 1_000_000,
      documentTextUnits: 2_000_000,
      numberBytes: 1024,
      depth: 128,
      assets: 100,
      assetBytes: 16 * 1024 * 1024,
      totalAssetBytes: 32 * 1024 * 1024,
      historyEntries: trace.options.maxEntries ?? 100,
      historyBytes: trace.options.maxEstimatedBytes ?? 32 * 1024 * 1024,
    };
    const upload = new core.ProjectUpload(
      layout.version,
      source.length,
      Float64Array.from(layout.options.map((k) => options[k])),
    );
    let session;
    try {
      refuses(
        () => upload.append_document(1, source.subarray(0, 1)),
        "out-of-order document chunk accepted",
      );
      for (let p = 0; p < source.length; p += 997)
        upload.append_document(p, source.subarray(p, p + 997));
      upload.seal_document();
      eq(upload.asset_count(), 1);
      const assetBytes = Uint8Array.from(trace.asset.bytes);
      eq(upload.begin_asset(0), assetBytes.length);
      for (let p = 0; p < assetBytes.length; p += 7)
        upload.append_asset(p, assetBytes.subarray(p, p + 7));
      upload.finish_asset();
    } catch (e) {
      upload.free();
      throw e;
    }
    session = upload.open(Float64Array.from(fixture.generation));
    const saved = new Map(),
      retained = [],
      asset = session.asset(0);
    try {
      eq(observe(session), trace.initial, trace.name + " initial");
      eq(
        decode.decode(bytes(asset.metadata(8 * 1024 * 1024))),
        trace.asset.descriptorJson,
        "full asset descriptor",
      );
      eq(
        Array.from(asset.read(0, asset.length())),
        trace.asset.bytes,
        "asset content",
      );
      for (const [groupIndex, group] of trace.steps.entries()) {
        groups++;
        const captured = session.snapshot();
        retained.push({
          capture: captured,
          expected: decode.decode(bytes(captured.export_json(8 * 1024 * 1024))),
        });
        const emitted = [],
          replies = [],
          pending = new Map(),
          hostOutcomes = [];
        const receive = (reply, slot) => {
          const wire = reply.wire();
          emitted.push(...effects(reply.effects()));
          const parsed = JSON.parse(wire);
          replies[slot ?? pending.get(parsed.requestId)] = parsed;
          pending.delete(parsed.requestId);
        };
        for (const request of group.requests) {
          requests++;
          const slot = replies.length;
          replies.push(null);
          const reply = session.submit(request);
          if (reply) receive(reply, slot);
          else pending.set(JSON.parse(request).requestId, slot);
        }
        for (const op of group.host) {
          let result = null;
          if (op.kind === "checkpoint") {
            const guard = session.capture_guard();
            try {
              emitted.push(...effects(session.acknowledge_checkpoint(guard)));
            } finally {
              guard.free();
            }
          } else if (op.kind === "selection") {
            const guard = session.capture_guard(),
              input = new core.ProjectSelectionInput();
            try {
              for (const r of op.refs)
                input.add(
                  layout.selectionKinds.indexOf(r.kind),
                  Uint16Array.from(r.id ?? []),
                );
            } catch (e) {
              input.free();
              guard.free();
              throw e;
            }
            try {
              emitted.push(...effects(session.select(guard, input, -1)));
            } finally {
              guard.free();
            }
          } else if (op.kind === "captureSave") {
            saved.get(op.name)?.free();
            saved.set(op.name, session.capture_guard());
          } else if (op.kind === "saveCheckpoint") {
            try {
              emitted.push(
                ...effects(session.acknowledge_checkpoint(saved.get(op.name))),
              );
              result = "saved";
            } catch (e) {
              eq(String(e), "stale_or_disposed", "save error");
              result = "stale";
            }
          } else if (op.kind === "dispose") session.dispose();
          else throw Error("unknown host operation");
          hostOutcomes.push(result);
        }
        for (let reply; (reply = session.run_next());) receive(reply);
        eq(pending.size, 0);
        eq(session.pending_count(), 0);
        eq(
          { ...observe(session), replies, effects: emitted, hostOutcomes },
          {
            snapshot: group.snapshot,
            selection: group.selection,
            history: group.history,
            historyRevision: group.historyRevision,
            assets: group.assets,
            replies: group.replies,
            effects: group.effects,
            hostOutcomes: group.hostOutcomes,
          },
          `${trace.name} group ${groupIndex}`,
        );
      }
    } finally {
      session.free();
      for (const guard of saved.values()) guard.free();
      for (const { capture, expected } of retained) {
        try {
          eq(
            decode.decode(bytes(capture.export_json(8 * 1024 * 1024))),
            expected,
            "capture after session release",
          );
        } finally {
          capture.free();
        }
      }
      try {
        owned = asset.read(0, asset.length());
        eq(Array.from(owned), trace.asset.bytes, "asset lease after release");
      } finally {
        asset.free();
      }
    }
  }
  return { traces: fixture.traces.length, groups, requests, owned };
}
