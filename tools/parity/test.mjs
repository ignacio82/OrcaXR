#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractEnum,
  findCalls,
  literalString,
  splitTopLevel,
  stripCppComments,
} from "./cpp-scan.mjs";
import {
  buildManifest,
  canonicalJson,
  MANIFEST_PATH,
  readOverlay,
} from "./extract.mjs";
import { PinnedSource } from "./source.mjs";
import { verifyManifest } from "./verify.mjs";

function expectFailure(fn, pattern, message) {
  assert.throws(fn, pattern, message);
}

function scannerTests() {
  const sample = `
        // register("commented", value);
        register("live", nested(1, 2), [] { return "// string"; });
        /* register("also-commented", value); */
    `;
  assert.equal(
    stripCppComments(sample).split("\n").length,
    sample.split("\n").length,
  );
  const calls = findCalls(sample, "register");
  assert.equal(calls.length, 1);
  assert.equal(literalString(calls[0].args[0]), "live");
  assert.deepEqual(splitTopLevel('a, fn(b, c), "d,e"'), [
    "a",
    "fn(b, c)",
    '"d,e"',
  ]);
  const forwardAndDefinition = `
        enum class Mode : unsigned char;
        struct Holder { int ignored; };
        enum class Mode : unsigned char { One, Two, Count };
    `;
  assert.deepEqual(
    extractEnum(forwardAndDefinition, "Mode").values.map(({ name }) => name),
    ["One", "Two", "Count"],
  );
}

function mutationTests(overlay, baseSource) {
  const printConfigPath = "src/libslic3r/PrintConfig.cpp";
  const printConfig = baseSource.read(printConfigPath);
  const settingNeedle = 'def = this->add("printer_technology", coEnum);';
  assert(printConfig.includes(settingNeedle));
  const settingMutation = printConfig.replace(
    settingNeedle,
    `${settingNeedle}\n    def = this->add("__parity_mutation_setting__", coBool);`,
  );
  const mutatedSettingSource = new PinnedSource({
    repository: baseSource.repository,
    overrides: new Map([[printConfigPath, settingMutation]]),
  });
  expectFailure(
    () => buildManifest({ source: mutatedSettingSource, overlay }),
    /registration sanity check|Unmapped upstream parity leaf/,
    "A newly added upstream setting must fail parity verification",
  );

  const mainFramePath = "src/slic3r/GUI/MainFrame.cpp";
  const mainFrame = baseSource.read(mainFramePath);
  const actionMutation =
    `${mainFrame}\nvoid ParityMutation::inject()\n{\n` +
    '    append_menu_item(menu, wxID_ANY, _L("Parity mutation action"), _L("Mutation"), handler);\n}\n';
  const mutatedActionSource = new PinnedSource({
    repository: baseSource.repository,
    overrides: new Map([[mainFramePath, actionMutation]]),
  });
  expectFailure(
    () => buildManifest({ source: mutatedActionSource, overlay }),
    /Unmapped upstream parity leaf/,
    "A newly added upstream action must fail parity verification",
  );

  const duplicateOverlay = {
    ...overlay,
    mappings: [...overlay.mappings, { ...overlay.mappings[0] }],
  };
  expectFailure(
    () => buildManifest({ source: baseSource, overlay: duplicateOverlay }),
    /Duplicate disposition mapping/,
    "Duplicate dispositions must fail verification",
  );

  const staleMappingOverlay = {
    ...overlay,
    mappings: [
      ...overlay.mappings,
      {
        dispositionId: "P0.1",
        id: "menu-action:stale:does-not-exist",
        kind: "task",
      },
    ],
  };
  expectFailure(
    () => buildManifest({ source: baseSource, overlay: staleMappingOverlay }),
    /Stale disposition mapping/,
    "Stale mappings must fail verification",
  );

  const staleSymbolOverlay = structuredClone(overlay);
  staleSymbolOverlay.runtimeItems[0].source.symbol =
    "MainFrame::renamed_symbol";
  expectFailure(
    () => buildManifest({ source: baseSource, overlay: staleSymbolOverlay }),
    /Runtime overlay symbol .* is stale/,
    "Stale reviewed symbols must fail verification",
  );

  const stalePathOverlay = structuredClone(overlay);
  stalePathOverlay.runtimeItems[0].source.path =
    "src/slic3r/GUI/RemovedParitySource.cpp";
  expectFailure(
    () => buildManifest({ source: baseSource, overlay: stalePathOverlay }),
    /Stale or missing upstream source path/,
    "Stale reviewed source paths must fail verification",
  );
}

export function main() {
  scannerTests();
  const overlay = readOverlay();
  const firstSource = new PinnedSource();
  const first = buildManifest({ source: firstSource, overlay });
  const second = buildManifest({ source: new PinnedSource(), overlay });
  assert.equal(
    canonicalJson(first),
    canonicalJson(second),
    "Two consecutive parity generations must be byte-identical",
  );

  const committed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(
    canonicalJson(first),
    canonicalJson(committed),
    "Committed parity manifest must equal a fresh generation",
  );
  verifyManifest({
    manifest: committed,
    overlay,
    source: new PinnedSource(),
    compareGenerated: false,
  });
  mutationTests(overlay, firstSource);
  console.log(
    `Parity extractor self-tests passed (${first.counts.total} mapped leaves).`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(`parity test: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}
