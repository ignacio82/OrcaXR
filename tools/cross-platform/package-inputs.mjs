// Synthetic full-package inventory cases. These use production browser helpers;
// no private models, native implementation output or hand-authored ZIP bytes.
import { createProjectFixture } from "../../web/src/project/__tests__/fixtures.ts";
import {
  canonicalStringify,
  projectFingerprint,
} from "../../web/src/project/domain/canonical.ts";
import { contentDigest } from "../../web/src/project/assets.ts";
import { buildBbsCore } from "../../web/src/project/serialization/bbsCore.ts";
import {
  Bbs3mfProjectSerializer,
  ORCAXR_EXTENSION_PATH,
} from "../../web/src/project/serialization/Bbs3mfProjectSerializer.ts";
import { ORCAXR_EXTENSION_FORMAT } from "../../web/src/project/serialization/CanonicalEnvelope.ts";
import { readSafeZip } from "../../web/src/project/serialization/deterministicZip.ts";
export async function packageInputs() {
  const cases = [];
  async function add(name, edit) {
    const fixture = createProjectFixture(),
      state = fixture.state,
      assets = [fixture.asset];
    const put = (label, bytes = new Uint8Array([1, 2, 3]), options = {}) => {
      const descriptor = {
        id: `import:asset:${label}`,
        kind: "extension",
        digest: contentDigest(bytes),
        byteLength: bytes.length,
        mediaType: "application/octet-stream",
        ...options,
      };
      const p = { descriptor, bytes };
      state.sourceAssets.push(descriptor);
      assets.push(p);
      return p;
    };
    const blob = (asset, path, relationships = []) =>
      state.extensionBlobs.push({
        id: `import:blob:b${state.extensionBlobs.length}`,
        namespace: "https://fixture.example/opaque",
        path,
        assetId: asset.descriptor.id,
        relationships,
      });
    await edit({ fixture, state, assets, put, blob });
    cases.push({
      name,
      stateJson: canonicalStringify(state),
      assets: assets.map((p) => ({
        descriptorJson: canonicalStringify(p.descriptor),
        bytes: Array.from(p.bytes),
      })),
    });
  }
  for (const path of [
    "Metadata/custom.unknown",
    "__proto__",
    "\ufeffnote.txt",
    "𐀀/x",
    "\ue000/x",
    "no-extension",
    "trailing.",
    "percent%2e%2e.bin",
  ])
    await add(`opaque-${path}`, ({ put, blob }) => blob(put("opaque"), path));
  await add("multiple-path-candidates", ({ put, blob }) => {
    const a = put("opaque");
    for (const p of ["\ue000.bin", "𐀀.bin", "z.bin", "a.bin"]) blob(a, p);
  });
  for (const digest of [
    "opaque:火🔥\ud800/+-",
    "----",
    "A".repeat(63) + "!Z",
    "!!" + "a".repeat(80) + "!",
    "opaque:\u0000foo",
  ])
    await add(`digest-${cases.length}`, ({ put }) =>
      put("opaque", new Uint8Array([9]), { digest }),
    );
  for (const mediaType of [
    "image/png",
    "IMAGE/PNG",
    "image/jpeg",
    "IMAGE/WEBP",
    "application/json",
    "APPLICATION/XML",
    "text/xml",
    "TEXT/PLAIN",
    "image/svg+xml",
  ])
    await add(`media-${mediaType}`, ({ put }) =>
      put("media", new Uint8Array([4]), { mediaType }),
    );
  for (const plate of [true, false])
    await add(`thumbnail-${plate}`, ({ state, put }) => {
      state.plates[0].order = 7;
      const a = put("thumbnail", new Uint8Array([7]), {
        kind: "thumbnail",
        mediaType: "image/png",
      });
      state.thumbnails.push({
        id: "import:thumbnail:first",
        assetId: a.descriptor.id,
        width: 1,
        height: 1,
        plateId: state.plates[0].id,
      });
      state.thumbnails.push({
        id: "import:thumbnail:last",
        assetId: a.descriptor.id,
        width: 1,
        height: 1,
        ...(plate ? { plateId: state.plates[0].id } : {}),
      });
    });
  await add("opaque-precedes-thumbnail", ({ state, put, blob }) => {
    const a = put("thumbnail", new Uint8Array([7]), {
      kind: "thumbnail",
      mediaType: "image/png",
    });
    blob(a, "Metadata/opaque.png");
    state.thumbnails.push({
      id: "import:thumbnail:first",
      assetId: a.descriptor.id,
      width: 1,
      height: 1,
      plateId: state.plates[0].id,
    });
  });
  for (const same of [true, false])
    await add(`duplicate-blob-${same}`, ({ put, blob }) => {
      blob(put("one"), "Metadata/duplicate.bin");
      blob(
        put("two", new Uint8Array(same ? [1, 2, 3] : [4])),
        "Metadata/duplicate.bin",
      );
    });
  for (const path of [
    "Metadata/project_settings.config",
    "Metadata/model_settings.config",
    "Metadata/layer_config_ranges.xml",
    "Metadata/custom_gcode_per_layer.xml",
  ])
    for (const mode of ["equal", "replace", "conflict"])
      await add(`preserved-${path}-${mode}`, ({ state, assets, put, blob }) => {
        const generated = buildBbsCore(
          state,
          new Map(assets.map((p) => [p.descriptor.id, p])),
        ).files.get(path);
        blob(
          put(
            "preserved",
            mode === "equal"
              ? (generated ?? new Uint8Array([9]))
              : new Uint8Array([4, 5]),
          ),
          path,
          mode === "replace" ? ["orcaxr:preserve-original"] : [],
        );
      });
  await add("forbidden-structural-blob", ({ put, blob }) =>
    blob(put("structural"), "3D/3dmodel.model", ["orcaxr:preserve-original"]),
  );
  await add(
    "asset-fallback-collision",
    async ({ state, assets, put, blob }) => {
      const output = await new Bbs3mfProjectSerializer().serialize({
        state,
        assets,
        sourceRevision: 0,
        sourceHash: projectFingerprint(state),
      });
      const envelope = JSON.parse(
        new TextDecoder().decode(
          readSafeZip(output.bytes).get(ORCAXR_EXTENSION_PATH),
        ),
      );
      blob(put("collision"), envelope.assetEntries[0].path);
    },
  );
  for (const same of [true, false])
    await add(`drawing-extension-${same}`, ({ fixture, put, blob }) => {
      const drawing = put("drawing", new TextEncoder().encode("<svg/>"), {
        mediaType: "image/svg+xml",
      });
      const path = "Metadata/drawing.svg";
      fixture.object.volumes[0].embossSvg = {
        pathIn3mf: path,
        drawingAssetId: drawing.descriptor.id,
        depthMm: 1,
        widthMm: 1,
        useSurface: false,
      };
      blob(put("alias", same ? drawing.bytes : new Uint8Array([9])), path);
    });
  await add("literal-unsafe-key", ({ state }) => {
    state.extensionData = JSON.parse('{"nested":{"constructor":42}}');
  });
  await add("unsafe-key-looking-values", ({ state }) => {
    state.extensionData = {
      "constructor-x": "constructor",
      "escaped\\constructor": "__proto__",
      "prototype ": "prototype",
    };
  });
  for (const target of [
    "Metadata/note.txt",
    "Metadata/absent.txt",
    ORCAXR_EXTENSION_PATH,
    "_rels/.rels",
    "[Content_Types].xml",
    "3D/_rels/3dmodel.model.rels",
  ]) {
    await add(`relationship-stage-${target}`, ({ state, put, blob }) => {
      blob(put("note"), "Metadata/note.txt");
      state.extensionData = {
        [`${ORCAXR_EXTENSION_FORMAT}/opc-relationships`]: [
          "/",
          "3D/3dmodel.model",
        ].map((source, i) => ({
          source,
          id: `fixture-${i}`,
          type: "urn:test",
          target: `/${target}`,
          targetMode: "Internal",
        })),
      };
    });
  }
  await add("filament-reference-scopes", ({ state }) => {
    const p = state.plates[0],
      o = p.objects[0],
      v = o.volumes[0];
    const id = state.filaments.mixed[0].id;
    state.filaments.mixed[0].enabled = false;
    o.filamentId = id;
    o.layerRanges[0].filamentId = id;
    v.filamentId = id;
    v.annotations.color = [{ value: id, triangles: [0] }];
    p.wipeTower = {
      enabled: true,
      positionMm: [0, 0],
      rotationDeg: 0,
      filamentId: id,
    };
  });
  return cases;
}
