// The transform inspector's fields through a binding
// (`transform-field-vectors.json`): what every tool's fields show, every
// Euler ↔ quaternion conversion and every field edit's changes or refusal,
// compared byte for byte with the browser's replies, and every malformed
// request refused. Runs unchanged over WASM in Node and a browser worker, and
// over the JNI bridge.
export function replayTransformFields(core, fixture) {
  const fail = (label) => {
    throw Error(label);
  };
  const exchanges = {
    fields: (r) => core.transform_fields(r),
    edit: (r) => core.transform_field_edit(r),
    rotation: (r) => core.transform_rotation(r),
  };
  const counts = { fieldReads: 0, rotations: 0, fieldEdits: 0, fieldRefusals: 0 };
  for (const c of fixture.reads) {
    if (exchanges.fields(c.request) !== c.reply) fail(`fields ${c.request}: reply differs`);
    counts.fieldReads++;
  }
  for (const c of fixture.conversions) {
    if (exchanges.rotation(c.request) !== c.reply) fail(`rotation ${c.request}: reply differs`);
    counts.rotations++;
  }
  for (const c of fixture.edits) {
    if (exchanges.edit(c.request) !== c.reply) fail(`edit ${c.name}: reply differs`);
    counts.fieldEdits++;
  }
  for (const r of fixture.refusals) {
    let refused = false;
    try {
      exchanges[r.exchange](r.request);
    } catch (e) {
      if (!String(e?.message ?? e).includes("invalid_request")) throw e;
      refused = true;
    }
    if (!refused) fail(`${r.exchange} refusal ${r.request} was accepted`);
    counts.fieldRefusals++;
  }
  return counts;
}
