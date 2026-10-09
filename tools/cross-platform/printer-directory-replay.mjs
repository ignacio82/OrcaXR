// The printer directory through a binding: every load, save and edit answers
// the browser's reply. Runs unchanged over WASM in Node and a browser worker,
// and over the JNI bridge.
export function replayPrinterDirectory(core, fixture) {
  const sections = {
    loads: (c) => [
      core.printer_directory_load(c.stored ?? undefined),
      c.replyJson,
    ],
    saves: (c) => [core.printer_directory_save(c.requestJson), c.stored],
    adds: (c) => [core.printer_directory_add(c.requestJson), c.replyJson],
    updates: (c) => [core.printer_directory_update(c.requestJson), c.replyJson],
    removes: (c) => [core.printer_directory_remove(c.requestJson), c.replyJson],
    defaults: (c) => [
      core.printer_directory_set_default(c.requestJson),
      c.replyJson,
    ],
    adopts: (c) => [core.printer_directory_adopt(c.requestJson), c.replyJson],
  };
  const counts = [];
  for (const [section, answer] of Object.entries(sections)) {
    for (const [i, c] of fixture[section].entries()) {
      const [actual, expected] = answer(c);
      if (actual !== expected)
        throw Error(
          `${section} ${i}: ${actual.slice(0, 400)} !== ${expected.slice(0, 400)}`,
        );
    }
    counts.push(fixture[section].length);
  }
  return { printerDirectoryAnswers: counts };
}
