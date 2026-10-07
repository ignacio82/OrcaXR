// One browser-compatible replay for WASM and actual JNI, with independent
// TypeScript outcomes. No expected state/effects are calculated by Rust here.
import { projectReader } from "./project-wasm-replay.mjs";
const text = (units) =>
  units === null
    ? null
    : units.reduce((s, u) => s + String.fromCharCode(u), "");
export function stagedCommandJson(work, schema) {
  const commandTag = (kind) => Object.keys(schema.commandKinds).indexOf(kind);
  const capture = (c) => {
    if (c.intent)
      return [
        commandTag("intent"),
        JSON.stringify({ version: 1, command: c.intent }),
      ];
    if (c.clipboard)
      return [
        commandTag("clipboardPaste"),
        text(c.ids.objectId),
        c.ids.volumeIds.map(text),
        c.ids.instanceIds.map(text),
        c.ids.layerRangeIds.map(text),
        text(c.destination),
      ];
    const record = JSON.parse(c.recordJson);
    if (c.kind === "instance")
      return [
        commandTag("createInstance"),
        text(c.objectId),
        record,
        c.index ?? null,
      ];
    return [
      commandTag("pasteObject"),
      record,
      text(c.ids.objectId),
      c.ids.volumeIds.map(text),
      c.ids.instanceIds.map(text),
      c.ids.layerRangeIds.map(text),
      text(c.destination),
      text(c.name),
    ];
  };
  const single = Object.keys(schema.workKinds).indexOf("single"),
    transaction = Object.keys(schema.workKinds).indexOf("transaction");
  return JSON.stringify([
    schema.version,
    work.single
      ? [single, capture(work.single)]
      : [transaction, text(work.label), work.commands.map(capture)],
  ]);
}
export function stagedInputOptions(bytes, schema) {
  const limits = {
    bytes,
    nodes: 1_000_000,
    textUnits: 8_000_000,
    numberBytes: 1024,
    depth: 128,
    commands: 100_000,
    inputUnits: 4_000_000,
  };
  return Float64Array.from(schema.inputOptions.map((k) => limits[k]));
}
export function clipboardObjectQuery(
  session,
  queryLayout,
  platePosition = 0,
  objectPosition = 0,
) {
  const held = [];
  const own = (v) => {
    held.push(v);
    return v;
  };
  try {
    const root = own(own(session.snapshot()).query(queryLayout.version));
    const plates = own(
      root.children(Object.keys(queryLayout.relations).indexOf("plates"), 4096),
    );
    const plate = own(plates.node(platePosition));
    const objects = own(
      plate.children(Object.keys(queryLayout.relations).indexOf("objects"), 0),
    );
    return objects.node(objectPosition);
  } finally {
    for (const value of held.reverse()) value.free();
  }
}
export async function replayStagedProject(
  core,
  fixture,
  layout,
  schema,
  queryLayout,
) {
  const { encode, decode, eq, bytes, effects, observe } = projectReader(
    core,
    fixture,
    layout,
  );
  const usage = (session) => {
    const [resources, commands, units] = session.staging_usage();
    return { resources, commands, units };
  };
  const observed = (session) => ({
    ...observe(session),
    staging: usage(session),
  });
  const error = (value) => {
    if (typeof value !== "string") throw value;
    const codes = {
      resource_limit: "resourceLimit",
      input_limit: "resourceLimit",
      stale: "stale",
      disposed: "disposed",
      busy: "busy",
      invalid_command: "invalidRequest",
      invalid_options: "invalidRequest",
    };
    if (!codes[value])
      throw Error(`Unexpected command upload failure: ${value}`);
    return { error: codes[value] };
  };
  let requests = 0,
    groups = 0,
    uploads = 0,
    clipboardCaptures = 0;
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
    let input = new core.ProjectUpload(
        layout.version,
        source.length,
        Float64Array.from(layout.options.map((k) => options[k])),
      ),
      session;
    try {
      for (let p = 0; p < source.length; p += 997)
        input.append_document(p, source.subarray(p, p + 997));
      input.seal_document();
      const assets = trace.assets ?? [trace.asset];
      eq(input.asset_count(), assets.length);
      for (const [i, asset] of assets.entries()) {
        const data = Uint8Array.from(asset.bytes);
        eq(input.begin_asset(i), data.length);
        input.append_asset(0, data);
        input.finish_asset();
      }
      const owned = input;
      input = undefined;
      session = owned.open(Float64Array.from(fixture.generation));
    } finally {
      input?.free();
    }
    const guards = new Map(),
      clips = new Map(),
      retained = [],
      asset = session.asset(0);
    try {
      eq(observed(session), trace.initial, trace.name + " initial");
      for (const [groupIndex, group] of trace.steps.entries()) {
        groups++;
        const capture = session.snapshot();
        retained.push({
          capture,
          expected: decode.decode(bytes(capture.export_json(8 * 1024 * 1024))),
        });
        const replies = [],
          emitted = [],
          pending = new Map(),
          outcomes = [];
        const receive = (reply, slot) => {
          const wire = JSON.parse(reply.wire());
          emitted.push(...effects(reply.effects()));
          replies[slot ?? pending.get(wire.requestId)] = wire;
          pending.delete(wire.requestId);
        };
        for (const action of group.actions) {
          let result = null;
          try {
            if (action.kind === "configure") {
              const v = action.limits;
              session.configure_staging(
                schema.version,
                Float64Array.from([v.maxResources, v.maxCommands, v.maxUnits]),
              );
            } else if (action.kind === "guard") {
              guards.get(action.name)?.free();
              guards.set(action.name, session.capture_guard());
            } else if (action.kind === "copy") {
              const guard =
                action.guard === undefined
                  ? session.capture_guard()
                  : guards.get(action.guard);
              let captured;
              let node;
              try {
                node = clipboardObjectQuery(
                  session,
                  queryLayout,
                  action.queryPlate ?? action.plate,
                  action.object,
                );
                captured = session.capture_clipboard(
                  guard,
                  node,
                  schema.version,
                  Float64Array.from([action.assets, action.bytes]),
                );
                result = Array.from(captured.info());
                clips.get(action.name)?.free();
                clips.set(action.name, captured);
                captured = undefined;
                clipboardCaptures++;
              } finally {
                captured?.free();
                node?.free();
                if (action.guard === undefined) guard.free();
              }
            } else if (action.kind === "dropClipboard") {
              clips.get(action.name)?.free();
              clips.delete(action.name);
            } else if (action.kind === "stage") {
              const guard =
                action.guard === undefined
                  ? session.capture_guard()
                  : guards.get(action.guard);
              let upload;
              try {
                const source = encode.encode(
                  stagedCommandJson(action.work, schema),
                );
                const names = [
                  ...new Set(
                    (action.work.single
                      ? [action.work.single]
                      : action.work.commands
                    )
                      .map((c) => c.clipboard)
                      .filter(Boolean),
                  ),
                ];
                if (names.length > 1)
                  throw Error("Each clipboard upload binds one source capture");
                const options = stagedInputOptions(source.length, schema);
                upload = names.length
                  ? session.clipboard_upload(
                      guard,
                      clips.get(names[0]),
                      schema.version,
                      source.length,
                      options,
                    )
                  : session.command_upload(
                      guard,
                      schema.version,
                      source.length,
                      options,
                    );
                uploads++;
                for (let p = 0; p < source.length; p += 997)
                  upload.append(p, source.subarray(p, p + 997));
                upload.seal();
                const units = upload.units(),
                  commands = upload.command_count();
                const owned = upload;
                upload = undefined;
                result = { id: session.stage_commands(owned), units, commands };
              } finally {
                upload?.free();
                if (action.guard === undefined) guard.free();
              }
            } else if (action.kind === "request") {
              requests++;
              const slot = replies.length;
              replies.push(null);
              result = { reply: slot };
              const reply = session.submit(action.json);
              if (reply) receive(reply, slot);
              else pending.set(JSON.parse(action.json).requestId, slot);
            } else if (action.kind === "checkpoint") {
              const guard = session.capture_guard();
              try {
                emitted.push(...effects(session.acknowledge_checkpoint(guard)));
              } finally {
                guard.free();
              }
            } else if (action.kind === "selection") {
              const guard = session.capture_guard();
              let selection = new core.ProjectSelectionInput();
              try {
                for (const ref of action.refs)
                  selection.add(
                    layout.selectionKinds.indexOf(ref.kind),
                    Uint16Array.from(ref.id ?? []),
                  );
                const owned = selection;
                selection = undefined;
                emitted.push(...effects(session.select(guard, owned, -1)));
              } finally {
                selection?.free();
                guard.free();
              }
            } else if (action.kind === "dispose") session.dispose();
            else throw Error("Unknown staged action");
          } catch (e) {
            result = error(e);
          }
          outcomes.push(result);
        }
        const queued = usage(session);
        for (let reply; (reply = session.run_next());) receive(reply);
        eq(pending.size, 0);
        eq(session.pending_count(), 0);
        eq(
          { outcomes, queued, replies, effects: emitted, ...observed(session) },
          {
            outcomes: group.outcomes,
            queued: group.queued,
            replies: group.replies,
            effects: group.effects,
            snapshot: group.snapshot,
            selection: group.selection,
            history: group.history,
            historyRevision: group.historyRevision,
            assets: group.assets,
            staging: group.staging,
          },
          `${trace.name} staged group ${groupIndex}`,
        );
      }
    } finally {
      session.free();
      for (const guard of guards.values()) guard.free();
      for (const clip of clips.values()) clip.free();
      for (const { capture, expected } of retained) {
        try {
          eq(
            decode.decode(bytes(capture.export_json(8 * 1024 * 1024))),
            expected,
            "retained staged project",
          );
        } finally {
          capture.free();
        }
      }
      try {
        eq(
          Array.from(asset.read(0, asset.length())),
          trace.asset.bytes,
          "staged asset lifetime",
        );
        eq(
          decode.decode(bytes(asset.metadata(8 * 1024 * 1024))),
          trace.asset.descriptorJson,
          "staged full asset metadata",
        );
      } finally {
        asset.free();
      }
    }
  }
  return {
    stagedTraces: fixture.traces.length,
    stagedGroups: groups,
    stagedRequests: requests,
    commandUploads: uploads,
    clipboardCaptures,
  };
}
