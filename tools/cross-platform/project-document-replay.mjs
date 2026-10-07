import { projectReader } from "./project-wasm-replay.mjs";

export function replayProjectDocuments(core, fixture, layout) {
  const { encode, effects, observe, eq } = projectReader(core, fixture, layout);
  const nonce = [0, 1, 2, 3];
  const load = (document, prepare, incomplete = false) => {
    const bytes = encode.encode(document.stateJson);
    let input = new core.ProjectUpload(
      layout.version,
      bytes.length,
      Float64Array.from([
        bytes.length,
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
      for (let p = 0; p < bytes.length; p += layout.maxChunkBytes)
        input.append_document(p, bytes.subarray(p, p + layout.maxChunkBytes));
      input.seal_document();
      if (!incomplete)
        for (const [i, asset] of document.assets.entries()) {
          eq(input.begin_asset(i), asset.bytes.length);
          input.append_asset(0, Uint8Array.from(asset.bytes));
          input.finish_asset();
        }
      const owned = input;
      input = undefined;
      return prepare ? owned.prepare() : owned.open(Float64Array.from(nonce));
    } finally {
      input?.free();
    }
  };
  let steps = 0;
  for (const trace of fixture.traces) {
    const session = load(fixture.documents[0], false),
      opens = new Map();
    let sequence = 0;
    const wire = (operation) =>
      JSON.stringify({
        protocolVersion: 1,
        generation: nonce,
        requestId: ++sequence,
        operation,
      });
    const run = (operation) => {
      const reply = session.submit(wire(operation)) ?? session.run_next();
      const result = JSON.parse(reply.wire()).result;
      return { result, events: effects(reply.effects()) };
    };
    try {
      eq(
        { ...observe(session), opens: [] },
        trace.initial,
        `${trace.name} initial`,
      );
      for (const step of trace.steps) {
        steps++;
        const action = step.action,
          ticket = opens.get(action.name);
        let outcome = null,
          events = [];
        if (action.kind === "begin")
          opens.set(action.name, session.begin_open());
        else if (
          ["finish", "finishInvalid", "reset", "resetInvalid"].includes(
            action.kind,
          )
        ) {
          let document;
          try {
            document = load(
              fixture.documents[action.document],
              true,
              action.kind.endsWith("Invalid"),
            );
          } catch (e) {
            if (!action.kind.endsWith("Invalid") || e !== "incomplete_bundle")
              throw e;
            if (ticket) session.cancel_open(ticket);
            outcome = "failed";
          }
          if (document) {
            const reset = action.kind.startsWith("reset"),
              guard = reset ? session.capture_guard() : undefined;
            try {
              events = effects(
                reset
                  ? session.reset_document(guard, document)
                  : session.finish_open(ticket, document),
              );
              outcome = reset ? "reset" : "opened";
            } catch (e) {
              if (!["stale", "disposed"].includes(e)) throw e;
              outcome = e;
            } finally {
              guard?.free();
              document.free();
            }
          }
        } else if (action.kind === "fail" || action.kind === "cancel") {
          const current = session.is_open_current(ticket);
          session.cancel_open(ticket);
          outcome =
            action.kind === "cancel"
              ? "cancelled"
              : current
                ? "failed"
                : "stale";
        } else if (action.kind === "checkpoint") {
          const guard = session.capture_guard();
          try {
            events = effects(session.acknowledge_checkpoint(guard));
          } finally {
            guard.free();
          }
        } else if (action.kind === "select") {
          const guard = session.capture_guard(),
            input = new core.ProjectSelectionInput();
          try {
            input.add(0, new Uint16Array());
            events = effects(session.select(guard, input, -1));
          } finally {
            guard.free();
          }
        } else if (action.kind === "dispose") session.dispose();
        else if (action.kind === "edit" || action.kind === "undo") {
          if (sequence === 0)
            run({
              hello: {
                minProtocolVersion: 1,
                maxProtocolVersion: 1,
                projectSchemaVersion: 1,
                intentVersion: 1,
              },
            });
          const guard = run({ query: {} }).result.acknowledged.guard;
          const result = run(
            action.kind === "edit"
              ? { execute: { guard, intent: action.intent } }
              : { undo: guard },
          );
          if (!result.result.acknowledged)
            throw Error("Document reference edit failed");
          events = result.events;
        } else throw Error("Unknown document action");
        const actual = {
          ...observe(session),
          opens: [...opens].map(([n, t]) => [n, session.is_open_current(t)]),
          outcome,
          effects: events,
        };
        const { action: ignored, ...expected } = step;
        eq(actual, expected, `${trace.name} ${action.kind}`);
      }
    } finally {
      for (const ticket of opens.values()) ticket.free();
      session.free();
    }
  }
  // Cross-owner and consumed-handle checks use fresh actual host owners.
  const a = load(fixture.documents[0], false),
    b = load(fixture.documents[0], false);
  const ticket = a.begin_open(),
    other = b.begin_open(),
    guard = b.capture_guard();
  let refusals = 0;
  const refuse = (fn, code) => {
    try {
      fn()?.free?.();
    } catch (e) {
      if (code !== undefined) eq(e, code);
      refusals++;
      return;
    }
    throw Error("Invalid document lifecycle accepted");
  };
  const finish = (session, ticket, index) => {
    const doc = load(fixture.documents[index], true);
    try {
      return session.finish_open(ticket, doc);
    } finally {
      doc.free();
    }
  };
  const reset = (session, guard, index) => {
    const doc = load(fixture.documents[index], true);
    try {
      return session.reset_document(guard, doc);
    } finally {
      doc.free();
    }
  };
  try {
    eq(b.is_open_current(ticket), false);
    eq(b.cancel_open(ticket), false);
    refuse(() => finish(b, ticket, 1), "stale");
    eq(b.is_open_current(other), true);
    const document = load(fixture.documents[1], true);
    a.finish_open(ticket, document).free();
    refuse(() => finish(a, ticket, 2), "stale");
    refuse(() => reset(a, guard, 2), "stale");
    // Both adapters consume prepared input even on stale or disposed admission.
    refuse(() => a.finish_open(ticket, document));
    document.free();
    const stillUsable = a.begin_open();
    stillUsable.free();
    const abandoned = b.begin_open();
    abandoned.free();
    b.dispose();
    refuse(() => b.begin_open(), "disposed");
    refuse(() => finish(b, other, 2), "disposed");
    refuse(() => reset(b, guard, 2), "disposed");
  } finally {
    ticket.free();
    other.free();
    guard.free();
    a.free();
    b.free();
  }
  return {
    documentTraces: fixture.traces.length,
    documentSteps: steps,
    documentRefusals: refusals,
  };
}
