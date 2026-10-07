import {
  clipboardObjectQuery,
  stagedCommandJson,
  stagedInputOptions,
} from "./project-staged-replay.mjs";

// Identical ownership checks execute against the actual WASM and JNI adapters.
// Source-edit semantics and complete receipts come from the independent staged
// trace. These checks qualify host limits/lifetimes, not document adoption.
export function projectClipboardBoundaries(
  core,
  fixture,
  layout,
  schema,
  queryLayout,
) {
  const trace = fixture.traces.find((t) => t.name === "clipboard:roundtrip");
  const state = JSON.parse(trace.stateJson),
    encoder = new TextEncoder();
  const stage = trace.steps.find((g) =>
    g.actions.some((a) => a.kind === "stage"),
  );
  const action = stage.actions.find((a) => a.kind === "stage");
  const json = stagedCommandJson(action.work, schema),
    data = encoder.encode(json);
  const expectedUnits = stage.outcomes[0].units;
  let refusals = 0;
  const eq = (a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw Error("Clipboard host mismatch");
  };
  const refuse = (fn, code) => {
    let rejected = false;
    try {
      const value = fn();
      value?.free?.();
    } catch (e) {
      if (code !== undefined) eq(e, code);
      rejected = true;
    }
    if (!rejected) throw Error("Clipboard host accepted invalid input");
    refusals++;
  };
  const open = () => {
    const source = encoder.encode(trace.stateJson);
    let input = new core.ProjectUpload(
      layout.version,
      source.length,
      Float64Array.from([
        source.length,
        1_000_000,
        4_000_000,
        1024,
        128,
        100,
        16_777_216,
        33_554_432,
        100,
        33_554_432,
      ]),
    );
    try {
      input.append_document(0, source);
      input.seal_document();
      for (const [i, p] of trace.assets.entries()) {
        eq(input.begin_asset(i), p.bytes.length);
        input.append_asset(0, Uint8Array.from(p.bytes));
        input.finish_asset();
      }
      const owned = input;
      input = undefined;
      return owned.open(Float64Array.from(fixture.generation));
    } finally {
      input?.free();
    }
  };
  let session = open(),
    clipboard;
  const guard = session.capture_guard(),
    other = open(),
    foreignGuard = other.capture_guard();
  const limits = Float64Array.from([2, 57]);
  const objectNode = clipboardObjectQuery(session, queryLayout);
  const foreignNode = clipboardObjectQuery(other, queryLayout);
  const copy = (owner = session, current = guard) => {
    const node = clipboardObjectQuery(owner, queryLayout);
    try {
      return owner.capture_clipboard(current, node, schema.version, limits);
    } finally {
      node.free();
    }
  };
  const upload = (
    payload = data,
    captured = clipboard,
    owner = session,
    current = guard,
    options = stagedInputOptions(payload.length, schema),
  ) =>
    owner.clipboard_upload(
      current,
      captured,
      schema.version,
      payload.length,
      options,
    );
  const ready = (current = guard, payload = data, chunk = 7) => {
    let input = upload(payload, clipboard, session, current);
    try {
      for (let p = 0; p < payload.length; p += chunk) {
        const part = payload.slice(p, p + chunk);
        input.append(p, part);
        part.fill(0);
      }
      input.seal();
      const result = input;
      input = undefined;
      return result;
    } finally {
      input?.free();
    }
  };
  let requestId = 0;
  const wire = (operation) =>
    JSON.stringify({
      protocolVersion: 1,
      generation: fixture.generation,
      requestId: ++requestId,
      operation,
    });
  const receive = (reply) => {
    const wire = JSON.parse(reply.wire());
    reply.effects().free();
    return wire;
  };
  try {
    session.configure_staging(1, Float64Array.from([4, 100, 4_000_000, 0]));
    receive(
      session.submit(
        wire({
          hello: {
            minProtocolVersion: 1,
            maxProtocolVersion: 1,
            projectSchemaVersion: 1,
            intentVersion: 1,
          },
        }),
      ),
    );
    for (const version of [-1, 0, 2])
      refuse(
        () => session.capture_clipboard(guard, objectNode, version, limits),
        "invalid_options",
      );
    for (const length of [0, 1, 3])
      refuse(
        () =>
          session.capture_clipboard(
            guard,
            objectNode,
            1,
            new Float64Array(length),
          ),
        "invalid_options",
      );
    for (let i = 0; i < 2; ++i)
      for (const n of [-1, 0.5, NaN, Infinity, 4_294_967_296]) {
        const values = limits.slice();
        values[i] = n;
        refuse(
          () => session.capture_clipboard(guard, objectNode, 1, values),
          "invalid_options",
        );
      }
    const snapshot = session.snapshot();
    const root = snapshot.query(queryLayout.version);
    const plates = root.children(
      Object.keys(queryLayout.relations).indexOf("plates"),
      4096,
    );
    const plate = plates.node(0);
    try {
      for (const node of [root, plate])
        refuse(
          () => session.capture_clipboard(guard, node, 1, limits),
          "invalid_clipboard_target",
        );
      refuse(
        () => session.capture_clipboard(guard, foreignNode, 1, limits),
        "stale",
      );
    } finally {
      plate.free();
      plates.free();
      root.free();
      snapshot.free();
    }
    for (const values of [
      [1, 57],
      [2, 56],
      [0, 0],
    ])
      refuse(
        () =>
          session.capture_clipboard(
            guard,
            objectNode,
            1,
            Float64Array.from(values),
          ),
        "resource_limit",
      );
    refuse(() => copy(session, foreignGuard), "stale");
    const held = Array.from({ length: schema.maxClipboards }, () => copy());
    try {
      refuse(() => copy(), "resource_limit");
      refuse(() => copy(other, foreignGuard), "resource_limit");
      for (const capture of held) {
        const info = capture.info();
        eq(Array.from(info), [2, 1, 1, 2, 57]);
        info.fill(999);
        eq(Array.from(capture.info()), [2, 1, 1, 2, 57]);
      }
    } finally {
      for (const capture of held) capture.free();
    }
    clipboard = copy();
    refuse(
      () => upload(data, clipboard, other, foreignGuard),
      "foreign_clipboard",
    );
    refuse(() => upload(data, clipboard, session, foreignGuard), "stale");
    for (const version of [-1, 0, 2])
      refuse(
        () =>
          session.clipboard_upload(
            guard,
            clipboard,
            version,
            data.length,
            stagedInputOptions(data.length, schema),
          ),
        "invalid_options",
      );
    for (const field of schema.inputOptions.keys()) {
      const options = stagedInputOptions(data.length, schema);
      options[field] = -1;
      refuse(
        () => upload(data, clipboard, session, guard, options),
        "invalid_options",
      );
    }
    for (const chunk of [1, 7, 97, 65536]) {
      const input = ready(guard, data, chunk);
      eq(input.units(), expectedUnits);
      eq(input.command_count(), 1);
      const id = session.stage_commands(input);
      eq(session.release_staged(id), true);
    }
    const unattached = session.command_upload(
      guard,
      1,
      data.length,
      stagedInputOptions(data.length, schema),
    );
    try {
      unattached.append(0, data);
      refuse(() => unattached.seal(), "invalid_command");
    } finally {
      unattached.free();
    }
    for (const mutate of [
      (v) => v[1][1].pop(),
      (v) => v[1][1].push(null),
      (v) => (v[1][1][1] = {}),
      (v) => (v[1][1][2] = 5),
      (v) => (v[0] = 2),
    ]) {
      const value = JSON.parse(json);
      mutate(value);
      refuse(() => ready(guard, encoder.encode(JSON.stringify(value))));
    }
    const tooSmall = stagedInputOptions(data.length, schema);
    tooSmall[schema.inputOptions.indexOf("inputUnits")] = expectedUnits - 1;
    let small = upload(data, clipboard, session, guard, tooSmall);
    try {
      small.append(0, data);
      refuse(() => small.seal(), "resource_limit");
    } finally {
      small.free();
    }
    // Reading and sealed clipboard uploads share the same preparation quota.
    const uploads = Array.from({ length: schema.maxPreparations }, (_, i) =>
      i % 2 ? ready() : upload(),
    );
    try {
      refuse(() => upload(), "resource_limit");
      refuse(
        () =>
          session.command_upload(
            guard,
            1,
            data.length,
            stagedInputOptions(data.length, schema),
          ),
        "resource_limit",
      );
    } finally {
      for (const input of uploads) input.free();
    }
    const detached = ready();
    clipboard.free();
    clipboard = undefined;
    const replacements = Array.from({ length: schema.maxClipboards }, () =>
      copy(),
    );
    for (const capture of replacements) capture.free();
    const id = session.stage_commands(detached);
    eq(session.submit(wire({ executeStaged: { stagedId: id } })), undefined);
    const result = receive(session.run_next());
    if (!Object.hasOwn(result.result, "acknowledged"))
      throw Error("Detached clipboard paste failed");
    eq(Array.from(session.staging_usage()), [0, 0, 0, 0]);
    // History retains data but must not retain clipboard owner slots.
    const current = session.capture_guard();
    try {
      refuse(
        () => session.capture_clipboard(current, objectNode, 1, limits),
        "stale",
      );
      const copies = Array.from({ length: schema.maxClipboards }, () =>
        copy(session, current),
      );
      for (const capture of copies) capture.free();
      clipboard = copy(session, current);
      refuse(() => copy(), "stale");
      refuse(() => upload(), "stale");
      const pending = ready(current);
      session.acknowledge_checkpoint(current).free();
      refuse(() => session.stage_commands(pending), "stale");
      eq(Array.from(clipboard.info()), [2, 1, 1, 2, 57]);
    } finally {
      current.free();
    }
    const latest = session.capture_guard();
    try {
      const pending = ready(latest);
      session.dispose();
      refuse(() => session.stage_commands(pending), "disposed");
      refuse(
        () => session.capture_clipboard(latest, objectNode, 1, limits),
        "stale",
      );
      refuse(() => upload(data, clipboard, session, latest), "stale");
    } finally {
      latest.free();
    }
    session.free();
    session = undefined;
    eq(Array.from(clipboard.info()), [2, 1, 1, 2, 57]);
    // Captured byte counts come from selected dependencies only (unused SVG omitted).
    eq(state.sourceAssets.length, 3);
  } finally {
    clipboard?.free();
    objectNode.free();
    foreignNode.free();
    session?.free();
    guard.free();
    other.free();
    foreignGuard.free();
  }
  return { clipboardRefusals: refusals };
}
