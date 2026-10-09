// The Moonraker transport through a binding: every recorded input of every
// browser scenario, fed in order to one MoonrakerTransport, answers the
// browser's step and state, or its reply, or refuses with its code. Text past
// the transport's bound is passed as only as much as decides the outcome.
// Runs unchanged over WASM in Node and a browser worker, and over the JNI
// bridge.
export function replayMoonrakerTransport(core, fixture) {
  let steps = 0;
  let replies = 0;
  let refusals = 0;
  let texts = 0;
  const bound = core.MoonrakerTransport.max_text_units();
  const received = (text) =>
    text.length > bound ? text.slice(0, bound + 1) : text;
  for (const scenario of fixture.scenarios) {
    let transport;
    try {
      for (const [i, record] of scenario.records.entries()) {
        const [kind, value] = Object.entries(record.input)[0];
        const label = `${scenario.name}, input ${i} (${kind})`;
        const eq = (actual, expected, what) => {
          if (actual !== expected)
            throw Error(`${label} ${what}: ${actual} !== ${expected}`);
        };
        const now = record.now;
        // Result and params texts travel beside a step: take each, once.
        const taken = (step) => {
          const { finished, outputs } = JSON.parse(step);
          const results = finished
            .filter(({ result }) => "result" in result)
            .map(({ task, result }) => {
              const text = transport.take_result(task);
              eq(text.length, result.result.units, "result length");
              return { task, text };
            });
          const params = outputs
            .filter((output) => "notification" in output)
            .map(({ notification }) => transport.take_params(notification.id));
          eq(
            JSON.stringify(results),
            JSON.stringify(record.results ?? []),
            "results",
          );
          eq(
            JSON.stringify(params),
            JSON.stringify(record.params ?? []),
            "params",
          );
          texts += results.length + params.length;
        };
        if (kind === "create") {
          eq(core.MoonrakerTransport.configure(value), record.reply, "reply");
          if ("state" in JSON.parse(record.reply)) {
            transport = new core.MoonrakerTransport(value);
          } else {
            let code;
            try {
              new core.MoonrakerTransport(value).free();
            } catch (error) {
              code = typeof error === "string" ? error : error.message;
            }
            eq(code, "invalid_request", "construction");
          }
          replies++;
          continue;
        }
        if (kind === "credentials" || kind === "clearCredentials") {
          if (kind === "credentials") {
            eq(
              transport.set_credentials(value, now),
              record.refused === undefined
                ? '{"absent":{}}'
                : `{"value":${record.refused}}`,
              "credentials",
            );
          } else transport.clear_credentials(now);
          eq(transport.has_api_key(), record.hasApiKey, "api key");
          eq(
            transport.has_bearer_token(),
            record.hasBearerToken,
            "bearer token",
          );
          replies++;
          continue;
        }
        if (kind === "subscription" && value !== null) {
          const reply = transport.set_subscription(value, now);
          if (record.refused !== undefined) {
            eq(reply, `{"refused":${record.refused}}`, "subscription");
            refusals++;
            continue;
          }
          eq(reply, `{"step":${record.step}}`, "subscription");
          taken(record.step);
          eq(transport.state(), record.state, "state");
          steps++;
          continue;
        }
        const calls = {
          subscription: () => transport.clear_subscription(now),
          connect: () => transport.connect(value.signal, now),
          disconnect: () => transport.disconnect(value, now),
          dispose: () => transport.dispose(now),
          request: () => transport.request(value, now),
          upload: () => transport.upload(value, now),
          download: () => transport.download(value, now),
          recovery: () => transport.recovery(value, now),
          abort: () => transport.abort(value, now),
          resolve: () => transport.resolve(value.id, value.outcome, now),
          text: () =>
            transport.resolve_text(value.id, received(value.text), now),
          socketOpen: () => transport.socket_open(value, now),
          socketError: () => transport.socket_error(value, now),
          socketClose: () => transport.socket_close(value, now),
          socketMessage: () =>
            transport.socket_message(value.socket, received(value.text), now),
          timer: () => transport.timer(value, now),
        };
        if (!(kind in calls)) throw Error(`${label}: unknown input`);
        let step;
        try {
          step = calls[kind]();
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
        taken(step);
        eq(transport.state(), record.state, "state");
        steps++;
      }
    } finally {
      transport?.free();
    }
  }
  return {
    moonrakerTransportScenarios: fixture.scenarios.length,
    moonrakerTransportSteps: steps,
    moonrakerTransportReplies: replies,
    moonrakerTransportRefusals: refusals,
    moonrakerTransportTexts: texts,
  };
}
