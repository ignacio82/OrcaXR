// Print history through a binding: every plan, finished exchange, reply
// read, duration, length, job, totals and page description answers the
// browser's reply. Runs unchanged over WASM in Node and a browser worker, and
// over the JNI bridge.
export const historyNumber = (value) =>
  typeof value === "number"
    ? value
    : { NaN, Infinity, "-Infinity": -Infinity }[value];

export function replayPrintHistory(core, fixture) {
  const sections = {
    plans: (c) => core.print_history_plan(c.requestJson),
    finishes: (c) => core.print_history_finish(c.requestJson),
    reads: (c) => core.print_history_read(c.operationJson, c.reply),
    durations: (c) => core.print_history_duration(historyNumber(c.seconds)),
    filaments: (c) => core.print_history_filament(historyNumber(c.millimetres)),
    jobViews: (c) => core.print_history_job_view(c.requestJson),
    totalsTexts: (c) => core.print_history_totals_text(c.requestJson),
    pageViews: (c) => core.print_history_page_view(c.requestJson),
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
  return { printHistoryAnswers: counts };
}
