// The transform gizmo through a binding (`transform-gizmo-vectors.json`): the
// baked handle geometry byte for byte, every pointer sequence replayed
// through the state (attach, then one step per event) with each step's change
// flag and the SHA-256 of its view compared with the browser's, every drag's
// changes, and every malformed request refused. Runs unchanged over WASM in
// Node and a browser worker, and over the JNI bridge; `sha256` hashes bytes
// to lowercase hex.
export async function replayTransformGizmo(core, fixture, sha256) {
  const fail = (label) => {
    throw Error(label);
  };
  const encoder = new TextEncoder();
  const counts = { gizmoGeometry: 0, gizmoSequences: 0, gizmoSteps: 0, gizmoChanges: 0, gizmoRefusals: 0 };
  if (core.transform_gizmo_geometry() !== fixture.geometry) fail("gizmo geometry differs");
  counts.gizmoGeometry++;
  for (const c of fixture.sequences) {
    const r = JSON.parse(c.request);
    const scene =
      `"camera":${JSON.stringify(r.camera)},"mode":${JSON.stringify(r.mode)},` +
      `"root":${JSON.stringify(r.root)},"space":${JSON.stringify(r.space)}`;
    let state = core.transform_gizmo_attach(`{"proxy":${JSON.stringify(r.proxy)}}`);
    for (let i = 0; i < r.events.length; i++) {
      const step = c.steps[i];
      state = core.transform_gizmo_step(`{${scene},"event":${JSON.stringify(r.events[i])},"state":${state}}`);
      if (JSON.parse(state).changed !== step.changed) fail(`gizmo ${c.name} step ${i}: change differs`);
      const view = core.transform_gizmo_present(`{${scene},"state":${state}}`);
      if ((await sha256(encoder.encode(view))) !== step.view) fail(`gizmo ${c.name} step ${i}: view differs`);
      counts.gizmoSteps++;
    }
    counts.gizmoSequences++;
  }
  for (const c of fixture.changes) {
    if (core.transform_gizmo_changes(c.request) !== c.reply) fail(`gizmo changes ${c.name}: reply differs`);
    counts.gizmoChanges++;
  }
  const exchanges = {
    attach: (r) => core.transform_gizmo_attach(r),
    step: (r) => core.transform_gizmo_step(r),
    present: (r) => core.transform_gizmo_present(r),
    changes: (r) => core.transform_gizmo_changes(r),
  };
  for (const r of fixture.refusals) {
    let refused = false;
    try {
      exchanges[r.exchange](r.request);
    } catch (e) {
      if (!String(e?.message ?? e).includes("invalid_request")) throw e;
      refused = true;
    }
    if (!refused) fail(`gizmo ${r.exchange} refusal ${r.request} was accepted`);
    counts.gizmoRefusals++;
  }
  return counts;
}
