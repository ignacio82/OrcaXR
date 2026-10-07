export function projectBoundaries(core, base, layout, timestampCases) {
  const encoder = new TextEncoder();
  const check = (ok, label) => {
    if (!ok) throw Error(label);
  };
  let refusals = 0;
  const refuse = (operation, code) => {
    let failed = false;
    try {
      operation();
    } catch (e) {
      failed = true;
      if (code) check(String(e) === code, `Wrong refusal: ${code}`);
      check(!String(e).includes("PRIVATE"), "Private error disclosure");
    }
    check(failed, "Expected refusal");
    refusals++;
  };
  const options = (source) =>
    Float64Array.from([
      source.length,
      1_000_000,
      4_000_000,
      1024,
      128,
      10,
      16 * 1024 * 1024,
      32 * 1024 * 1024,
      100,
      32 * 1024 * 1024,
    ]);
  const input = (state = base) => {
    const bytes = encoder.encode(JSON.stringify(state));
    const upload = new core.ProjectUpload(1, bytes.length, options(bytes));
    for (let p = 0; p < bytes.length; p += 65536)
      upload.append_document(p, bytes.subarray(p, p + 65536));
    return upload;
  };
  const open = () => {
    const upload = input();
    upload.seal_document();
    return upload.open(Float64Array.from([1, 2, 3, 4]));
  };
  const bytes = encoder.encode(JSON.stringify(base));
  for (const version of [0, 2, -1, 1.5, NaN, Infinity])
    refuse(
      () => new core.ProjectUpload(version, bytes.length, options(bytes)),
      "invalid_options",
    );
  for (const value of [-1, 1.5, NaN, Infinity, 4294967296])
    for (let i = 0; i < 10; i++) {
      const values = options(bytes);
      values[i] = value;
      refuse(
        () => new core.ProjectUpload(1, bytes.length, values),
        "invalid_options",
      );
    }
  for (const n of [0, 9, 11])
    refuse(
      () => new core.ProjectUpload(1, bytes.length, new Float64Array(n)),
      "invalid_options",
    );
  for (const value of [-1, 0.5, NaN, Infinity, 4294967296])
    refuse(
      () => new core.ProjectUpload(1, value, options(bytes)),
      "invalid_range",
    );
  const tooDeep = options(bytes);
  tooDeep[4] = 129;
  refuse(
    () => new core.ProjectUpload(1, bytes.length, tooDeep),
    "invalid_options",
  );
  const numberZero = options(bytes);
  numberZero[3] = 0;
  refuse(
    () => new core.ProjectUpload(1, bytes.length, numberZero),
    "invalid_options",
  );
  for (const nonce of [
    [0, 1, 2],
    [0, 1, 2, 3, 4],
    [0, 1, 2, -1],
    [0, 1, 2, NaN],
    [0, 1, 2, 4294967296],
  ]) {
    const upload = input();
    upload.seal_document();
    refuse(() => upload.open(Float64Array.from(nonce)));
  }
  const malformed = new core.ProjectUpload(1, 2, options(bytes));
  try {
    refuse(() => malformed.append_document(0, Uint8Array.from([255, 0])));
    refuse(() => malformed.seal_document());
    refuse(() => malformed.seal_document(), "invalid_state");
  } finally {
    malformed.free();
  }
  const a = open(),
    b = open(),
    guard = a.capture_guard(),
    snapshot = a.snapshot(),
    history = a.history();
  try {
    check(a.is_current(guard) && a.is_export_current(guard), "own guard");
    check(!b.is_current(guard) && !b.is_export_current(guard), "foreign guard");
    refuse(() => b.acknowledge_checkpoint(guard), "stale_or_disposed");
    refuse(() => snapshot.export_json(0), "output_limit");
    const data = snapshot.export_json(8 * 1024 * 1024);
    try {
      const head = data.read(0, Math.min(data.length(), 65536));
      const original = head[0];
      head[0] ^= 255;
      check(data.read(0, 1)[0] === original, "owned output isolation");
      for (const [start, count] of [
        [-1, 1],
        [0, -1],
        [0, 65537],
        [data.length(), 1],
        [0, NaN],
        [0, 0.5],
        [NaN, 1],
      ])
        refuse(() => data.read(start, count), "invalid_range");
    } finally {
      data.free();
    }
    refuse(() => snapshot.id(0, 16385), "invalid_range");
    refuse(() => history.label_text(true, 0, 0), "missing_label");
    const refs = new core.ProjectSelectionInput();
    try {
      refuse(() => refs.add(1, new Uint16Array()), "invalid_selection");
      refuse(() => refs.add(99, new Uint16Array()), "invalid_selection");
      refuse(() => refs.add(0, Uint16Array.of(1)), "invalid_selection");
      refuse(() => refs.add(1, new Uint16Array(131073)), "input_limit");
    } finally {
      refs.free();
    }
    const effects = a.acknowledge_checkpoint(guard);
    effects.free();
    check(
      !a.is_current(guard) && a.is_export_current(guard),
      "history-only save guard",
    );
    a.dispose();
    check(
      !a.is_current(guard) && !a.is_export_current(guard),
      "disposed guard",
    );
    refuse(() => a.capture_guard(), "disposed");
  } finally {
    history.free();
    snapshot.free();
    guard.free();
    a.free();
    b.free();
  }
  let timestamps = 0;
  for (const test of timestampCases) {
    const text = String.fromCharCode(...test.units);
    const expected = Number.isFinite(Date.parse(text));
    const upload = input({ ...base, createdAt: text, updatedAt: text });
    let admitted = false;
    try {
      try {
        upload.seal_document();
        admitted = true;
      } catch (e) {
        check(String(e) === "invalid_document", "Timestamp refusal");
      }
      check(admitted === expected, "Timestamp authority mismatch");
      timestamps++;
    } finally {
      upload.free();
    }
  }
  // Cross multiple bounded UTF-16 conversions and propagate service failure.
  const long = " ".repeat(100_000) + "2026/10/05 GMT";
  const upload = input({ ...base, createdAt: long, updatedAt: long });
  try {
    check(Number.isFinite(Date.parse(long)), "long date oracle");
    upload.seal_document();
  } finally {
    upload.free();
  }
  const original = Date.parse;
  try {
    Date.parse = () => {
      throw Error("PRIVATE_TIMESTAMP_SERVICE");
    };
    const upload = input();
    try {
      refuse(() => upload.seal_document(), "timestamp_service");
    } finally {
      upload.free();
    }
  } finally {
    Date.parse = original;
  }
  return { refusals, timestamps };
}
