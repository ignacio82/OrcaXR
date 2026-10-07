import assert from "node:assert/strict";
import { projectJniCore } from "./project-jni-bridge.mjs";

export function projectJniBoundaries(call, base, corpus, generation) {
  const bytesFor = (state) => new TextEncoder().encode(JSON.stringify(state));
  const options = (bytes) =>
    Float64Array.from([
      bytes.length,
      1_000_000,
      4_000_000,
      1024,
      128,
      10,
      16_777_216,
      33_554_432,
      100,
      33_554_432,
    ]);
  const units = (s) =>
    Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
  let refusals = 0;
  const refuse = (operation, code) => {
    assert.throws(operation, (e) => {
      assert.equal(String(e), code);
      return true;
    });
    refusals++;
  };
  const core = projectJniCore(call);
  const staged = (state = base, host = core) => {
    const bytes = bytesFor(state),
      u = new host.ProjectUpload(1, bytes.length, options(bytes));
    try {
      for (let p = 0; p < bytes.length; p += 65536)
        u.append_document(p, bytes.subarray(p, p + 65536));
    } catch (e) {
      u.free();
      throw e;
    }
    return u;
  };
  const open = () => {
    const u = staged();
    try {
      u.seal_document();
      return u.open(generation);
    } catch (e) {
      u.free();
      throw e;
    }
  };
  const bytes = bytesFor(base);
  for (const version of [-1, 0, 2])
    refuse(
      () => new core.ProjectUpload(version, bytes.length, options(bytes)),
      "invalid_options",
    );
  for (let field = 0; field < 10; field++)
    for (const bad of [-1, 0.5, NaN, Infinity, 4294967296]) {
      const v = options(bytes);
      v[field] = bad;
      refuse(
        () => new core.ProjectUpload(1, bytes.length, v),
        "invalid_options",
      );
    }
  for (const n of [0, 9, 11])
    refuse(
      () => new core.ProjectUpload(1, bytes.length, new Float64Array(n)),
      "invalid_options",
    );
  for (const mode of [0, 30, 33])
    refuse(
      () => call("uploadNew", 1, bytes.length, options(bytes), "UTC", mode),
      "invalid_timestamp_profile",
    );
  const a = open(),
    b = open(),
    guard = a.capture_guard(),
    snapshot = a.snapshot();
  try {
    assert.equal(b.is_current(guard), false);
    refuse(() => b.acknowledge_checkpoint(guard), "stale_or_disposed");
    refuse(() => snapshot.export_json(0), "output_limit");
    refuse(() => call("assetLength", snapshot.handle), "invalid_handle_kind");
    const data = snapshot.export_json(8_388_608);
    try {
      const first = data.read(0, 1)[0],
        copy = data.read(0, 1);
      copy[0] ^= 255;
      assert.equal(data.read(0, 1)[0], first);
      for (const [start, count] of [
        [-1, 1],
        [0, -1],
        [0, 65537],
        [data.length(), 1],
        [4294967296, 0],
      ])
        refuse(() => data.read(start, count), "invalid_range");
    } finally {
      data.free();
    }
    const selection = new core.ProjectSelectionInput();
    try {
      refuse(() => selection.add(0, Uint16Array.of(1)), "invalid_selection");
      refuse(() => selection.add(-1, new Uint16Array()), "invalid_selection");
      refuse(() => selection.add(1, new Uint16Array(131073)), "input_limit");
    } finally {
      selection.free();
    }
    a.acknowledge_checkpoint(guard).free();
    assert.equal(a.is_current(guard), false);
    assert.equal(a.is_export_current(guard), true);
    a.dispose();
    refuse(() => a.capture_guard(), "disposed");
  } finally {
    guard.free();
    snapshot.free();
    a.free();
    b.free();
  }

  const s = open(),
    retained = [];
  try {
    const hello = s.submit(
      JSON.stringify({
        protocolVersion: 1,
        generation,
        requestId: 1,
        operation: {
          hello: {
            minProtocolVersion: 1,
            maxProtocolVersion: 1,
            projectSchemaVersion: 1,
            intentVersion: 1,
          },
        },
      }),
    );
    assert.ok(JSON.parse(hello.wire()).result.welcome);
    hello.effects().free();
    const before = s.snapshot();
    const guard = {
      projectId: units(base.id),
      revision: before.revision(),
      semanticHash: units(before.hash()),
      assetFingerprint: units(s.asset_fingerprint()),
      historyRevision: s.history_revision(),
    };
    before.free();
    assert.equal(
      s.submit(
        JSON.stringify({
          protocolVersion: 1,
          generation,
          requestId: 2,
          operation: {
            execute: {
              guard,
              intent: {
                version: 1,
                command: {
                  renamePlate: {
                    plateId: units(base.plates[0].id),
                    name: units("JNI admission check"),
                  },
                },
              },
            },
          },
        }),
      ),
      undefined,
    );
    while (true) {
      try {
        retained.push(s.snapshot());
      } catch (e) {
        assert.equal(String(e), "resource_limit");
        break;
      }
    }
    assert.equal(retained.length, 4095);
    refuse(() => s.run_next(), "resource_limit");
    assert.equal(s.pending_count(), 1);
    retained.pop().free();
    const current = s.snapshot();
    assert.equal(current.revision(), guard.revision);
    current.free();
    const reply = s.run_next();
    assert.equal(JSON.parse(reply.wire()).result.acknowledged.changed, true);
    const reservedHandle = reply.handle;
    const effects = reply.effects();
    assert.equal(effects.handle, reservedHandle);
    refuse(() => call("replyWire", reservedHandle), "invalid_handle_kind");
    refuse(() => call("replyEffects", reservedHandle), "invalid_handle_kind");
    refuse(() => s.snapshot(), "resource_limit");
    assert.ok(effects.count() >= 2);
    for (const capture of retained) capture.free();
    retained.length = 0;
    effects.free();
    const after = s.snapshot();
    assert.equal(after.revision(), guard.revision + 1);
    after.free();
  } finally {
    for (const capture of retained) capture.free();
    s.free();
  }

  let timestamps = 0,
    localTimes = 0;
  for (const mode of [31, 32])
    for (let zone = 0; zone < corpus.zones.length; zone++) {
      const host = projectJniCore(call, corpus.zones[zone].name, mode);
      for (const test of corpus.timestamps) {
        const text = String.fromCharCode(...test.units),
          u = staged({ ...base, createdAt: text, updatedAt: text }, host);
        let valid = false;
        try {
          try {
            u.seal_document();
            valid = true;
          } catch (e) {
            assert.equal(String(e), "invalid_document");
          }
        } finally {
          u.free();
        }
        assert.equal(
          valid,
          test[`smi${mode}`][zone] !== null,
          "JNI timestamp reference mismatch",
        );
        timestamps++;
      }
    }
  for (const test of corpus.localTimes)
    for (const zone of test.zones) {
      assert.equal(
        call("resolveLocal", zone.zone, test.civil),
        zone.smi31,
        `JVM timezone ${zone.zone}`,
      );
      localTimes++;
    }
  const local = JSON.stringify({
    ...base,
    createdAt: "2026-10-05T12:00:00",
    updatedAt: "2026-10-05T12:00:00",
  });
  const ownerChecks = call("ownerChecks", JSON.stringify(base), local);
  return { refusals, timestamps, localTimes, ownerChecks };
}
