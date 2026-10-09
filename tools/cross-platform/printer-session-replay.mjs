// The printer session through a binding: every recorded input of every
// browser scenario, fed in order to one PrinterSession, answers the
// browser's step and view, or its reply, or refuses with its code. Runs
// unchanged over WASM in Node and a browser worker, and over the JNI bridge.
export function replayPrinterSession(core, fixture) {
  let steps = 0;
  let replies = 0;
  let refusals = 0;
  for (const scenario of fixture.scenarios) {
    const session = new core.PrinterSession();
    try {
      for (const [i, record] of scenario.records.entries()) {
        const [kind, value] = Object.entries(record.input)[0];
        const label = `${scenario.name}, input ${i}`;
        const eq = (actual, expected, what) => {
          if (actual !== expected)
            throw Error(`${label} ${what}: ${actual} !== ${expected}`);
        };
        const queries = {
          captureIntent: () =>
            eq(session.capture_intent(value), record.intent, "intent"),
          confirm: () => eq(session.confirm(value), record.token, "token"),
          captureLease: () =>
            eq(session.capture_lease(), record.lease, "lease"),
          leaseCurrent: () =>
            eq(session.lease_current(value), record.current, "current"),
        };
        if (kind in queries) {
          queries[kind]();
          replies++;
          continue;
        }
        let step;
        try {
          step =
            kind === "select"
              ? session.select(value)
              : kind === "execute"
                ? session.execute(value)
                : kind === "state"
                  ? session.transport_state(value.transport, value.signal)
                  : kind === "notification"
                    ? session.notification(
                        value.transport,
                        value.method,
                        value.params,
                        value.now,
                      )
                    : kind === "resolve"
                      ? session.resolve(value.id, value.outcome)
                      : kind === "reply"
                        ? session.resolve_reply(value.id, value.text, value.now)
                        : session[kind]();
        } catch (error) {
          if (record.refused === undefined) throw error;
          eq(
            typeof error === "string" ? error : error.message,
            record.refused,
            "refusal",
          );
          refusals++;
          continue;
        }
        eq(step, record.step, "step");
        eq(session.view(), record.view, "view");
        steps++;
      }
    } finally {
      session.free();
    }
  }
  return {
    printerSessionScenarios: fixture.scenarios.length,
    printerSessionSteps: steps,
    printerSessionReplies: replies,
    printerSessionRefusals: refusals,
  };
}
