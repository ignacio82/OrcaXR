// The print job status model through a binding: every trace's queries,
// patches and resets answer the browser's reply, and the model's snapshot
// after each step is the browser's. Runs unchanged over WASM in Node and a
// browser worker, and over the JNI bridge.
export function replayPrintJobStatus(core, fixture) {
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  let snapshots = 0,
    ignored = 0,
    refusals = 0;
  for (const trace of fixture.traces) {
    const model = new core.PrintJobStatus();
    try {
      for (const [i, step] of trace.steps.entries()) {
        const label = `${trace.name} step ${i}`;
        if (step.op === "reset") {
          eq(model.reset(), step.snapshotJson, label);
          snapshots++;
        } else {
          let reply, refusal;
          try {
            reply =
              step.op === "query"
                ? model.apply_query(step.text, step.nowMs)
                : model.apply_notification(step.text, step.nowMs);
          } catch (e) {
            refusal = String(e?.message ?? e);
          }
          if (step.refusal !== undefined) {
            if (!refusal?.includes(step.refusal))
              fail(`${label}: ${refusal} does not refuse ${step.refusal}`);
            refusals++;
          } else if (refusal !== undefined) {
            fail(`${label}: refused ${refusal}`);
          } else if (step.ignored) {
            if (reply !== undefined) fail(`${label}: ${reply} was not ignored`);
            ignored++;
          } else {
            eq(reply, step.snapshotJson, label);
            snapshots++;
          }
        }
        eq(model.snapshot(), step.currentJson, `${label} afterwards`);
      }
    } finally {
      model.free();
    }
  }
  return {
    printJobSnapshots: snapshots,
    printJobIgnored: ignored,
    printJobRefusals: refusals,
  };
}
