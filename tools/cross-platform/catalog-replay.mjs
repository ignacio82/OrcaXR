// The profile catalog exchange through a binding: stream the browser's bundled
// catalog (and a refused one), then compare every contract reply with the
// TypeScript authority's own encoding. Runs unchanged over WASM in Node and a
// browser worker, and over the JNI bridge. `collator` is an optional host
// collator object; the JNI bridge passes none.
export function replayCatalogs(core, fixture, bundledBytes, collator) {
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
  const encoder = new TextEncoder();
  let replies = 0,
    refusals = 0;
  const sources = [
    ["bundled", bundledBytes, collator],
    ["refused", encoder.encode(fixture.cases.references.inputJson), undefined],
  ];
  for (const [name, bytes, host] of sources) {
    const expected = fixture.exchanges[name];
    const upload = new core.ProfileCatalogUpload(bytes.length, limits);
    let catalog;
    try {
      refuses(
        () => upload.append(1, bytes.subarray(0, 1)),
        `${name} out-of-order chunk`,
      );
      for (let p = 0; p < bytes.length; p += 65536)
        upload.append(p, bytes.subarray(p, p + 65536));
      catalog = upload.build(host);
      refuses(() => upload.build(host), `${name} rebuild`);
      refusals += 2;
    } finally {
      upload.free();
    }
    try {
      const all = (count, read, items, label) => {
        eq(count, items.length, `${name} ${label} count`);
        for (const [i, json] of items.entries()) {
          eq(read(i), json, `${name} ${label}[${i}]`);
          replies++;
        }
        refuses(() => read(items.length), `${name} ${label} past end`);
        refusals++;
      };
      all(
        catalog.diagnostic_count(),
        (i) => catalog.diagnostic(i),
        expected.diagnosticJsons,
        "diagnostic",
      );
      all(
        catalog.preset_count(),
        (i) => catalog.preset(i),
        expected.presetJsons,
        "preset",
      );
      eq(
        catalog.profile_count(),
        expected.profileCount,
        `${name} profile count`,
      );
      for (const p of expected.profiles) {
        eq(
          catalog.profile(p.index),
          p.profileJson,
          `${name} profile ${p.index}`,
        );
        eq(
          catalog.profile_config(p.index),
          p.configJson,
          `${name} config ${p.index}`,
        );
        replies += 2;
      }
      for (const s of expected.selections) {
        eq(
          catalog.reconcile(s.requestJson),
          s.resultJson,
          `${name} ${s.requestJson}`,
        );
        replies++;
      }
      for (const t of expected.targets) {
        same(
          catalog.preflight_target(t.requestJson, 64),
          t.resultJson,
          `${name} ${t.requestJson}`,
        );
        replies++;
      }
      refuses(() => catalog.reconcile("{}"), `${name} malformed selection`);
      refuses(
        () => catalog.preflight_target(expected.targets[0].requestJson, 0),
        `${name} tool budget`,
      );
      refusals += 2;
    } finally {
      catalog.free();
    }
  }
  return { catalogReplies: replies, catalogRefusals: refusals };
}
