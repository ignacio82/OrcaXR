// Printer session references from the production browser
// (`PrinterSessionExchange.ts` driving `PrinterSessionController.ts`): every
// input a host can give the session — select, clear, dispose, connect,
// refresh, execute, transport state changes and notifications, each effect's
// answer, and the intent, confirmation and lease queries — with the step and
// view it produced, over a scripted printer. Scenarios cover the browser's
// own session tests and more: identity checks bracketing history reads,
// commands serialized across an open dialog with recovery still reachable,
// reconnects, socket epochs and printer switches invalidating everything in
// flight, superseded refreshes, notification-driven refreshes, leases, and
// seeded random interleavings. Replayed by Rust, WASM (Node, Chrome) and JNI.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PrinterSessionRecorder } from "../../web/src/printer/PrinterSessionExchange.ts";
import { PRINT_JOB_QUERY_PATH } from "../../web/src/printer/PrintJobStatus.ts";
import {
  encodeProjectConnectionSignal as encodeConnectionSignal,
  encodeProjectPrintJobConfirmReply as encodePrintJobConfirmReply,
  encodeProjectPrintJobExecuteRequest as encodePrintJobExecuteRequest,
  encodeProjectPrintJobIntentReply as encodePrintJobIntentReply,
  encodeProjectPrinterSelection as encodePrinterSelection,
  encodeProjectPrinterSessionLease as encodePrinterSessionLease,
  encodeProjectPrinterSessionLeaseReply as encodePrinterSessionLeaseReply,
  encodeProjectPrinterSessionOutcome as encodePrinterSessionOutcome,
  encodeProjectPrinterSessionStep as encodePrinterSessionStep,
  encodeProjectPrinterSessionView as encodePrinterSessionView,
} from "../../contracts/generated/project-intents.ts";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
assert.ok(process.argv.slice(2).every((v) => v === "--write"));
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
const fromUnits = (value) => String.fromCharCode(...value);
const absent = { absent: {} };
const kindOf = (effect) => Object.keys(effect)[0];
const failed = (code, httpStatus) => ({
  failed: {
    code: code === undefined ? absent : { value: code },
    httpStatus: httpStatus === undefined ? absent : { value: httpStatus },
    detail: absent,
  },
});
const signal = (status, generation, socketEpoch) => ({
  status,
  generation,
  socketEpoch: socketEpoch === undefined ? absent : { value: socketEpoch },
});
const selection = (id, overrides = {}) => ({
  id: units(id),
  name: absent,
  endpoint: units(`http://${id}`),
  port: 7125,
  apiKey: absent,
  ...overrides,
});

// --- A scripted printer ---------------------------------------------------------------
function printer(overrides = {}) {
  return {
    filename: "part.gcode",
    jobId: "000001",
    startedAt: 1000,
    printState: "printing",
    klippy: "ready",
    size: 100,
    modified: 900,
    partial: false,
    failQuery: false,
    failMetadata: false,
    failHistory: false,
    failPost: false,
    confirm: true,
    initial: signal("disconnected", 0),
    clock: 1_700_000_000_000,
    // (record, model) => an answer instead of the printer's own.
    override: () => undefined,
    ...overrides,
  };
}
const ok = (value) => ({ reply: JSON.stringify(value) });

function answer(model, record) {
  const custom = model.override(record, model);
  if (custom !== undefined) return custom;
  const effect = record.effect;
  switch (kindOf(effect)) {
    case "connect":
      return { connected: {} };
    case "confirmCommand":
      return { confirmed: model.confirm };
    case "recovery":
      return model.failPost ? failed("network") : ok("ok");
  }
  const send = effect.request.send;
  const path = fromUnits(send.path);
  if (fromUnits(send.method) === "POST")
    return model.failPost ? failed("httpError", 500) : ok("ok");
  if (path === PRINT_JOB_QUERY_PATH) {
    if (model.failQuery) return failed("network");
    return ok(
      model.partial
        ? { status: { virtual_sdcard: { progress: 0.4 } } }
        : {
            status: {
              webhooks: { state: model.klippy },
              print_stats: {
                state: model.printState,
                filename: model.filename,
              },
              virtual_sdcard: { is_active: model.printState === "printing" },
            },
          },
    );
  }
  if (path.startsWith("/server/files/metadata?")) {
    if (model.failMetadata) return failed("httpError", 404);
    return ok({
      filename: model.filename,
      job_id: model.jobId,
      print_start_time: model.startedAt,
      size: model.size,
      modified: model.modified,
    });
  }
  if (path.startsWith("/server/history/job?")) {
    if (model.failHistory) return failed("timeout");
    return ok({
      job: {
        job_id: model.jobId,
        filename: model.filename,
        start_time: model.startedAt,
        status: "in_progress",
        end_time: null,
        exists: true,
      },
    });
  }
  throw new Error(`Unscripted request ${path}`);
}

