// Printer cameras through a binding: every listing read and finished, frame
// route and failure, route list, description, poll interval and frame URL
// answers the browser's reply. Runs unchanged over WASM in Node and a browser
// worker, and over the JNI bridge.
export function replayPrinterCamera(core, fixture) {
  const sections = {
    listReads: (c) => core.camera_list_read(c.requestJson, c.reply),
    listFinishes: (c) => core.camera_list_finish(c.requestJson),
    snapshotPlans: (c) => core.camera_snapshot_plan(c.requestJson),
    snapshotFailures: (c) => core.camera_snapshot_failure(c.requestJson),
    mechanisms: (c) => core.camera_mechanisms(c.requestJson),
    describes: (c) => core.camera_describe(c.requestJson),
    frameUrls: (c) => core.camera_frame_url(c.requestJson),
  };
  if (core.camera_list_plan() !== fixture.listPlan.replyJson)
    throw Error(`listPlan: ${core.camera_list_plan()}`);
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
  for (const [i, c] of fixture.pollIntervals.entries()) {
    const actual = core.camera_poll_interval(c.requestJson);
    if (!Object.is(actual, c.intervalMs))
      throw Error(`pollIntervals ${i}: ${actual} !== ${c.intervalMs}`);
  }
  counts.push(fixture.pollIntervals.length);
  return { printerCameraAnswers: counts };
}
