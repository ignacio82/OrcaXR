// The preset library exchange through a binding: every browser scenario of
// the preset library corpus, replayed from catalog and stored bytes, compared
// with the TypeScript authority's own contract encodings. Runs unchanged over
// WASM in Node and a browser worker, and over the JNI bridge. `policies` are
// the binding's trailing creation arguments: a collator, and for JNI a
// timestamp resolver and integer profile.
export function replayLibrary(core, fixture, bundledBytes, policies) {
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
  const limits = Float64Array.from([8 << 20, 1 << 20, 8 << 20, 64, 64]);
  const max = 8 << 20;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const upload = (bytes) => {
    const u = new core.ProfileCatalogUpload(bytes.length, limits);
    for (let p = 0; p < bytes.length; p += 65536)
      u.append(p, bytes.subarray(p, p + 65536));
    return u;
  };
  const catalogBytes = (name) =>
    name === "bundled" ? bundledBytes : encoder.encode(fixture.catalogs[name]);
  let replies = 0,
    refusals = 0;
  const issues = (library, expected, label) => {
    eq(library.issue_count(), expected.length, `${label} issue count`);
    for (const [i, json] of expected.entries()) {
      eq(library.issue(i), json, `${label} issue ${i}`);
      replies++;
    }
    refuses(() => library.issue(expected.length), `${label} issue past end`);
    refusals++;
  };
  for (const scenario of fixture.scenarios) {
    const name = scenario.name;
    const stored =
      scenario.stateJson !== undefined
        ? encoder.encode(scenario.stateJson)
        : typeof scenario.storedText === "string"
          ? encoder.encode(scenario.storedText)
          : undefined;
    const catalog = upload(catalogBytes(scenario.catalog));
    let library;
    try {
      library = core.PresetLibrary.create(catalog, stored, limits, ...policies);
      refuses(
        () => core.PresetLibrary.create(catalog, stored, limits, ...policies),
        `${name} consumed upload`,
      );
      refusals++;
    } finally {
      catalog.free();
    }
    try {
      issues(library, scenario.wire.createIssueJsons, `${name} create`);
      for (const [index, step] of scenario.steps.entries()) {
        const label = `${name} step ${index}`;
        const op = JSON.parse(step.opJson);
        const wire = step.wire;
        if (wire.operationJson !== undefined) {
          eq(library.apply(wire.operationJson), wire.outcomeJson, label);
          issues(library, wire.issueJsons, label);
        } else if (op.op === "import") {
          eq(
            library.import_bundle(encoder.encode(op.bundle), limits),
            wire.outcomeJson,
            label,
          );
          issues(library, wire.issueJsons, label);
        } else if (op.op === "export") {
          eq(
            decoder.decode(library.export_bundle(wire.exportedAt, max)),
            step.bundle,
            label,
          );
          refuses(
            () => library.export_bundle(wire.exportedAt, 1),
            `${label} output budget`,
          );
          refusals++;
        } else if (op.op === "plan" || op.op === "apply") {
          const next = upload(catalogBytes(op.catalog));
          try {
            if (op.op === "plan")
              eq(library.plan_update(next), wire.planJson, label);
            else eq(library.apply_update(next), wire.outcomeJson, label);
            refuses(
              () => library.plan_update(next),
              `${label} consumed update`,
            );
            refusals++;
          } finally {
            next.free();
          }
          issues(library, wire.issueJsons, label);
        } else if (op.op === "bases") {
          eq(library.bases(wire.requestJson), wire.basesJson, label);
        } else if (op.op === "inventory") {
          same(library.inventory(), wire.inventoryJson, label);
        } else if (op.op === "views") {
          eq(library.view(), wire.viewJson, label);
          for (const [i, json] of wire.customJsons.entries()) {
            eq(library.custom_preset(i), json, `${label} custom ${i}`);
            replies++;
          }
          refuses(
            () => library.custom_preset(wire.customJsons.length),
            `${label} custom past end`,
          );
          refusals++;
          const composed = library.catalog();
          try {
            eq(composed.preset_count(), wire.presetCount, `${label} presets`);
          } finally {
            composed.free();
          }
        } else fail(`unknown op ${op.op}`);
        eq(decoder.decode(library.state(max)), step.stateJson, `${label} state`);
        replies += 2;
      }
      refuses(() => library.apply("{}"), `${name} malformed operation`);
      refuses(() => library.state(1), `${name} state budget`);
      refusals += 2;
    } finally {
      library.free();
    }
  }
  for (const c of fixture.wire.coerceCases) {
    eq(core.coerce_override_value(c.requestJson), c.replyJson, "coerce");
    replies++;
  }
  for (const c of fixture.wire.formatCases) {
    eq(core.format_override_value(c.requestJson), c.replyJson, "format");
    replies++;
  }
  refuses(
    () =>
      core.coerce_override_value(
        JSON.stringify({ inheritedJson: { value: [123] }, text: [] }),
      ),
    "malformed inherited JSON",
  );
  refusals++;
  return { libraryReplies: replies, libraryRefusals: refusals };
}