// --- Recording ------------------------------------------------------------------------
function encodeInput(input) {
  const [kind, value] = Object.entries(input)[0];
  switch (kind) {
    case "select":
      return { select: encodePrinterSelection(value) };
    case "execute":
      return { execute: encodePrintJobExecuteRequest(value) };
    case "state":
      return {
        state: {
          transport: value.transport,
          signal: encodeConnectionSignal(value.signal),
        },
      };
    case "resolve":
      return {
        resolve: {
          id: value.id,
          outcome: encodePrinterSessionOutcome(value.outcome),
        },
      };
    case "leaseCurrent":
      return { leaseCurrent: encodePrinterSessionLease(value) };
    case "notification":
    case "reply":
    case "captureIntent":
    case "confirm":
      return { [kind]: value };
    default:
      return { [kind]: {} };
  }
}
function encodeRecord(record) {
  const out = { input: encodeInput(record.input) };
  if (record.step !== undefined) {
    out.step = encodePrinterSessionStep(record.step);
    out.view = encodePrinterSessionView(record.view);
  }
  if (record.refused !== undefined) out.refused = record.refused;
  if (record.intent !== undefined)
    out.intent = encodePrintJobIntentReply(record.intent);
  if (record.token !== undefined)
    out.token = encodePrintJobConfirmReply(record.token);
  if (record.lease !== undefined)
    out.lease = encodePrinterSessionLeaseReply(record.lease);
  if (record.current !== undefined) out.current = record.current;
  return out;
}

/** One session over one scripted printer, with the helpers scenarios use. */
function session(model) {
  const recorder = new PrinterSessionRecorder({ open: () => model.initial });
  let transport = 0;
  const h = {
    recorder,
    model,
    get transport() {
      return transport;
    },
    async give(record, given = answer(model, record)) {
      model.clock += 250;
      if ("reply" in given)
        await recorder.reply(record.id, given.reply, model.clock);
      else await recorder.resolve(record.id, given);
    },
    /** Answer what is pending, oldest first, until nothing is or `stop` says so. */
    async settle(stop = () => false) {
      for (let guard = 0; guard < 500; guard++) {
        const pending = recorder.pending();
        if (pending.length === 0) return;
        const record = pending[0];
        if (stop(record)) return;
        await h.give(record);
      }
      throw new Error("The session never settles");
    },
    async select(sel) {
      await recorder.select(sel);
      for (const r of recorder.records) {
        const effects = r.step?.effects ?? [];
        for (const e of effects)
          if (kindOf(e.effect) === "openTransport")
            transport = e.effect.openTransport.transport;
      }
    },
    async state(status, generation, socketEpoch) {
      await recorder.state(transport, signal(status, generation, socketEpoch));
    },
    async notify(method, params) {
      model.clock += 100;
      await recorder.notification(
        transport,
        method,
        JSON.stringify(params),
        model.clock,
      );
    },
    /** Select, connect and settle every query: a session ready for commands. */
    async ready(sel = selection("printer-a")) {
      await h.select(sel);
      await recorder.connect();
      await h.state("connecting", 1);
      await h.state("connected", 1, 1);
      await h.settle();
    },
    intentId: () => {
      const last = recorder.records.at(-1);
      return last.intent && "intent" in last.intent ? last.intent.intent.id : 0;
    },
    tokenId: () => {
      const last = recorder.records.at(-1);
      return last.token && "token" in last.token ? last.token.token : 0;
    },
  };
  return h;
}

const scenarios = [];
async function scenario(name, run, model = printer()) {
  const h = session(model);
  try {
    await run(h);
  } finally {
    h.recorder.close();
  }
  scenarios.push({ name, records: h.recorder.records.map(encodeRecord) });
  return h;
}
const execute = (intent, confirmation = { none: {} }) => ({
  intent,
  confirmation,
});

