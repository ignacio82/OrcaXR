// The printer console through a binding: every assessment, plan, finished
// exchange, reply read, invocation and transcript line answers the browser's
// reply. Runs unchanged over WASM in Node and a browser worker, and over the
// JNI bridge.
export function replayPrinterConsole(core, fixture) {
  const sections = {
    assessments: (c) => core.console_assess(c.requestJson),
    plans: (c) => core.console_plan(c.requestJson),
    finishes: (c) => core.console_finish(c.requestJson),
    reads: (c) => core.console_read(c.operationJson, c.reply),
    invocations: (c) => core.console_invocation(c.requestJson),
    lines: (c) => core.console_line(c.requestJson),
    notifications: (c) => core.console_notification(c.requestJson, c.params),
    recents: (c) => core.console_recent(c.requestJson),
  };
  const counts = [];
  for (const [section, answer] of Object.entries(sections)) {
    for (const [i, c] of fixture[section].entries()) {
      const actual = answer(c);
      if (actual !== c.replyJson)
        throw Error(
          `${section} ${i}: ${actual.slice(0, 400)} !== ${c.replyJson.slice(0, 400)}`,
        );
    }
    counts.push(fixture[section].length);
  }
  return { printerConsoleAnswers: counts };
}
