import { stagedInputOptions } from "./project-staged-replay.mjs";
// The same boundary checks use actual WASM owners and the actual JNI library.
export function projectStagedBoundaries(core, trace, layout, schema) {
  const encode = new TextEncoder(),
    source = encode.encode(trace.stateJson);
  const eq = (a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw Error("Command upload boundary mismatch");
  };
  let refusals = 0;
  const refuse = (fn) => {
    let rejected = false;
    try {
      fn();
    } catch {
      rejected = true;
    }
    if (!rejected)
      throw Error("Command upload boundary accepted invalid input");
    refusals++;
  };
  const open = () => {
    let upload = new core.ProjectUpload(
      layout.version,
      source.length,
      Float64Array.from([
        source.length,
        1_000_000,
        4_000_000,
        1024,
        128,
        10,
        16_777_216,
        33_554_432,
        100,
        33_554_432,
      ]),
    );
    try {
      for (let p = 0; p < source.length; p += 65536)
        upload.append_document(p, source.subarray(p, p + 65536));
      upload.seal_document();
      upload.begin_asset(0);
      upload.append_asset(0, Uint8Array.from(trace.asset.bytes));
      upload.finish_asset();
      const owned = upload;
      upload = undefined;
      return owned.open(Float64Array.from([0, 1, 2, 3]));
    } finally {
      upload?.free();
    }
  };
  const session = open(),
    guard = session.capture_guard();
  const units = (s) =>
    Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
  const plate = JSON.parse(trace.stateJson).plates[0];
  const intent = JSON.stringify({
    version: 1,
    command: {
      renamePlate: { plateId: units(plate.id), name: units("command upload") },
    },
  });
  const json = JSON.stringify([1, [0, [2, intent]]]),
    data = encode.encode(json);
  const options = stagedInputOptions(data.length, schema);
  // A payload-carrying record: a tetrahedron added as a volume. Its bytes stream
  // after the records, one declared payload at a time, and are validated.
  const fnv1a64 = (bytes) => {
    let h = 0xcbf29ce484222325n;
    for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return `fnv1a64:${h.toString(16).padStart(16, "0")}`;
  };
  const mesh = new Uint8Array(96);
  const view = new DataView(mesh.buffer);
  [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10].forEach((v, i) => view.setFloat32(i * 4, v, true));
  [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3].forEach((v, i) => view.setUint32(48 + i * 4, v, true));
  const descriptor = {
    id: "import:asset:boundary",
    kind: "mesh",
    digest: fnv1a64(mesh),
    byteLength: 96,
    mediaType: "application/vnd.orcaxr.indexed-mesh",
    mesh: {
      positions: { byteOffset: 0, byteLength: 48, componentType: "float32", componentCount: 3, count: 4 },
      indices: { byteOffset: 48, byteLength: 48, componentType: "uint32", componentCount: 1, count: 12 },
      triangleCount: 4,
    },
  };
  const volume = {
    id: "import:volume:boundary",
    name: "Boundary",
    role: "model",
    source: { assetId: descriptor.id, topologyRevision: 0, triangleCount: 4 },
    transform: { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    config: {},
    annotations: { topologyRevision: 0, color: [], support: [], seam: [], fuzzySkin: [], brim: [] },
  };
  const payloadData = encode.encode(
    JSON.stringify([
      1,
      [
        0,
        [
          Object.keys(schema.commandKinds).indexOf("addVolume"),
          plate.objects[0].id,
          volume,
          descriptor,
        ],
      ],
    ]),
  );
  const payloadOptions = stagedInputOptions(payloadData.length, schema);
  const sealedPayload = (bound = payloadOptions) => {
    let input = session.command_upload(guard, 1, payloadData.length, bound);
    try {
      input.append(0, payloadData);
      input.seal();
      const owned = input;
      input = undefined;
      return owned;
    } finally {
      input?.free();
    }
  };
  const payloadBoundaries = () => {
    session.configure_staging(
      1,
      Float64Array.from([4, 100, 8_000_000, 16_000_000]),
    );
    let input = sealedPayload();
    try {
      eq(input.asset_count(), 1);
      refuse(() => input.units());
      refuse(() => input.begin_asset(1));
      refuse(() => input.append_asset(0, mesh.subarray(0, 1)));
      eq(input.begin_asset(0), 96);
      refuse(() => input.begin_asset(0));
      refuse(() => input.append_asset(1, mesh.subarray(0, 1)));
      refuse(() => input.append_asset(0, new Uint8Array(0)));
      input.append_asset(0, mesh.subarray(0, 7));
      refuse(() => input.finish_asset());
      const tampered = mesh.slice(7);
      tampered[0] ^= 1;
      input.append_asset(7, tampered);
      // A digest mismatch discards only that payload; it can be streamed again.
      refuse(() => input.finish_asset());
      eq(input.begin_asset(0), 96);
      for (let p = 0; p < mesh.length; p += 5)
        input.append_asset(p, mesh.subarray(p, p + 5));
      input.finish_asset();
      eq(input.asset_count(), 0);
      eq(input.asset_bytes(), 96);
      const units = input.units();
      const owned = input;
      input = undefined;
      const id = session.stage_commands(owned);
      eq(Array.from(session.staging_usage()), [1, 1, units, 96]);
      eq(session.release_staged(id), true);
    } finally {
      input?.free();
    }
    // Admission needs every payload and consumes the upload either way.
    refuse(() => session.stage_commands(sealedPayload()));
    // Upload budgets refuse at sealing, before any payload byte arrives.
    for (const [field, value] of [
      ["assets", 0],
      ["assetBytes", 95],
    ]) {
      const bound = payloadOptions.slice();
      bound[schema.inputOptions.indexOf(field)] = value;
      refuse(() => sealedPayload(bound).free());
    }
  };
  const newInput = (owner = session, capture = guard) =>
    owner.command_upload(capture, 1, data.length, options);
  const ready = (owner = session, capture = guard) => {
    let input = newInput(owner, capture);
    try {
      const copy = data.slice();
      input.append(0, copy);
      copy.fill(0);
      input.seal();
      eq(input.units(), intent.length + '["intent",]'.length);
      eq(input.command_count(), 1);
      const result = input;
      input = undefined;
      return result;
    } finally {
      input?.free();
    }
  };
  try {
    eq(Array.from(session.staging_usage()), [0, 0, 0, 0]);
    refuse(() => session.stage_commands(ready())); // Disabled finished pool consumes input.
    for (const version of [-1, 0, 2]) {
      refuse(() =>
        session.configure_staging(
          version,
          Float64Array.from([4, 100, 8_000_000, 16_000_000]),
        ),
      );
      refuse(() =>
        session.command_upload(guard, version, data.length, options),
      );
    }
    for (const pool of [false, true]) {
      const base = pool ? [4, 100, 8_000_000, 16_000_000] : Array.from(options);
      const apply = (values) =>
        pool
          ? session.configure_staging(1, values)
          : session.command_upload(guard, 1, data.length, values).free();
      for (let i = 0; i < base.length; i++)
        for (const invalid of [-1, 0.5, NaN, Infinity, 4294967296]) {
          const values = base.slice();
          values[i] = invalid;
          refuse(() => apply(Float64Array.from(values)));
        }
      for (const length of [0, base.length - 1, base.length + 1])
        refuse(() => apply(new Float64Array(length)));
    }
    for (const [field, value] of [
      [3, 0],
      [4, 129],
    ]) {
      const bad = options.slice();
      bad[field] = value;
      refuse(() => session.command_upload(guard, 1, data.length, bad));
    }
    session.configure_staging(
      1,
      Float64Array.from([4, 100, 8_000_000, 16_000_000]),
    );
    for (const id of [0, -1, 9007199254740992])
      refuse(() => session.release_staged(id));
    eq(session.release_staged(Number.MAX_SAFE_INTEGER), false);
    const held = Array.from({ length: schema.maxPreparations }, () =>
      newInput(),
    );
    try {
      refuse(() => newInput());
      held[0].cancel();
      const replacement = newInput();
      replacement.free();
      for (let i = 1; i < held.length; i++) {
        held[i].append(0, data);
        held[i].seal();
      }
      const replacement2 = newInput();
      try {
        refuse(() => newInput());
      } finally {
        replacement2.free();
      }
    } finally {
      for (const input of held) input.free();
    }
    let input = newInput();
    try {
      refuse(() => input.append(1, data));
      refuse(() => input.append(0, new Uint8Array()));
      refuse(() => input.append(0, new Uint8Array(65537)));
      refuse(() => input.units());
      refuse(() => input.command_count());
      input.append(0, data);
      input.seal();
      refuse(() => input.seal());
      refuse(() => input.append(0, data));
      const owned = input;
      input = undefined;
      const id = session.stage_commands(owned);
      eq(session.release_staged(id), true);
    } finally {
      input?.free();
    }
    const malformed = [
      "{}",
      '[2,[0,[2,"{}"]]]',
      "[1,[2]]",
      "[1,[0,[9]]]",
      '[1,[0,[2,"é"]]]',
      '[1,[0,[2,"{}"],0]]',
      '[1,[1,"",{}]]',
    ];
    for (const json of malformed) {
      const data = encode.encode(json),
        input = session.command_upload(
          guard,
          1,
          data.length,
          stagedInputOptions(data.length, schema),
        );
      try {
        refuse(() => {
          input.append(0, data);
          input.seal();
        });
      } finally {
        input.free();
      }
    }
    for (const field of [0, 1, 2, 4, 5, 6]) {
      const bad = options.slice();
      bad[field] = field === 0 ? data.length - 1 : field === 5 ? 0 : 1;
      let input;
      try {
        refuse(() => {
          input = session.command_upload(guard, 1, data.length, bad);
          input.append(0, data);
          input.seal();
        });
      } finally {
        input?.free();
      }
    }
    // Malformed uploads release capacity immediately even if the caller still
    // retains the terminal wrappers awaiting cleanup.
    const failed = [];
    try {
      for (let i = 0; i < schema.maxPreparations; i++) {
        const input = session.command_upload(
          guard,
          1,
          3,
          stagedInputOptions(3, schema),
        );
        failed.push(input);
        refuse(() => input.append(0, Uint8Array.from([91, 255, 93])));
      }
      const held = Array.from({ length: schema.maxPreparations }, () =>
        newInput(),
      );
      for (const input of held) input.free();
    } finally {
      for (const input of failed) input.free();
    }
    refuse(() => session.stage_commands(newInput())); // Incomplete transfers are consumed too.
    const other = open(),
      foreign = other.capture_guard();
    try {
      refuse(() => session.command_upload(foreign, 1, data.length, options));
      refuse(() => other.stage_commands(ready()));
    } finally {
      foreign.free();
      other.free();
    }
    input = ready();
    let id = session.stage_commands(input);
    input = undefined;
    const charge = intent.length + '["intent",]'.length;
    eq(Array.from(session.staging_usage()), [1, 1, charge, 0]);
    refuse(() =>
      session.configure_staging(1, Float64Array.from([0, 0, 0, 0])),
    );
    session.configure_staging(1, Float64Array.from([1, 1, charge, 0]));
    refuse(() => session.stage_commands(ready()));
    eq(session.release_staged(id), true);
    payloadBoundaries();
    const stale = ready();
    const effects = session.acknowledge_checkpoint(guard);
    effects.free();
    refuse(() => session.stage_commands(stale));
    const current = session.capture_guard();
    try {
      const pending = ready(session, current);
      session.dispose();
      refuse(() => session.stage_commands(pending));
      refuse(() => session.command_upload(current, 1, data.length, options));
    } finally {
      current.free();
    }
  } finally {
    guard.free();
    session.free();
  }
  // A detached upload owns immutable captured data, never a live session. It
  // can be sealed/freed after source close, but cannot attach to a different owner.
  const sourceOwner = open(),
    original = sourceOwner.capture_guard();
  let detached = sourceOwner.command_upload(original, 1, data.length, options);
  original.free();
  sourceOwner.free();
  const destination = open();
  try {
    detached.append(0, data);
    detached.seal();
    const owned = detached;
    detached = undefined;
    refuse(() => destination.stage_commands(owned));
  } finally {
    detached?.free();
    destination.free();
  }
  return { commandUploadRefusals: refusals };
}
