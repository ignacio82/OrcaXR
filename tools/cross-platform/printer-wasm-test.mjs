// The printer core package, which browsers load in production: every printer
// corpus replayed against the packaged printer WASM (`core/browser/printer`
// glue, `web/public/core-printer` bytes), with the counts the project core
// reproduces. The package carries the printer bindings and nothing of the
// project editor.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as core from "../../core/browser/printer/orcaxr_core.js";
import { replayPrintJobStatus } from "./print-job-status-replay.mjs";
import { replayPrinterControl } from "./printer-control-replay.mjs";
import { replayPrinterTools } from "./printer-tools-replay.mjs";
import { replayPrinterPreparation } from "./printer-preparation-replay.mjs";
import { replayPrinterWorkflow } from "./printer-workflow-replay.mjs";
import { replayPrinterSession } from "./printer-session-replay.mjs";
import { replayMoonrakerPolicy } from "./moonraker-policy-replay.mjs";
import { replayMoonrakerTransport } from "./moonraker-transport-replay.mjs";
import { replayPrinterStorage } from "./printer-storage-replay.mjs";
import { replayPrintHistory } from "./printer-history-replay.mjs";
import { replayPrinterConsole } from "./printer-console-replay.mjs";
import { replayPrinterCamera } from "./printer-camera-replay.mjs";
import { replayPrinterDirectory } from "./printer-directory-replay.mjs";
import { replayRememberedCredentials } from "./printer-credentials-replay.mjs";
import { replayExternalSlicer } from "./external-slicer-replay.mjs";

const root = new URL("../../", import.meta.url);
const asset = await readFile(
  new URL("core/browser/printer/asset.ts", root),
  "utf8",
);
const [, path, sha256] = asset.match(
  /"wasm": \{\s*"path": "(core-printer\/[0-9a-f]{64}\/orcaxr_core_bg\.wasm)",\s*"sha256": "([0-9a-f]{64})"/,
);
const bytes = await readFile(new URL(`web/public/${path}`, root));
assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
core.initSync({ module: bytes });
assert.equal(typeof core.MoonrakerTransport, "function");
assert.equal(typeof core.ProjectSession, "undefined", "no project editor");
assert.equal(typeof core.GcodeSession, "undefined", "no G-code preview");

const fixture = async (name) =>
  JSON.parse(
    await readFile(new URL(`testdata/cross-platform/${name}.json`, root)),
  );
const result = {
  ...replayPrintJobStatus(core, await fixture("print-job-status-vectors")),
  ...replayPrinterControl(core, await fixture("printer-control-vectors")),
  ...replayPrinterTools(core, await fixture("printer-tools-vectors")),
  ...replayPrinterPreparation(
    core,
    await fixture("printer-preparation-vectors"),
  ),
  ...replayPrinterWorkflow(core, await fixture("printer-workflow-vectors")),
  ...replayPrinterSession(core, await fixture("printer-session-vectors")),
  ...replayMoonrakerPolicy(core, await fixture("moonraker-policy-vectors")),
  ...replayMoonrakerTransport(
    core,
    await fixture("moonraker-transport-vectors"),
  ),
  ...replayPrinterStorage(core, await fixture("printer-storage-vectors")),
  ...replayPrintHistory(core, await fixture("printer-history-vectors")),
  ...replayPrinterConsole(core, await fixture("printer-console-vectors")),
  ...replayPrinterCamera(core, await fixture("printer-camera-vectors")),
  ...replayPrinterDirectory(core, await fixture("printer-directory-vectors")),
  ...replayRememberedCredentials(core, await fixture("printer-credentials-vectors")),
  ...replayExternalSlicer(core, await fixture("external-slicer-vectors")),
};
assert.deepEqual(
  [result.printJobSnapshots, result.printJobIgnored, result.printJobRefusals],
  [790, 76, 7],
);
assert.deepEqual(
  [
    result.printerAvailability,
    result.printerChecks,
    result.printerFailures,
    result.printerSummaries,
    result.printerGuarded,
    result.printerHoldSteps,
  ],
  [45, 1125, 100, 1173, 540, 35],
);
assert.deepEqual(
  [result.printerToolUsages, result.printerSlotReplies, result.printerMappings],
  [100, 20, 1552],
);
assert.equal(result.printerPreparationAnswers, 929);
assert.deepEqual(
  [
    result.printerWorkflowScenarios,
    result.printerWorkflowSteps,
    result.printerWorkflowRefusals,
  ],
  [402, 19688, 13],
);
assert.deepEqual(
  [
    result.printerSessionScenarios,
    result.printerSessionSteps,
    result.printerSessionReplies,
    result.printerSessionRefusals,
  ],
  [80, 3254, 557, 8],
);
assert.equal(result.moonrakerPolicyAnswers, 805);
assert.deepEqual(
  [
    result.moonrakerTransportScenarios,
    result.moonrakerTransportSteps,
    result.moonrakerTransportReplies,
    result.moonrakerTransportRefusals,
    result.moonrakerTransportTexts,
  ],
  [88, 2533, 94, 20, 64],
);
assert.deepEqual(result.printerStorageAnswers, [218, 1460, 326, 64]);
assert.deepEqual(result.printHistoryAnswers, [290, 1363, 258, 55, 55, 76, 23, 39]);
assert.deepEqual(result.printerConsoleAnswers, [408, 44, 284, 51, 76, 33, 34, 28]);
assert.deepEqual(result.printerCameraAnswers, [62, 12, 462, 462, 616, 308, 154, 154]);
assert.deepEqual(result.printerDirectoryAnswers, [37, 25, 160, 60, 44, 41, 15]);
assert.deepEqual(result.rememberedCredentialsAnswers, [79, 63]);
assert.deepEqual(result.externalSlicerAnswers, [72, 230, 156, 247, 196, 44, 49]);
console.log(
  JSON.stringify({ ...result, wasmBytes: bytes.length, wasmSha256: sha256 }),
);
