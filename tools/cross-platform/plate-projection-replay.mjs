// One plate projected for an external slicer through a binding: every case of
// the browser's corpus (`plate-projection-vectors.json`) projects to the
// browser's state text, hash and kept assets, or is refused with its message,
// and overrides the browser's print configuration byte for byte. Runs
// unchanged over WASM in Node and a browser worker, and over the JNI bridge.

/** The corpus's cases with their source state and plate ID as JSON text
 * (the states the corpus names live in `project-model-vectors.json`). */
export function plateProjectionCases(fixture, model) {
  const named = new Map([
    ...model.factories.map((f) => [`factory:${f.seed}`, f.stateJson]),
    ...model.cases.map((c) => [`case:${c.name}`, c.stateJson]),
  ]);
  return fixture.cases.map((c) => {
    const stateJson = c.sourceJson ?? named.get(c.source);
    if (stateJson === undefined) throw Error(`unknown source ${c.source}`);
    return {
      source: c.source,
      stateJson,
      plateIdJson:
        c.plateIndex === undefined
          ? c.plateIdJson
          : JSON.stringify(JSON.parse(stateJson).plates[c.plateIndex].id),
      omittedJson: c.omittedJson ?? "[]",
      result: c.result,
      overridesJson: c.overridesJson,
    };
  });
}

/** A corpus refusal's code, as the bindings report it. */
export const plateProjectionCode = (error) =>
  ({
    "unknown-plate": "plate_projection_unknown_plate",
    "plate-not-printable": "plate_projection_not_printable",
    "missing-asset": "plate_projection_missing_asset",
  })[error] ?? error;

export function replayPlateProjection(core, cases) {
  const counts = [0, 0, 0];
  const fail = (i, what) => {
    throw Error(`plate projection ${i} (${cases[i].source}): ${what}`);
  };
  for (const [i, c] of cases.entries()) {
    const answer = JSON.parse(core.plate_projection(c.stateJson, c.plateIdJson, c.omittedJson));
    if (c.result.error === undefined) {
      if (answer.stateJson !== c.result.stateJson) fail(i, "state");
      if (answer.sourceHash !== c.result.sourceHash) fail(i, "hash");
      if (JSON.stringify(answer.assetIds) !== JSON.stringify(JSON.parse(c.result.assetIdsJson)))
        fail(i, "assets");
      counts[0]++;
    } else {
      if (answer.error !== plateProjectionCode(c.result.error)) fail(i, `code ${answer.error}`);
      if (answer.message !== JSON.parse(c.result.messageJson)) fail(i, "message");
      counts[1]++;
    }
    if (core.plate_print_overrides(c.stateJson, c.plateIdJson) !== c.overridesJson) fail(i, "overrides");
    counts[2]++;
  }
  return { plateProjectionAnswers: counts };
}
