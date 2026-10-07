import assert from "node:assert/strict";
import {
  encodeProjectStagingInputOptions,
  encodeProjectStagingPoolOptions,
  encodeProjectStagingClipboardOptions,
} from "../../contracts/generated/project-staging.ts";
let cases = 0;
for (const [encode, base] of [
  [
    encodeProjectStagingInputOptions,
    {
      bytes: 4_000_000,
      nodes: 1_000_000,
      textUnits: 4_000_000,
      numberBytes: 1024,
      depth: 128,
      commands: 100,
      inputUnits: 8_000_000,
    },
  ],
  [
    encodeProjectStagingPoolOptions,
    { resources: 4, commands: 100, inputUnits: 8_000_000 },
  ],
  [encodeProjectStagingClipboardOptions, { assets: 4096, bytes: 536_870_912 }],
]) {
  assert.deepEqual(Array.from(encode(base)), Object.values(base));
  cases++;
  for (const key of Object.keys(base)) {
    for (const value of [
      -1,
      0.5,
      NaN,
      Infinity,
      4294967296,
      "1",
      null,
      undefined,
      true,
    ]) {
      assert.throws(() => encode({ ...base, [key]: value }));
      cases++;
    }
    const missing = { ...base };
    delete missing[key];
    assert.throws(() => encode(missing));
    cases++;
    let calls = 0;
    const getter = { ...base };
    Object.defineProperty(getter, key, {
      enumerable: true,
      get() {
        calls++;
        return 1;
      },
    });
    assert.throws(() => encode(getter));
    assert.equal(calls, 0);
    cases++;
  }
  assert.throws(() => encode({ ...base, extra: 1 }));
  assert.throws(() => encode({ ...base, [Symbol("extra")]: 1 }));
  cases += 2;
}
for (const base of [
  {
    bytes: 0,
    nodes: 0,
    textUnits: 0,
    numberBytes: 1,
    depth: 0,
    commands: 0,
    inputUnits: 0,
  },
  {
    bytes: 4294967295,
    nodes: 4294967295,
    textUnits: 4294967295,
    numberBytes: 4294967295,
    depth: 128,
    commands: 4294967295,
    inputUnits: 4294967295,
  },
]) {
  assert.deepEqual(
    Array.from(encodeProjectStagingInputOptions(base)),
    Object.values(base),
  );
  cases++;
  assert.throws(() =>
    encodeProjectStagingInputOptions({ ...base, depth: 129 }),
  );
  assert.throws(() =>
    encodeProjectStagingInputOptions({ ...base, numberBytes: 0 }),
  );
  cases += 2;
}
assert.deepEqual(
  Array.from(
    encodeProjectStagingPoolOptions({
      resources: 0,
      commands: 0,
      inputUnits: 0,
    }),
  ),
  [0, 0, 0],
);
cases++;
console.log(
  `Staging options: ${cases} exact shape, data ownership and budget boundary checks`,
);