// --- The browser's own session tests ------------------------------------------------------
await scenario(
  "captures an immutable history identity and sends once after confirmation",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("cancel");
    const intent = h.intentId();
    h.recorder.confirm(intent);
    const token = h.tokenId();
    await h.recorder.execute(execute(intent, { token }));
    await h.settle();
    await h.recorder.execute(execute(intent, { token }));
    await h.settle();
    await h.recorder.dispose();
  },
);

for (const change of [
  "filename",
  "job-id",
  "start-time",
  "state",
  "partial-query",
  "failed-query",
  "failed-metadata",
  "failed-history",
])
  await scenario(
    `confirmation rejects ${change} changes without a POST`,
    async (h) => {
      await h.ready();
      h.recorder.captureIntent("pause");
      const intent = h.intentId();
      const m = h.model;
      if (change === "filename") m.filename = "other.gcode";
      if (change === "job-id") m.jobId = "000002";
      if (change === "start-time") m.startedAt++;
      if (change === "state") m.printState = "paused";
      if (change === "partial-query") m.partial = true;
      if (change === "failed-query") m.failQuery = true;
      if (change === "failed-metadata") m.failMetadata = true;
      if (change === "failed-history") m.failHistory = true;
      await h.recorder.execute(execute(intent));
      await h.settle();
      await h.recorder.dispose();
    },
  );

await scenario(
  "a dialog for A cannot cancel a newer run of the same filename",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("cancel");
    await h.recorder.execute(execute(h.intentId(), { dialog: {} }));
    h.model.jobId = "000002";
    h.model.startedAt++;
    await h.settle();
    await h.recorder.dispose();
  },
);

await scenario(
  "a dismissed dialog sends nothing",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("cancel");
    h.model.confirm = false;
    await h.recorder.execute(execute(h.intentId(), { dialog: {} }));
    await h.settle();
    h.recorder.captureIntent("cancel");
  },
  printer(),
);

await scenario(
  "a rejected job identity stays unavailable until the replacement refresh finishes",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("cancel");
    const intent = h.intentId();
    h.recorder.confirm(intent);
    const token = h.tokenId();
    h.model.jobId = "000002";
    h.model.startedAt++;
    await h.recorder.execute(execute(intent, { token }));
    // Hold the replacement refresh's first query open.
    let queries = 0;
    await h.settle((record) => {
      const send = record.effect.request?.send;
      return (
        send && fromUnits(send.path) === PRINT_JOB_QUERY_PATH && ++queries === 3
      );
    });
    h.recorder.captureIntent("cancel");
    await h.recorder.refresh();
    await h.settle();
    h.recorder.captureIntent("cancel");
    const replacement = h.intentId();
    h.recorder.confirm(replacement);
    await h.recorder.execute(execute(replacement, { token: h.tokenId() }));
    await h.settle();
    await h.recorder.dispose();
  },
);

for (const change of ["printer", "reconnect", "dispose", "socket"])
  await scenario(
    `a ${change} change invalidates a captured hold`,
    async (h) => {
      await h.ready();
      h.recorder.captureIntent("cancel");
      const intent = h.intentId();
      h.recorder.confirm(intent);
      const token = h.tokenId();
      if (change === "printer") await h.select(selection("printer-b"));
      else if (change === "dispose") await h.recorder.dispose();
      else if (change === "socket") {
        await h.state("connected", 1, 2);
        await h.settle();
      } else {
        await h.state("disconnected", 1);
        await h.state("connected", 2, 1);
        await h.recorder.refresh();
        await h.settle();
      }
      await h.recorder.execute(execute(intent, { token }));
      await h.settle();
      await h.recorder.dispose();
    },
  );

await scenario(
  "rejects a forged token and another intent's confirmation",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("cancel");
    const other = h.intentId();
    h.recorder.confirm(other);
    const otherToken = h.tokenId();
    for (const token of [999, otherToken]) {
      h.recorder.captureIntent("cancel");
      await h.recorder.execute(execute(h.intentId(), { token }));
      await h.settle();
    }
    h.recorder.captureIntent("cancel");
    await h.recorder.execute(execute(h.intentId()));
    await h.recorder.execute(execute(4242));
    h.recorder.confirm(4242);
    // The other intent's token is still unspent.
    await h.recorder.execute(execute(other, { token: otherToken }));
    await h.settle();
    await h.recorder.dispose();
  },
);

