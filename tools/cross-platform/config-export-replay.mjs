// File → Export Config… through a binding (`config-export-vectors.json`): the
// bundled catalog and each synthetic catalog streamed from their JSON text and
// built, then every profile's `orcaxr_config.json` written byte for byte
// (the bundled profiles by SHA-256 and length, the synthetic ones whole),
// found by profile ID. Runs unchanged over WASM in Node and a browser worker,
// and over the JNI bridge. `collator` is an optional host collator object.
export async function replayConfigExports(core, fixture, bundledBytes, collator, sha256) {
  const fail = (label) => {
    throw Error(label);
  };
  const eq = (actual, expected, label) => {
    if (actual !== expected) fail(`${label}: ${actual} !== ${expected}`);
  };
  const limits = Float64Array.from([8 << 20, 1 << 20, 8 << 20, 64, 64]);
  const encoder = new TextEncoder();
  const build = (bytes) => {
    const upload = new core.ProfileCatalogUpload(bytes.length, limits);
    try {
      for (let p = 0; p < bytes.length; p += 65536) upload.append(p, bytes.subarray(p, p + 65536));
      return upload.build(collator);
    } finally {
      upload.free();
    }
  };
  const files = (catalog) => {
    const byId = new Map();
    for (let i = 0; i < catalog.profile_count(); i++)
      byId.set(JSON.parse(catalog.profile(i)).id.map((u) => String.fromCharCode(u)).join(""), catalog.config_export(i));
    return byId;
  };
  const counts = { bundled: 0, synthetic: 0 };
  const bundled = build(bundledBytes);
  try {
    const written = files(bundled);
    eq(written.size, fixture.bundled.profiles.length, "bundled profiles");
    for (const c of fixture.bundled.profiles) {
      const bytes = encoder.encode(written.get(c.id));
      eq(bytes.length, c.bytes, `bundled ${c.id} length`);
      eq(await sha256(bytes), c.sha256, `bundled ${c.id}`);
      counts.bundled++;
    }
  } finally {
    bundled.free();
  }
  for (const [n, s] of fixture.synthetic.entries()) {
    const catalog = build(encoder.encode(s.catalogText));
    try {
      const written = files(catalog);
      for (const c of s.profiles) {
        eq(written.get(c.id), c.json, `synthetic ${n} ${c.id}`);
        counts.synthetic++;
      }
    } finally {
      catalog.free();
    }
  }
  return { configExportAnswers: [counts.bundled, counts.synthetic] };
}
