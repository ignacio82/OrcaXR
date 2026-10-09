// Print preparation and submission checks through a binding: every
// capability reply, assessment, plan, send, readiness, name, failure and
// identity answers the browser's reply. Runs unchanged over WASM in Node and
// a browser worker, and over the JNI bridge.
export function replayPrinterPreparation(core, fixture) {
  const eq = (actual, expected, label) => {
    if (actual !== expected) throw Error(`${label}: ${actual} !== ${expected}`);
  };
  const parsers = {
    objects: core.printer_objects,
    components: core.server_components,
    commands: core.gcode_commands,
  };
  for (const [i, c] of fixture.capabilities.entries())
    eq(parsers[c.kind](c.text), c.replyJson, `capability ${i}`);
  const sections = {
    options: (c) => core.print_start_options(c.requestJson),
    plans: (c) => core.print_preparation_plan(c.requestJson),
    sends: (c) => core.print_preparation_send(c.requestJson),
    readiness: (c) => core.print_readiness(c.text),
    readinessFailures: (c) => core.print_readiness_failure(c.requestJson),
    filenames: (c) => core.sanitize_gcode_filename(c.requestJson),
    failures: (c) => core.describe_transport_failure(c.requestJson),
    identities: (c) => core.print_file_identity(c.text, c.requestJson),
  };
  let answers = fixture.capabilities.length;
  for (const [section, answer] of Object.entries(sections))
    for (const [i, c] of fixture[section].entries()) {
      eq(answer(c), c.replyJson, `${section} ${i}`);
      answers++;
    }
  return { printerPreparationAnswers: answers };
}
