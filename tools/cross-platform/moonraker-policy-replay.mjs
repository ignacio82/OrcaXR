// The Moonraker transport policy through a binding: every endpoint, path,
// credential check, refused response, handshake, reconnect policy and delay,
// subscription and method check answers the browser's reply. Runs unchanged
// over WASM in Node and a browser worker, and over the JNI bridge.
export function replayMoonrakerPolicy(core, fixture) {
  const sections = {
    endpoints: core.moonraker_endpoint,
    paths: core.moonraker_path,
    credentials: core.moonraker_credentials,
    errors: core.moonraker_error_response,
    handshakes: core.moonraker_handshake,
    policies: core.moonraker_reconnect_policy,
    subscriptions: core.moonraker_subscription,
    methods: core.moonraker_method_check,
  };
  let answers = 0;
  for (const [section, answer] of Object.entries(sections))
    for (const [i, c] of fixture[section].entries()) {
      const actual = answer(c.requestJson);
      if (actual !== c.replyJson)
        throw Error(`${section} ${i}: ${actual} !== ${c.replyJson}`);
      answers++;
    }
  for (const [i, c] of fixture.delays.entries()) {
    const actual = core.moonraker_reconnect_delay(c.requestJson);
    if (!Object.is(actual, c.delayMs))
      throw Error(`delays ${i}: ${actual} !== ${c.delayMs}`);
    answers++;
  }
  return { moonrakerPolicyAnswers: answers };
}
