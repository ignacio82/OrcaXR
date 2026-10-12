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
    ["downloads", core.external_slicer_download],
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

/**
 * The external route's metadata (`slice-sidecar-vectors.json`, from
 * `CanonicalSlicerClientRoute`): every captured endpoint with engines of every
 * shape answers the browser's metadata or its words, byte for byte, and each
 * malformed request is refused.
 */
export function replayExternalSlicerRoutes(core, fixture) {
  for (const [i, c] of fixture.routes.entries()) {
    const reply = core.external_slicer_route(c.request);
    if (reply !== c.reply) throw Error(`route ${i}: ${String(reply).slice(0, 200)}`);
  }
  for (const c of fixture.routeRefusals) {
    let refused = false;
    try {
      core.external_slicer_route(c.request);
    } catch (e) {
      if (!String(e?.message ?? e).includes("invalid_request")) throw e;
      refused = true;
    }
    if (!refused) throw Error(`route request ${c.request} was accepted`);
  }
  return { externalSlicerRoutes: [fixture.routes.length, fixture.routeRefusals.length] };
}
