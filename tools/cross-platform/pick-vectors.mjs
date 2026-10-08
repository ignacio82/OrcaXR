// Ray picking references from the production browser (`ProjectPickScene`,
// whose facets the browser test checks against three.js raycasts on the
// workspace's display meshes): an icosphere with a modifier cube on a plain
// and a rotated, non-uniformly scaled instance, and an open terrain on a
// mirrored instance, picked by 243 printer-space rays — aimed at the volumes,
// from below the bed, past everything and with a zero direction — in scenes
// of every volume and of model volumes only, plus an unknown plate. Replayed
// by Rust, by WASM in Node and Chrome, and over JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalStringify } from "../../web/src/project/domain/canonical.ts";
import { InMemoryAssetRepository } from "../../web/src/project/assets.ts";
import {
  PickRefusal,
  ProjectPickScene,
} from "../../web/src/project/picking.ts";
import { createPickingFixture } from "../../web/src/project/__tests__/pickingFixture.ts";
import {
  decodeProjectPickRay,
  decodeProjectPickSceneRequest,
  encodeProjectPickRay,
  encodeProjectPickReply,
  encodeProjectPickSceneRequest,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (s) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));

const fixture = createPickingFixture();
const assets = new InMemoryAssetRepository();
for (const payload of fixture.assets)
  assets.put(payload.descriptor, payload.bytes);

const scenes = [];
for (const modelsOnly of [false, true]) {
  const request = encodeProjectPickSceneRequest({
    plateId: units(fixture.plateId),
    modelsOnly,
  });
  const scene = ProjectPickScene.capture(
    fixture.state,
    assets,
    decodeProjectPickSceneRequest(request),
  );
  scenes.push({
    request,
    picks: fixture.rays.map((ray) => {
      const text = encodeProjectPickRay({
        origin: ray.origin,
        direction: ray.direction,
      });
      return {
        ray: text,
        reply: encodeProjectPickReply(scene.pick(decodeProjectPickRay(text))),
      };
    }),
  });
}
const refusals = [];
{
  const request = encodeProjectPickSceneRequest({
    plateId: units("import:plate:missing"),
    modelsOnly: false,
  });
  assert.throws(
    () =>
      ProjectPickScene.capture(
        fixture.state,
        assets,
        decodeProjectPickSceneRequest(request),
      ),
    (error) => error instanceof PickRefusal && error.code === "unknown-plate",
  );
  refusals.push({ request, refusal: "unknown_plate" });
}

const sources = [
  "tools/cross-platform/pick-vectors.mjs",
  "web/src/project/picking.ts",
  "web/src/project/__tests__/pickingFixture.ts",
  "contracts/project-intents.json",
];
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      sources: sources.map((path) => ({
        path,
        sha256: createHash("sha256").update(read(path)).digest("hex"),
      })),
      stateJson: canonicalStringify(fixture.state),
      assets: fixture.assets.map((a) => ({
        descriptorJson: canonicalStringify(a.descriptor),
        bytes: [...a.bytes],
      })),
      scenes,
      refusals,
    },
    null,
    0,
  ) + "\n";
const path = new URL("testdata/cross-platform/pick-vectors.json", root);
if (process.argv.includes("--write")) writeFileSync(path, output);
else assert.equal(readFileSync(path, "utf8"), output, "Pick reference drift");
const hits = scenes.map(
  (scene) => scene.picks.filter((p) => p.reply.startsWith('{"hit"')).length,
);
console.log(
  `picks: ${scenes.length} scenes × ${fixture.rays.length} rays (${hits.join(" / ")} hits), ${refusals.length} refusal`,
);