await scenario(
  "serializes commands across an open dialog and keeps emergency stop reachable",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("cancel");
    const cancel = h.intentId();
    h.recorder.captureIntent("pause");
    const pause = h.intentId();
    await h.recorder.execute(execute(cancel, { dialog: {} }));
    await h.recorder.execute(execute(pause));
    h.recorder.captureIntent("pause");
    h.recorder.captureIntent("emergencyStop");
    const emergency = h.intentId();
    h.recorder.confirm(emergency);
    await h.recorder.execute(execute(emergency, { token: h.tokenId() }));
    h.recorder.captureIntent("emergencyStop");
    h.recorder.captureIntent("firmwareRestart");
    const dialog = h.recorder
      .pending()
      .find((r) => kindOf(r.effect) === "confirmCommand");
    const stop = h.recorder
      .pending()
      .find((r) => kindOf(r.effect) === "recovery");
    await h.give(stop);
    await h.give(dialog, { confirmed: false });
    await h.settle();
    await h.recorder.dispose();
  },
);

await scenario(
  "recovery needs the exact confirmation but no connection, readiness, or history query",
  async (h) => {
    await h.select(selection("printer-a"));
    for (const command of ["emergencyStop", "firmwareRestart"]) {
      h.recorder.captureIntent(command);
      const intent = h.intentId();
      await h.recorder.execute(execute(intent));
      h.recorder.captureIntent(command);
      const again = h.intentId();
      h.recorder.confirm(again);
      await h.recorder.execute(execute(again, { token: h.tokenId() }));
      await h.settle();
    }
    await h.recorder.dispose();
  },
);

await scenario("a failed recovery command reads as unverifiable", async (h) => {
  await h.select(selection("printer-a"));
  h.model.failPost = true;
  h.recorder.captureIntent("emergencyStop");
  const intent = h.intentId();
  h.recorder.confirm(intent);
  await h.recorder.execute(execute(intent, { token: h.tokenId() }));
  await h.settle();
});

await scenario(
  "late queries from a cleared printer cannot republish or dispatch",
  async (h) => {
    await h.ready();
    await h.recorder.refresh();
    await h.recorder.clear();
    await h.settle();
    await h.recorder.refresh();
    await h.recorder.connect();
  },
);

await scenario(
  "a replacement during metadata/history reads cannot authorize a command",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("cancel");
    const intent = h.intentId();
    h.recorder.confirm(intent);
    await h.recorder.execute(execute(intent, { token: h.tokenId() }));
    await h.settle((record) => {
      const send = record.effect.request?.send;
      if (send && fromUnits(send.path).startsWith("/server/history/job")) {
        h.model.jobId = "000002";
        h.model.startedAt++;
      }
      return false;
    });
    await h.recorder.dispose();
  },
);

await scenario(
  "switching printers aborts an open confirmation without blocking the new session",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("cancel");
    await h.recorder.execute(execute(h.intentId(), { dialog: {} }));
    const dialog = h.recorder
      .pending()
      .find((r) => kindOf(r.effect) === "confirmCommand");
    await h.select(selection("printer-b"));
    await h.recorder.connect();
    await h.state("connecting", 1);
    await h.state("connected", 1, 1);
    await h.settle();
    h.recorder.captureIntent("pause");
    const fresh = h.intentId();
    await h.recorder.resolve(dialog.id, { confirmed: true });
    await h.recorder.execute(execute(fresh));
    await h.settle();
    await h.recorder.dispose();
  },
);

await scenario(
  "failed identity refresh disables ordinary controls but retains the reported status",
  async (h) => {
    await h.ready();
    h.model.failMetadata = true;
    await h.recorder.refresh();
    await h.settle();
    h.recorder.captureIntent("pause");
    await h.recorder.dispose();
  },
);

