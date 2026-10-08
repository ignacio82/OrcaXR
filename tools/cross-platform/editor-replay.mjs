// The settings editor exchange through a binding: queries, draft editors,
// steps, stepper rows and Full Spectrum rules, compared with the TypeScript
// authority's own contract encodings. Runs unchanged over WASM in Node and a
// browser worker, and over the JNI bridge. `policies` are the binding's
// trailing editor arguments: a collator and a search folder.
export function replayEditor(core, fixture, policies) {
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const refuses = (fn, label) => {
    let rejected = false;
    try {
      fn();
    } catch {
      rejected = true;
    }
    if (!rejected) fail(label);
  };
  // Numbers are semantic on this contract (Rust writes 4 as 4.0).
  const same = (actual, expected, label) =>
    eq(
      JSON.stringify(JSON.parse(actual)),
      JSON.stringify(JSON.parse(expected)),
      label,
    );
  const text = (units) => String.fromCharCode(...units);
  const wire = fixture.wire;
  let replies = 0,
    refusals = 0;
  const editor = (createJson) => new core.SettingsEditor(createJson, ...policies);

  // Field queries, every position's ID and sampled encodings.
  const queries = editor(wire.queryEditorJson);
  try {
    for (const [n, q] of wire.queries.entries()) {
      const expected = fixture.queryCases[n].fields.map((f) =>
        Array.isArray(f) ? f[0] : f,
      );
      eq(queries.query(q.requestJson), q.count, `query ${n} count`);
      eq(q.count, expected.length, `query ${n} fixture`);
      const samples = new Map(q.samples);
      for (let i = 0; i < q.count; i++) {
        const json = queries.field(i);
        if (samples.has(i)) same(json, samples.get(i), `query ${n} field ${i}`);
        else
          eq(
            text(JSON.parse(json).id),
            wire.ids[expected[i]],
            `query ${n} field ${i} id`,
          );
        replies++;
      }
      refuses(() => queries.field(q.count), `query ${n} past end`);
      refusals++;
    }
  } finally {
    queries.free();
  }

  // Draft editors: states, comparisons, edits and commits, step by step.
  for (const [n, scenario] of wire.editors.entries()) {
    if (scenario.refused) {
      refuses(() => editor(scenario.createJson), `editor ${n} refused`);
      refusals++;
      continue;
    }
    const e = editor(scenario.createJson);
    try {
      for (const [i, step] of scenario.steps.entries()) {
        const label = `editor ${n} step ${i}`;
        const op = JSON.parse(fixture.editors[n].steps[i].stepJson).op;
        if (step.refused) {
          refuses(
            () =>
              op === "state" ? e.state(step.requestJson) : e.compare(step.requestJson),
            label,
          );
          refusals++;
        } else if (op === "state") same(e.state(step.requestJson), step.replyJson, label);
        else if (op === "compare") eq(e.compare(step.requestJson), step.replyJson, label);
        else if (op === "commit") eq(e.commit(), step.replyJson, label);
        else eq(e.edit(step.requestJson), step.replyJson, label);
        eq(e.revision(), step.revision, `${label} revision`);
        eq(e.overrides(), step.overridesJson, `${label} overrides`);
        replies++;
      }
      refuses(() => e.edit("{}"), `editor ${n} malformed edit`);
      refusals++;
    } finally {
      e.free();
    }
  }

  // Steps and Full Spectrum rules.
  for (const [i, s] of wire.steps.entries()) {
    eq(core.settings_step(s.requestJson), s.replyJson, `step ${i}`);
    replies++;
  }
  for (const [i, r] of wire.rules.entries()) {
    eq(core.settings_rules(r.requestJson), r.replyJson, `rules ${i}`);
    replies++;
  }

  // Stepper rows for every scope.
  for (const [n, view] of wire.rows.entries()) {
    const e = editor(view.createJson);
    try {
      eq(e.rows(view.requestJson), view.count, `rows ${n} count`);
      eq(e.unavailable(), view.unavailable, `rows ${n} unavailable`);
      const samples = new Map(view.samples);
      const expected = fixture.rowCases[n].rows;
      for (let i = 0; i < view.count; i++) {
        const json = e.row(i);
        if (samples.has(i)) same(json, samples.get(i), `rows ${n} row ${i}`);
        else
          eq(
            text(JSON.parse(json).field.id),
            wire.ids[expected[i].field],
            `rows ${n} row ${i} id`,
          );
        replies++;
      }
      refuses(() => e.row(view.count), `rows ${n} past end`);
      refusals++;
    } finally {
      e.free();
    }
  }
  refuses(
    () => core.settings_step(JSON.stringify({ fieldId: [120], current: [], up: true })),
    "unknown step field",
  );
  refusals++;
  return { editorReplies: replies, editorRefusals: refusals };
}
