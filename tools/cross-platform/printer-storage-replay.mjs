// Printer storage through a binding: every operation's plan, every finished
// exchange, every listing or metadata reply read and every size answers the
// browser's reply. Runs unchanged over WASM in Node and a browser worker, and
// over the JNI bridge.
export const storageBytes = (bytes) =>
  typeof bytes === "number"
    ? bytes
    : { NaN, Infinity, "-Infinity": -Infinity }[bytes];

export function replayPrinterStorage(core, fixture) {
  const counts = [0, 0, 0, 0];
  const expect = (section, i, actual, expected) => {
    if (actual !== expected)
      throw Error(
        `${section} ${i}: ${actual.slice(0, 400)} !== ${expected.slice(0, 400)}`,
      );
  };
  for (const [i, c] of fixture.plans.entries()) {
    expect("plans", i, core.printer_storage_plan(c.requestJson), c.replyJson);
    counts[0]++;
  }
  for (const [i, c] of fixture.finishes.entries()) {
    expect(
      "finishes",
      i,
      core.printer_storage_finish(c.requestJson),
      c.replyJson,
    );
    counts[1]++;
  }
  for (const [i, c] of fixture.reads.entries()) {
    expect(
      "reads",
      i,
      core.printer_storage_read(c.operationJson, c.reply),
      c.replyJson,
    );
    counts[2]++;
  }
  for (const [i, c] of fixture.sizes.entries()) {
    expect(
      "sizes",
      i,
      core.printer_storage_size(storageBytes(c.bytes)),
      c.replyJson,
    );
    counts[3]++;
  }
  return { printerStorageAnswers: counts };
}
