// The print submission workflow through a binding: every recorded input of
// every browser scenario, fed in order to one PrintWorkflow, answers the
// browser's step or refuses with its code. Runs unchanged over WASM in Node
// and a browser worker, and over the JNI bridge.
export function replayPrinterWorkflow(core, fixture) {
  let steps = 0;
  let refusals = 0;
  for (const scenario of fixture.scenarios) {
    const flow = new core.PrintWorkflow();
    try {
      for (const [i, record] of scenario.records.entries()) {
        const [kind, value] = Object.entries(record.input)[0];
        const label = `${scenario.name}, input ${i}`;
        let step;
        try {
          step =
            kind === "run"
              ? flow.run(value)
              : kind === "stored"
                ? flow.start_stored(value)
                : kind === "resolve"
                  ? flow.resolve(value.id, value.outcome)
                  : kind === "reply"
                    ? flow.resolve_reply(value.id, value.text)
                    : kind === "cancel"
                      ? flow.cancel()
                      : flow.dispose();
        } catch (error) {
          if (record.refused === undefined) throw error;
          const code = typeof error === "string" ? error : error.message;
          if (code !== record.refused)
            throw Error(`${label}: refused ${code} !== ${record.refused}`);
          refusals++;
          steps++;
          continue;
        }
        if (step !== record.step)
          throw Error(`${label}: ${step} !== ${record.step}`);
        steps++;
      }
      if (flow.busy()) throw Error(`${scenario.name} ends busy`);
    } finally {
      flow.free();
    }
  }
  return {
    printerWorkflowScenarios: fixture.scenarios.length,
    printerWorkflowSteps: steps,
    printerWorkflowRefusals: refusals,
  };
}