await scenario(
  "a superseded slow refresh cannot erase the newer printer reading",
  async (h) => {
    await h.ready();
    await h.recorder.refresh();
    const slow = h.recorder.pending()[0];
    h.model.filename = "new.gcode";
    h.model.jobId = "000002";
    h.model.startedAt++;
    await h.recorder.refresh();
    await h.settle((record) => record.id === slow.id);
    const rest = h.recorder.pending().filter((r) => r.id !== slow.id);
    for (const record of rest) await h.give(record);
    await h.settle((record) => record.id === slow.id);
    await h.give(
      slow,
      ok({
        status: {
          webhooks: { state: "ready" },
          print_stats: { state: "printing", filename: "part.gcode" },
          virtual_sdcard: { is_active: true },
        },
      }),
    );
    await h.settle();
    h.recorder.captureIntent("pause");
    await h.recorder.dispose();
  },
);

// --- Connections, notifications and leases --------------------------------------------------
await scenario(
  "an idle printer offers no job commands but stays verified",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("pause");
    h.recorder.captureIntent("emergencyStop");
    h.recorder.captureLease();
  },
  printer({ printState: "standby" }),
);

await scenario(
  "a paused job resumes without a dialog",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("resume");
    await h.recorder.execute(execute(h.intentId()));
    await h.settle();
  },
  printer({ printState: "paused" }),
);

await scenario(
  "a failed command post reads as unverifiable, never retried",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("pause");
    h.model.failPost = true;
    await h.recorder.execute(execute(h.intentId()));
    await h.settle();
  },
);

await scenario(
  "a post in flight when the socket drops is reported as a session change",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("pause");
    await h.recorder.execute(execute(h.intentId()));
    await h.settle(
      (record) =>
        fromUnits(record.effect.request?.send.method ?? []) === "POST",
    );
    await h.state("reconnecting", 1);
    await h.settle();
  },
);

await scenario(
  "Klipper not ready blocks job commands",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("cancel");
  },
  printer({ klippy: "shutdown" }),
);

await scenario(
  "the same selection keeps its transport, a new key replaces it",
  async (h) => {
    await h.ready();
    await h.select(selection("printer-a"));
    await h.select(
      selection("printer-a", { name: { value: units("Renamed") } }),
    );
    await h.select(
      selection("printer-a", { apiKey: { value: units("secret") } }),
    );
    await h.select(selection("printer-a", { port: 7126 }));
    await h.recorder.dispose();
    await h.select(selection("printer-a"));
    await h.recorder.connect();
    await h.recorder.refresh();
  },
);

await scenario(
  "connecting without a printer, and a failed connect",
  async (h) => {
    await h.recorder.connect();
    await h.select(
      selection("printer-a", { name: { value: units("Bench U1") } }),
    );
    await h.recorder.connect();
    await h.give(h.recorder.pending()[0], failed("network"));
    await h.recorder.connect();
    await h.settle();
  },
);

await scenario("the printer changes while connecting", async (h) => {
  await h.select(selection("printer-a"));
  await h.recorder.connect();
  const connect = h.recorder.pending()[0];
  await h.select(selection("printer-b"));
  await h.give(connect);
  await h.settle();
});

await scenario(
  "a connect that finds the status already verified skips the refresh",
  async (h) => {
    await h.ready();
    await h.recorder.connect();
    await h.settle();
  },
);

await scenario(
  "leases bind the printer, transport and generation",
  async (h) => {
    h.recorder.captureLease();
    await h.select(
      selection("printer-a", { name: { value: units("Bench U1") } }),
    );
    h.recorder.captureLease();
    await h.recorder.connect();
    await h.state("connecting", 1);
    await h.state("connected", 1, 1);
    h.recorder.captureLease();
    const first = h.recorder.records.at(-1).lease.lease;
    h.recorder.leaseCurrent(first);
    await h.settle();
    h.recorder.leaseCurrent(first);
    await h.state("connected", 1, 2);
    h.recorder.leaseCurrent(first);
    h.recorder.captureLease();
    const second = h.recorder.records.at(-1).lease.lease;
    await h.state("reconnecting", 1);
    h.recorder.leaseCurrent(second);
    await h.state("connected", 2, 1);
    h.recorder.leaseCurrent(second);
    h.recorder.captureLease();
    const third = h.recorder.records.at(-1).lease.lease;
    await h.select(selection("printer-b"));
    h.recorder.leaseCurrent(third);
    await h.recorder.dispose();
    h.recorder.leaseCurrent(third);
    h.recorder.captureLease();
  },
);

