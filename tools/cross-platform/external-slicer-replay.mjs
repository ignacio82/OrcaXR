// The external slicer's policy through a binding: every endpoint, plan and
// read of the browser's corpus (`external-slicer-vectors.json`) answers the
// browser's reply byte for byte. Runs unchanged over WASM in Node and a
// browser worker, and over the JNI bridge.
export function replayExternalSlicer(core, fixture) {
  const sections = [
    ["attestations", core.external_slicer_attestation],
    ["jobPlans", core.external_slicer_job_plan],
    ["submissions", core.external_slicer_submission],
    ["polls", core.external_slicer_poll],
    ["cancels", core.external_slicer_cancel],
    ["artifacts", core.external_slicer_artifact],
  ];
  const expect = (section, i, actual, expected) => {
    if (actual !== expected)
      throw Error(
        `${section} ${i}: ${actual.slice(0, 400)} !== ${expected.slice(0, 400)}`,
      );
  };
  const counts = [0];
  for (const [i, c] of fixture.endpoints.entries()) {
    expect("endpoints", i, core.external_slicer_endpoint(c.requestJson), c.endpointJson);
    expect(
      "attestation plans",
      i,
      core.external_slicer_attestation_plan(c.requestJson),
      c.attestationPlanJson,
    );
    expect("submit plans", i, core.external_slicer_submit_plan(c.requestJson), c.submitPlanJson);
    counts[0]++;
  }
  for (const [section, answer] of sections) {
    let count = 0;
    for (const [i, c] of fixture[section].entries()) {
      expect(section, i, answer(c.requestJson), c.replyJson);
      count++;
    }
    counts.push(count);
  }
  // The pinned features each attested engine carries beyond stock.
  if (
    core.external_slicer_supports("wasm", "wave-overhangs") !== true ||
    core.external_slicer_supports("cli", "wave-overhangs") !== false
  )
    throw Error("pinned engine features");
  return { externalSlicerAnswers: counts };
}
