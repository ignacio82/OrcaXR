// Printer control through a binding: every availability, send plan, failure
// sentence, status summary and guarded-action list answers the browser's
// reply, and every hold-to-confirm step the browser's state. Runs unchanged
// over WASM in Node and a browser worker, and over the JNI bridge.
export function replayPrinterControl(core, fixture) {
  const eq = (actual, expected, label) => {
    if (actual !== expected) throw Error(`${label}: ${actual} !== ${expected}`);
  };
  const sections = {
    availability: core.print_job_availability,
    checks: core.print_job_command_plan,
    failures: core.print_job_command_failure,
    summaries: core.printer_status_summary,
    guarded: core.guarded_printer_actions,
  };
  const counts = {};
  for (const [section, answer] of Object.entries(sections)) {
    for (const [i, entry] of fixture[section].entries())
      eq(answer(entry.requestJson), entry.replyJson, `${section} ${i}`);
    counts[section] = fixture[section].length;
  }
  let steps = 0;
  for (const trace of fixture.holds) {
    const hold = new core.HoldToConfirm();
    try {
      for (const [i, step] of trace.steps.entries()) {
        const reply =
          step.op === "press"
            ? hold.press(step.actionJson, step.nowMs)
            : step.op === "poll"
              ? hold.poll(step.nowMs)
              : step.op === "cancel"
                ? hold.cancel()
                : hold.release(step.nowMs);
        eq(reply, step.replyJson, `${trace.name} step ${i}`);
        steps++;
      }
    } finally {
      hold.free();
    }
  }
  return {
    printerAvailability: counts.availability,
    printerChecks: counts.checks,
    printerFailures: counts.failures,
    printerSummaries: counts.summaries,
    printerGuarded: counts.guarded,
    printerHoldSteps: steps,
  };
}