await scenario(
  "status notifications merge, refresh on a job change, and wait for a connection",
  async (h) => {
    await h.select(selection("printer-a"));
    await h.notify("notify_status_update", [
      { print_stats: { state: "printing" } },
      1,
    ]);
    await h.recorder.connect();
    await h.state("connecting", 1);
    await h.state("connected", 1, 1);
    await h.settle();
    await h.notify("notify_status_update", [
      { virtual_sdcard: { progress: 0.5 } },
      2,
    ]);
    await h.notify("notify_status_update", [
      { display_status: { message: "Layer 4" } },
      3,
    ]);
    await h.notify("notify_status_update", [{ constructor: { x: 1 } }, 4]);
    await h.notify("notify_status_update", {
      print_stats: { total_duration: 50 },
    });
    await h.notify("notify_status_update", {
      print_stats: { total_duration: 40 },
    });
    await h.settle();
    h.model.printState = "paused";
    await h.notify("notify_status_update", [
      { print_stats: { state: "paused" } },
      5,
    ]);
    h.recorder.captureIntent("resume");
    await h.settle();
    h.recorder.captureIntent("resume");
    await h.notify("notify_history_changed", [{ action: "finished" }]);
    h.recorder.captureIntent("resume");
    await h.settle();
    await h.notify("notify_gcode_response", ["ok"]);
    await h.notify("notify_status_update", "not a status");
    await h.state("disconnected", 1);
    await h.notify("notify_status_update", [
      { print_stats: { state: "printing" } },
      6,
    ]);
    await h.notify("notify_history_changed", [{}]);
    await h.recorder.clear();
    await h.recorder.notification(1, "notify_status_update", "[{}]", 9);
    await h.recorder.state(1, signal("connected", 9, 9));
  },
);

await scenario(
  "a notification during an identity read retires it",
  async (h) => {
    await h.ready();
    await h.recorder.refresh();
    await h.settle((record) =>
      fromUnits(record.effect.request?.send.path ?? []).startsWith(
        "/server/history/job",
      ),
    );
    await h.notify("notify_history_changed", [{ action: "added" }]);
    await h.settle();
    h.recorder.captureIntent("cancel");
  },
);

await scenario(
  "unicode job identities, and a filename with no URL spelling",
  async (h) => {
    await h.ready();
    h.recorder.captureIntent("cancel");
    h.model.filename = "odd\ud800.gcode";
    await h.recorder.refresh();
    await h.settle();
    h.recorder.captureIntent("cancel");
  },
  printer({ filename: "pièce é.gcode", jobId: "0000ü1" }),
);

await scenario("identity values the browser refuses", async (h) => {
  await h.ready();
  for (const metadata of [
    { size: 0 },
    { size: 1.5 },
    { print_start_time: 0 },
    { modified: -1 },
    { job_id: "   " },
    { job_id: 7 },
    { filename: "other.gcode" },
  ]) {
    h.model.override = (record) =>
      fromUnits(record.effect.request?.send.path ?? []).startsWith(
        "/server/files/metadata",
      )
        ? ok({
            filename: "part.gcode",
            job_id: "000001",
            print_start_time: 1000,
            size: 100,
            modified: 900,
            ...metadata,
          })
        : undefined;
    await h.recorder.refresh();
    await h.settle();
  }
  for (const job of [
    { status: "completed" },
    { end_time: 5 },
    { exists: false },
    { start_time: 999 },
  ]) {
    h.model.override = (record) =>
      fromUnits(record.effect.request?.send.path ?? []).startsWith(
        "/server/history/job",
      )
        ? ok({
            job: {
              job_id: "000001",
              filename: "part.gcode",
              start_time: 1000,
              status: "in_progress",
              end_time: null,
              exists: true,
              ...job,
            },
          })
        : undefined;
    await h.recorder.refresh();
    await h.settle();
  }
  h.model.override = (record) =>
    fromUnits(record.effect.request?.send.path ?? []) === PRINT_JOB_QUERY_PATH
      ? { reply: "{" }
      : undefined;
  await h.recorder.refresh();
  await h.settle();
});

