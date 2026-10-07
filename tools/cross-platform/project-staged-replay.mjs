// One browser-compatible replay for WASM and actual JNI, with independent
// TypeScript outcomes. No expected state/effects are calculated by Rust here.
import { projectReader } from "./project-wasm-replay.mjs";
const text = (units) =>
  units === null
    ? null
    : units.reduce((s, u) => s + String.fromCharCode(u), "");
const descriptor = (wire) => JSON.parse(wire.descriptorJson);
const guardJson = (g) =>
  Object.fromEntries(
    Object.entries(g).map(([k, v]) => [k, Array.isArray(v) ? text(v) : v]),
  );
const partsJson = (parts) =>
  parts.map((p) => ({
    volumeId: text(p.volumeId),
    descriptor: descriptor(p.asset),
    transform: JSON.parse(p.transformJson),
    sourceTriangleIndices: p.sourceTriangleIndices,
  }));
const placementJson = (p) => ({
  objectId: text(p.objectId),
  volumeId: text(p.volumeId),
  assetId: text(p.assetId),
  transform: JSON.parse(p.transformJson),
});
/** The record for a payload-carrying command, in the decoder's field order. */
function assetCommand(c, tag) {
  switch (c.kind) {
    case "addObject":
      return [tag("addObject"), text(c.plateId), JSON.parse(c.recordJson)];
    case "addObjectWithAsset":
      return [tag("addObjectWithAsset"), text(c.plateId), JSON.parse(c.recordJson), descriptor(c.asset)];
    case "addVolume":
      return [tag("addVolume"), text(c.objectId), JSON.parse(c.recordJson), descriptor(c.asset)];
    case "replaceVolumeMesh":
      return [tag("replaceVolumeMesh"), guardJson(c.guard), descriptor(c.asset)];
    case "meshBoolean":
      return [tag("meshBoolean"), guardJson(c.guard), descriptor(c.asset), c.op];
    case "splitVolumeToParts":
      return [tag("splitVolumeToParts"), guardJson(c.guard), partsJson(c.parts)];
    case "addSvgPart":
      return [tag("addSvgPart"), placementJson(c.placement), descriptor(c.asset), descriptor(c.drawing), c.triangleCount, JSON.parse(c.partJson), text(c.name)];
    case "editSvgPart":
      return [tag("editSvgPart"), text(c.volumeId), descriptor(c.asset), c.triangleCount, JSON.parse(c.partJson)];
    case "addEmbossText":
      return [tag("addEmbossText"), placementJson(c.placement), JSON.parse(c.configurationJson), descriptor(c.asset), c.triangleCount];
    case "editEmbossText":
      return [tag("editEmbossText"), text(c.volumeId), JSON.parse(c.configurationJson), descriptor(c.asset), c.triangleCount];
    case "replaceProject":
      return [tag("replaceProject"), JSON.parse(c.stateJson), text(c.label)];
    default:
      return undefined;
  }
}
/** Payloads a work declares, deduplicated by ID in first-declaration order:
 * the order an upload asks for them after `seal`. */
export function stagedPayloads(work) {
  const commandPayloads = (c) =>
    c.kind === "splitVolumeToParts"
      ? c.parts.map((p) => p.asset)
      : c.kind === "addSvgPart"
        ? [c.asset, c.drawing]
        : c.asset
          ? [c.asset]
          : [];
  const all = work.splitToObjects
    ? work.splitToObjects.parts.map((p) => p.asset)
    : (work.single ? [work.single] : work.commands).flatMap(commandPayloads);
  const seen = new Map();
  for (const p of all) {
    const id = descriptor(p).id;
    if (!seen.has(id)) seen.set(id, p);
  }
  return [...seen.values()];
}
export function stagedCommandJson(work, schema) {
  const commandTag = (kind) => Object.keys(schema.commandKinds).indexOf(kind);
  const capture = (c) => {
    const asset = assetCommand(c, commandTag);
    if (asset) return asset;
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
    transaction = Object.keys(schema.workKinds).indexOf("transaction"),
    split = Object.keys(schema.workKinds).indexOf("splitToObjects");
  if (work.splitToObjects) {
    const w = work.splitToObjects;
    return JSON.stringify([
      schema.version,
      [
        split,
        guardJson(w.guard),
        partsJson(w.parts),
        w.identities.map((i) => ({
          sourceVolumeId: text(i.sourceVolumeId),
          objectId: text(i.objectId),
          instanceIds: i.instanceIds.map(text),
        })),
      ],
    ]);
  }
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
    assets: 64,
    assetBytes: 16_000_000,
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
    const [resources, commands, units, assetBytes] = session.staging_usage();
    return { resources, commands, units, assetBytes };
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
      invalid_asset: "invalidRequest",
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
                Float64Array.from([
                  v.maxResources,
                  v.maxCommands,
                  v.maxUnits,
                  v.maxAssetBytes,
                ]),
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
                      : (action.work.commands ?? [])
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
                // Declared payloads stream after the records, in 997-byte chunks.
                const payloads = stagedPayloads(action.work);
                eq(upload.asset_count(), payloads.length);
                for (const [index, payload] of payloads.entries()) {
                  const data = Uint8Array.from(payload.bytes);
                  eq(upload.begin_asset(index), data.length);
                  for (let p = 0; p < data.length; p += 997)
                    upload.append_asset(p, data.subarray(p, p + 997));
                  upload.finish_asset();
                }
                const units = upload.units(),
                  commands = upload.command_count(),
                  assetBytes = upload.asset_bytes();
                const owned = upload;
                upload = undefined;
                result = {
                  id: session.stage_commands(owned),
                  units,
                  commands,
                  assetBytes,
                };
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
