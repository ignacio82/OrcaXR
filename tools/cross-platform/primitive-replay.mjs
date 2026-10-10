// Primitives and helper volumes through a binding (`primitive-vectors.json`):
// every mesh payload compared byte for byte (or by length and FNV digest at
// the sizes the corpus records only so), each malformed request refused, and
// every recorded state opened as a real session (its document and assets)
// that plans each primitive object and helper volume exactly as the browser
// built them. Runs unchanged over WASM in Node and a browser worker, and over
// the JNI bridge; `b64` decodes the corpus's base64.
export function replayPrimitives(core, fixture, layout, b64) {
  const encode = new TextEncoder();
  const fail = (label) => {
    throw Error(label);
  };
  const refused = (label, run) => {
    try {
      run();
    } catch (e) {
      if (!String(e?.message ?? e).includes("invalid_request")) throw e;
      return;
    }
    fail(`${label} was accepted`);
  };
  const fnv = (bytes) => {
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
  };
  let meshes = 0;
  let exactMeshes = 0;
  let meshRefusals = 0;
  for (const mesh of fixture.meshes) {
    const bytes = core.primitive_payload(mesh.request);
    if (bytes.length !== mesh.byteLength) fail(`${mesh.request}: ${bytes.length} bytes`);
    if (fnv(bytes) !== mesh.digest) fail(`${mesh.request}: digest differs`);
    if (mesh.payload !== undefined) {
      const expected = b64(mesh.payload);
      if (expected.length !== bytes.length || expected.some((b, i) => b !== bytes[i])) fail(`${mesh.request}: bytes differ`);
      exactMeshes++;
    }
    meshes++;
  }
  for (const r of fixture.meshRefusals) {
    refused(`mesh ${r.name}`, () => core.primitive_payload(r.request));
    meshRefusals++;
  }
  const open = (entry) => {
    const source = encode.encode(entry.stateJson);
    const options = {
      documentBytes: source.length,
      documentNodes: 1_000_000,
      documentTextUnits: 2_000_000,
      numberBytes: 1024,
      depth: 128,
      assets: entry.assets.length,
      assetBytes: 16 * 1024 * 1024,
      totalAssetBytes: 32 * 1024 * 1024,
      historyEntries: 100,
      historyBytes: 32 * 1024 * 1024,
    };
    const upload = new core.ProjectUpload(
      layout.version,
      source.length,
      Float64Array.from(layout.options.map((k) => options[k])),
    );
    try {
      for (let p = 0; p < source.length; p += layout.maxChunkBytes)
        upload.append_document(p, source.subarray(p, p + layout.maxChunkBytes));
      upload.seal_document();
      if (upload.asset_count() !== entry.assets.length) fail(`${entry.name}: asset count`);
      // Assets stream in the order the document declares them.
      const declared = JSON.parse(entry.stateJson).sourceAssets.map((a) => a.id);
      for (const [index, id] of declared.entries()) {
        const asset = entry.assets.find((a) => JSON.parse(a.descriptorJson).id === id);
        const bytes = b64(asset.bytes);
        if (upload.begin_asset(index) !== bytes.length) fail(`${entry.name}: asset ${id} length`);
        for (let p = 0; p < bytes.length; p += layout.maxChunkBytes)
          upload.append_asset(p, bytes.subarray(p, p + layout.maxChunkBytes));
        upload.finish_asset();
      }
    } catch (e) {
      upload.free();
      throw e;
    }
    return upload.open(Float64Array.from([1, 2, 3, 4]));
  };
  let plans = 0;
  let planRefusals = 0;
  // One session at a time: a host bounds how many it holds.
  for (const entry of fixture.states) {
    const session = open(entry);
    try {
      for (const plan of entry.plans) {
        const reply =
          plan.kind === "primitive" ? session.plan_primitive_object(plan.request) : session.plan_helper_volume(plan.request);
        if (reply !== plan.reply) fail(`${entry.name} ${plan.request}: reply differs`);
        plans++;
      }
      for (const r of fixture.planRefusals.filter((r) => (r.state ?? "empty") === entry.name)) {
        refused(`plan ${r.name}`, () =>
          r.kind === "primitive" ? session.plan_primitive_object(r.request) : session.plan_helper_volume(r.request),
        );
        planRefusals++;
      }
    } finally {
      session.free();
    }
  }
  if (planRefusals !== fixture.planRefusals.length) fail("a plan refusal names no state");
  return {
    primitiveMeshes: meshes,
    exactPrimitiveMeshes: exactMeshes,
    primitiveMeshRefusals: meshRefusals,
    primitivePlans: plans,
    primitivePlanRefusals: planRefusals,
  };
}