await scenario("answers a session cannot take", async (h) => {
  await h.recorder.resolve(1, { connected: {} });
  await h.select(selection("printer-a"));
  await h.recorder.connect();
  const connect = h.recorder.pending()[0];
  await h.recorder.resolve(connect.id, { confirmed: true });
  await h.recorder.reply(connect.id, "{}", 1);
  await h.recorder.resolve(connect.id + 50, { connected: {} });
  await h.state("connecting", 1);
  await h.state("connected", 1, 1);
  await h.give(connect);
  const query = h.recorder.pending()[0];
  await h.recorder.resolve(query.id, { connected: {} });
  await h.recorder.resolve(query.id, { confirmed: false });
  await h.settle();
});

// --- Seeded interleavings -------------------------------------------------------------------
function random(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}
for (let seed = 1; seed <= 40; seed++)
  await scenario(`seeded interleaving ${seed}`, async (h) => {
    const rand = random(seed * 2654435761);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    let generation = 1;
    let socket = 1;
    await h.ready();
    for (let step = 0; step < 45; step++) {
      const pending = h.recorder.pending();
      const roll = rand();
      if (pending.length > 0 && roll < 0.45) {
        const record = pick(pending);
        const r = rand();
        if (r < 0.1)
          await h.give(
            record,
            failed(pick(["network", "timeout", "httpError"])),
          );
        else await h.give(record);
      } else if (roll < 0.55) {
        h.recorder.captureIntent(
          pick([
            "pause",
            "resume",
            "cancel",
            "emergencyStop",
            "firmwareRestart",
          ]),
        );
      } else if (roll < 0.62) {
        const intent = h.intentId();
        if (intent) h.recorder.confirm(intent);
      } else if (roll < 0.72) {
        const intent = h.intentId() || 1;
        const confirmation = pick([
          { none: {} },
          { dialog: {} },
          { token: h.tokenId() || 1 },
        ]);
        await h.recorder.execute(execute(intent, confirmation));
      } else if (roll < 0.78) {
        await h.recorder.refresh();
      } else if (roll < 0.84) {
        const change = pick(["job", "state", "filename", "paused"]);
        if (change === "job") {
          h.model.jobId = String(Number(h.model.jobId) + 1).padStart(6, "0");
          h.model.startedAt++;
        } else if (change === "state")
          h.model.printState = pick([
            "printing",
            "paused",
            "standby",
            "complete",
          ]);
        else if (change === "filename")
          h.model.filename = pick(["part.gcode", "other.gcode"]);
        await h.notify("notify_status_update", [
          {
            print_stats: {
              state: h.model.printState,
              filename: h.model.filename,
            },
          },
          step,
        ]);
      } else if (roll < 0.88) {
        await h.notify("notify_history_changed", [{ action: "finished" }]);
      } else if (roll < 0.92) {
        const r = rand();
        if (r < 0.4) await h.state("connected", generation, ++socket);
        else if (r < 0.7) {
          await h.state("reconnecting", generation);
          generation++;
          await h.state("connected", generation, (socket = 1));
        } else await h.state("disconnected", generation);
      } else if (roll < 0.95) {
        await h.recorder.connect();
      } else if (roll < 0.97) {
        h.recorder.captureLease();
      } else {
        await h.select(selection(pick(["printer-a", "printer-b"])));
        await h.recorder.connect();
        await h.state("connected", ++generation, (socket = 1));
      }
    }
    await h.settle();
    await h.recorder.dispose();
  });

// --- Output ---------------------------------------------------------------------------------
const records = scenarios.reduce((n, s) => n + s.records.length, 0);
const sources = [
  "tools/cross-platform/printer-session-vectors.mjs",
  "web/src/printer/PrinterSessionExchange.ts",
  "web/src/printer/PrinterSessionController.ts",
  "web/src/printer/PrintJobControl.ts",
  "web/src/printer/PrintJobStatus.ts",
  "web/src/printer/MoonrakerTypes.ts",
];
const output =
  JSON.stringify({
    schemaVersion: 1,
    sources: sources.map((path) => ({
      path,
      sha256: createHash("sha256").update(read(path)).digest("hex"),
    })),
    scenarios,
  }) + "\n";
const path = new URL(
  "testdata/cross-platform/printer-session-vectors.json",
  root,
);
if (process.argv.includes("--write")) writeFileSync(path, output);
else
  assert.equal(
    readFileSync(path, "utf8"),
    output,
    "Printer session reference drift",
  );
console.log(
  `Printer session references: ${scenarios.length} scenarios, ${records} records.`,
);
