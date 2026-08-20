import express from "express";
import multer from "multer";
import cors from "cors";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bearerTokenMatches,
  HttpError,
  inspect3mf,
  inspectStl,
  isLoopbackHost,
  isOriginAllowed,
  isSameOriginRequest,
  loadServerConfig,
  parseOverridesJson,
  validateServerConfig,
  WindowRateLimiter,
} from "./security.mjs";
import { resolveWasmDir, resolveWasmProvenancePath } from "./slice_worker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENGINE = (process.env.SLICER_ENGINE || "cli").toLowerCase();
const XVFB_RUN = ["/usr/bin/xvfb-run", "/usr/local/bin/xvfb-run"].find(
  (candidate) => existsSync(candidate),
);
const KEY_TYPES = JSON.parse(
  readFileSync(path.join(__dirname, "preset_key_types.json"), "utf8"),
);
const MACHINE_KEYS = new Set(KEY_TYPES.machine);

/**
 * Engine attestation. A client may only route canonical slicing here when this
 * server can prove which engine it runs, and both engines can.
 *
 * The WASM build is hashed from the exact files this process will load, and
 * its pinned commit comes from the provenance manifest published beside them.
 *
 * The CLI is the official Snapmaker Orca Slicer, built from a pinned commit in
 * the same image that runs it (see `server/Dockerfile`), so its provenance is
 * the commit it was built from, the OrcaXR patches applied on top, and a hash
 * of the binary this process will actually execute. Those patches are reported
 * by name and digest rather than glossed over: they are what make headless
 * multi-filament slicing behave as the desktop GUI does, and a client is
 * entitled to see exactly how the engine differs from stock upstream.
 *
 * A hand-assembled deployment with no manifest still reports honestly that it
 * cannot prove its engine, and the client refuses that route.
 */
const CLI_PROVENANCE_PATH =
  process.env.ORCAXR_CLI_PROVENANCE || "/app/orca/engine-provenance.json";

function sha256File(filePath) {
  try {
    return crypto.createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/** Attest the native Snapmaker Orca binary this server would execute. */
function buildCliAttestation(engine) {
  let provenance = null;
  try {
    provenance = JSON.parse(readFileSync(CLI_PROVENANCE_PATH, "utf8"));
  } catch {
    return {
      schemaVersion: 1,
      engine,
      attested: false,
      reason:
        "This server ships no engine provenance manifest beside its Snapmaker Orca binary, so it cannot prove which build it runs.",
    };
  }
  const binaryPath = provenance?.binary?.path;
  if (typeof binaryPath !== "string" || binaryPath.length === 0) {
    return {
      schemaVersion: 1,
      engine,
      attested: false,
      reason: "This server's engine provenance manifest names no binary.",
    };
  }
  // Hash what would actually run, not what the manifest claims, so a swapped
  // binary cannot inherit the manifest's good name.
  const digest = sha256File(binaryPath);
  if (digest === null) {
    return {
      schemaVersion: 1,
      engine,
      attested: false,
      reason: "This server could not read its own Snapmaker Orca binary.",
    };
  }
  if (digest !== provenance.binary.sha256) {
    return {
      schemaVersion: 1,
      engine,
      attested: false,
      reason: "This server's Snapmaker Orca binary does not match the provenance manifest beside it.",
      artifacts: { [path.basename(binaryPath)]: digest },
    };
  }
  return {
    schemaVersion: 1,
    engine,
    attested: true,
    upstream: provenance.engine ?? null,
    patches: provenance.patches ?? [],
    artifacts: { [path.basename(binaryPath)]: digest },
  };
}

function buildEngineAttestation(engine) {
  if (engine !== "wasm") return buildCliAttestation(engine);
  // Resolved per request, through the same resolver `slice_worker.mjs` uses to
  // load the module: the digests below must belong to the build that would
  // actually run, not to a second copy that happens to sit beside the server.
  const wasmDistDir = resolveWasmDir();
  if (wasmDistDir === null) {
    return {
      schemaVersion: 1,
      engine,
      attested: false,
      reason: "The server could not read its own WASM engine artifacts.",
    };
  }
  const artifacts = {
    "slic3r.mjs": sha256File(path.join(wasmDistDir, "slic3r.mjs")),
    "slic3r.wasm": sha256File(path.join(wasmDistDir, "slic3r.wasm")),
  };
  if (Object.values(artifacts).some((value) => value === null)) {
    return {
      schemaVersion: 1,
      engine,
      attested: false,
      reason: "The server could not read its own WASM engine artifacts.",
    };
  }
  let provenance = null;
  try {
    provenance = JSON.parse(
      readFileSync(resolveWasmProvenancePath(wasmDistDir), "utf8"),
    );
  } catch {
    return {
      schemaVersion: 1,
      engine,
      attested: false,
      reason: "The server ships no engine provenance manifest beside its WASM artifacts.",
    };
  }
  const declared = provenance?.outputs ?? {};
  const matches = Object.entries(artifacts).every(([name, digest]) => declared[name] === digest);
  if (!matches) {
    return {
      schemaVersion: 1,
      engine,
      attested: false,
      reason: "The server's WASM artifacts do not match the provenance manifest beside them.",
      artifacts,
    };
  }
  return {
    schemaVersion: 1,
    engine,
    attested: true,
    upstream: provenance.engine ?? null,
    artifacts,
  };
}
const FILAMENT_KEYS = new Set(KEY_TYPES.filament);
const CLI_CRASH_KEYS = new Set([]);
const MAX_LOG_BYTES = 64 * 1024;
const SLICER_ENV_KEYS = [
  "DISPLAY",
  "FONTCONFIG_PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "LOGNAME",
  "ORCAXR_WASM_DIR",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TZ",
  "USER",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
];

function abortReason(signal, fallbackCode = "SLICE_CANCELLED") {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(
    fallbackCode === "SLICE_TIMEOUT" ? "Slice timed out" : "Slice cancelled",
  );
  error.code = fallbackCode;
  return error;
}

function boundedLog(current, data) {
  const next = current + data.toString();
  return next.length <= MAX_LOG_BYTES ? next : next.slice(-MAX_LOG_BYTES);
}

function sanitizeProgress(message) {
  return String(message || "")
    .replaceAll(os.tmpdir(), "[temporary directory]")
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/g, "[path]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .slice(0, 256);
}

/** Log only a bounded error class/code; engine messages may contain paths, profiles, or secrets. */
function safeErrorIdentity(error) {
  const rawName = error instanceof Error ? error.name : "UnknownError";
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawName)
    ? rawName
    : "UnknownError";
  const rawCode =
    error && typeof error === "object" ? String(error.code ?? "") : "";
  const code = /^[A-Z0-9_-]{1,64}$/.test(rawCode) ? rawCode : "UNCLASSIFIED";
  return `${name} [${code}]`;
}

function slicerEnvironment(extra = {}) {
  const env = {};
  for (const key of SLICER_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

async function writeCliPresets(overrides, directory) {
  const configs = {
    machine: {
      name: "OrcaXR machine",
      type: "machine",
      from: "system",
      inherits: "",
    },
    process: {
      name: "OrcaXR process",
      type: "process",
      from: "user",
      inherits: "",
      compatible_printers: ["OrcaXR machine"],
    },
    filament: {
      name: "OrcaXR filament",
      type: "filament",
      from: "user",
      inherits: "",
      compatible_printers: ["OrcaXR machine"],
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      ["from", "name", "type", "inherits"].includes(key) ||
      CLI_CRASH_KEYS.has(key)
    )
      continue;
    const bin = MACHINE_KEYS.has(key)
      ? "machine"
      : FILAMENT_KEYS.has(key)
        ? "filament"
        : "process";
    configs[bin][key] = value;
  }
  const paths = {};
  for (const [type, config] of Object.entries(configs)) {
    paths[type] = path.join(directory, `${type}.json`);
    await fs.writeFile(paths[type], JSON.stringify(config, null, 1), {
      mode: 0o600,
    });
  }
  return paths;
}

function watchProgressPipe(fifoPath, onProgress) {
  const stream = createReadStream(fifoPath);
  const lines = readline.createInterface({ input: stream });
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      const percent = Number(event.total_percent ?? event.plate_percent);
      if (Number.isFinite(percent))
        onProgress(Math.max(0, Math.min(100, percent)), event.message || "");
    } catch {
      // A partial/non-JSON progress line is engine chatter, not a request failure.
    }
  });
  stream.on("error", () => {});
  return () => {
    lines.close();
    stream.destroy();
  };
}

function signalProcessTree(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

/** Terminate a detached child and all descendants, escalating after a bounded grace period. */
export async function terminateProcessTree(child, graceMs = 5000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  signalProcessTree(child, "SIGTERM");
  const graceful = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);
  if (graceful) return;
  signalProcessTree(child, "SIGKILL");
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
}

function spawnDetached(command, args, options = {}) {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function waitForChild(child, signal, onData = () => {}, killGraceMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      void terminateProcessTree(child, killGraceMs)
        .catch(() => {})
        .finally(() => settle(reject, abortReason(signal)));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => settle(reject, error));
    child.once("close", (code) => {
      if (signal?.aborted) settle(reject, abortReason(signal));
      else settle(resolve, code);
    });
  });
}

async function makeFifo(fifoPath, signal, killGraceMs) {
  const child = spawnDetached("mkfifo", [fifoPath]);
  const code = await waitForChild(child, signal, () => {}, killGraceMs);
  if (code !== 0) {
    await terminateProcessTree(child, killGraceMs).catch(() => {});
    throw new Error(`mkfifo exited with code ${code}`);
  }
}

async function runCliSlice({
  modelPath,
  outputPath,
  overrides,
  onProgress,
  signal,
  config,
}) {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "orcaxr-out-"));
  const fifoPath = path.join(outDir, "progress.pipe");
  let stopWatching = () => {};
  try {
    await makeFifo(fifoPath, signal, config.childKillGraceMs);
    stopWatching = watchProgressPipe(fifoPath, onProgress);
    const presetArgs = [];
    if (!modelPath.toLowerCase().endsWith(".3mf")) {
      const presets = await writeCliPresets(overrides, outDir);
      presetArgs.push(
        "--load-settings",
        `${presets.machine};${presets.process}`,
        "--load-filaments",
        presets.filament,
      );
    }
    const args = [
      ...presetArgs,
      "--slice",
      "0",
      "--arrange",
      "0",
      "--orient",
      "0",
      "--pipe",
      fifoPath,
      "--outputdir",
      outDir,
      modelPath,
    ];
    const [command, commandArgs] = XVFB_RUN
      ? [XVFB_RUN, ["-a", "orca-slicer", ...args]]
      : ["orca-slicer", args];
    const child = spawnDetached(command, commandArgs, {
      env: slicerEnvironment({ SNAPMAKER_ORCA_ALLOW_NEWER_FILE: "1" }),
    });
    let log = "";
    const code = await waitForChild(
      child,
      signal,
      (data) => {
        log = boundedLog(log, data);
      },
      config.childKillGraceMs,
    );
    const files = await fs.readdir(outDir);
    const gcodeFile = files.find((file) => file.endsWith(".gcode"));
    if (!gcodeFile)
      throw new Error(
        `orca-slicer exited with code ${code}; no G-code produced. Log:\n${log}`,
      );
    const sourcePath = path.join(outDir, gcodeFile);
    const stat = await fs.stat(sourcePath);
    if (stat.size > config.maxGcodeBytes)
      throw new Error("Slicer output exceeds ORCAXR_MAX_GCODE_BYTES");
    await fs.copyFile(sourcePath, outputPath);
  } finally {
    stopWatching();
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runWasmSlice({
  modelPath,
  configPath,
  outputPath,
  overrides,
  onProgress,
  signal,
  config,
}) {
  const wasmOverrides = { ...overrides, from: "project" };
  await fs.writeFile(configPath, JSON.stringify(wasmOverrides, null, 2), {
    mode: 0o600,
  });
  const maxSpaceSize = process.env.MAX_OLD_SPACE_SIZE || "4096";
  const child = spawnDetached(
    process.execPath,
    [
      `--max-old-space-size=${maxSpaceSize}`,
      path.join(__dirname, "slice_worker.mjs"),
      modelPath,
      configPath,
      outputPath,
    ],
    { cwd: __dirname, env: slicerEnvironment() },
  );
  let log = "";
  const code = await waitForChild(
    child,
    signal,
    (data) => {
      const text = data.toString();
      log = boundedLog(log, text);
      const match = text.match(/\[orcaxr\] (\d+)% *([^\n]*)/);
      if (match) onProgress(Number(match[1]), match[2] || "");
    },
    config.childKillGraceMs,
  );
  if (code !== 0)
    throw new Error(`WASM slicer exited with code ${code}. Log:\n${log}`);
  const stat = await fs.stat(outputPath);
  if (stat.size > config.maxGcodeBytes)
    throw new Error("Slicer output exceeds ORCAXR_MAX_GCODE_BYTES");
}

class Scheduler {
  constructor(maxConcurrent, logError) {
    this.maxConcurrent = maxConcurrent;
    this.logError = logError;
    this.active = new Map();
    this.queue = [];
  }

  enqueue(job, task, cancelQueued) {
    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    const entry = { job, task, cancelQueued, resolveCompletion };
    job.completion = completion;
    if (this.active.size < this.maxConcurrent) this.start(entry);
    else this.queue.push(entry);
    return completion;
  }

  start(entry) {
    clearTimeout(entry.job.queueTimer);
    delete entry.job.queueTimer;
    entry.job.status = "running";
    entry.job.updatedAt = Date.now();
    this.active.set(entry.job.id, entry);
    Promise.resolve()
      .then(entry.task)
      .catch((error) =>
        this.logError(
          "[slicer] unexpected job wrapper failure:",
          safeErrorIdentity(error),
        ),
      )
      .finally(() => {
        this.active.delete(entry.job.id);
        entry.resolveCompletion();
        this.drain();
      });
  }

  drain() {
    while (this.active.size < this.maxConcurrent && this.queue.length)
      this.start(this.queue.shift());
  }

  cancelQueued(jobId) {
    const index = this.queue.findIndex((entry) => entry.job.id === jobId);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    Promise.resolve(entry.cancelQueued()).finally(entry.resolveCompletion);
    return true;
  }

  get queuedCount() {
    return this.queue.length;
  }
}

export const WEB_SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(self), microphone=(), geolocation=(), xr-spatial-tracking=(self)",
};

export const applyWebHeaders = (res) => {
  for (const [k, v] of Object.entries(WEB_SECURITY_HEADERS)) res.setHeader(k, v);
};

function createRateMiddleware(limiter, config = {}) {
  return (req, res, next) => {
    const userLogin = config.trustedProxy
      ? req.get("tailscale-user-login")
      : null;
    const key =
      userLogin || req.ip || req.socket?.remoteAddress || "unknown";
    const result = limiter.consume(key);
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      return sendError(
        res,
        new HttpError(
          429,
          "RATE_LIMITED",
          "Too many requests. Try again later.",
        ),
      );
    }
    next();
  };
}

function sendError(res, error) {
  const known = error instanceof HttpError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "INTERNAL_ERROR";
  const message = known
    ? error.publicMessage
    : "The server could not complete the request.";
  return res.status(status).json({ error: { code, message } });
}

function normalizeConfig(base, overrides = {}) {
  const config = { ...base, ...overrides };
  if (overrides.trustMode !== undefined) {
    config.trustMode = overrides.trustMode;
  } else if (overrides.host !== undefined) {
    config.trustMode = isLoopbackHost(overrides.host)
      ? base.trustMode || "loopback"
      : "token";
  }
  if (config.trustMode === "same-origin") {
    config.trustSameOrigin = true;
    config.authRequired = true;
    if (!config.token) {
      config.token = crypto.randomBytes(32).toString("hex");
    }
  } else if (config.trustMode === "token") {
    config.trustSameOrigin = false;
    config.authRequired = true;
  } else {
    config.trustSameOrigin = false;
    config.authRequired =
      Boolean(config.token) || !isLoopbackHost(config.host);
  }
  config.allowLoopbackOrigins = isLoopbackHost(config.host);
  return validateServerConfig(config);
}

function jobError(code, message, status = 500) {
  return { code, message, status };
}

/** Create an isolated app/job scheduler. Tests inject a runner without starting OrcaSlicer. */
export function createSlicerService(options = {}) {
  const config = normalizeConfig(
    loadServerConfig(options.env ?? process.env),
    options.config,
  );
  const engine = (options.engine ?? DEFAULT_ENGINE).toLowerCase();
  if (!["cli", "wasm"].includes(engine))
    throw new Error(`Unsupported SLICER_ENGINE: ${engine}`);
  const logger = options.logger ?? console;
  const runner =
    options.runner ??
    ((context) =>
      engine === "wasm" ? runWasmSlice(context) : runCliSlice(context));
  const app = express();
  const jobs = new Map();
  const scheduler = new Scheduler(config.maxConcurrentJobs, (...args) =>
    logger.error(...args),
  );
  const generalLimiter = new WindowRateLimiter({
    max: config.maxRequestsPerWindow,
    windowMs: config.rateWindowMs,
    maxClients: config.maxRateLimitClients,
  });
  const sliceLimiter = new WindowRateLimiter({
    max: config.maxSliceRequestsPerWindow,
    windowMs: config.rateWindowMs,
    maxClients: config.maxRateLimitClients,
  });
  let pendingUploads = 0;

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustedProxy ? "loopback" : false);
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(createRateMiddleware(generalLimiter, config));
  app.use(
    cors((req, callback) => {
      const origin = req.get("origin");
      if (isOriginAllowed(origin, config, req)) {
        callback(null, {
          origin: true,
          methods: ["GET", "POST", "DELETE", "OPTIONS"],
          allowedHeaders: ["Authorization", "Content-Type"],
          credentials: false,
          maxAge: 600,
        });
      } else {
        callback(
          new HttpError(
            403,
            "ORIGIN_DENIED",
            "This browser origin is not allowed.",
          ),
        );
      }
    }),
  );
  app.use((req, res, next) => {
    if (req.method === "OPTIONS" || !config.authRequired) return next();
    if (config.trustSameOrigin && isSameOriginRequest(req, config)) return next();
    if (!bearerTokenMatches(req.get("authorization"), config.token)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="OrcaXR slicer"');
      return sendError(
        res,
        new HttpError(
          401,
          "AUTH_REQUIRED",
          "A valid bearer token is required.",
        ),
      );
    }
    next();
  });
  app.use(express.json({ limit: config.maxOverridesBytes, strict: true }));

  const upload = multer({
    dest: os.tmpdir(),
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 1,
      fieldSize: config.maxOverridesBytes,
      // Busboy emits LIMIT_PART_COUNT when the configured count is reached,
      // so three is the strict ceiling that permits our two expected parts.
      parts: 3,
    },
  });

  const cleanupPaths = async (...paths) => {
    await Promise.all(
      paths.filter(Boolean).map((file) => fs.unlink(file).catch(() => {})),
    );
  };

  const cleanupJob = async (job, includeOutput = false) => {
    await cleanupPaths(
      job.modelPath,
      job.configPath,
      includeOutput ? job.outputPath : null,
    );
  };

  const removeJob = async (job) => {
    clearTimeout(job.queueTimer);
    if (!jobs.delete(job.id)) return;
    await cleanupJob(job, true);
  };

  const executeJob = async (job) => {
    const timeout = setTimeout(() => {
      const error = new Error("Slice exceeded its configured deadline");
      error.code = "SLICE_TIMEOUT";
      job.controller.abort(error);
    }, config.sliceTimeoutMs);
    timeout.unref();
    const onProgress = (percent, message = "") => {
      if (job.status !== "running") return;
      job.percent = Math.max(0, Math.min(100, Number(percent) || 0));
      job.message = sanitizeProgress(message);
      job.updatedAt = Date.now();
    };
    try {
      await runner({
        modelPath: job.modelPath,
        configPath: job.configPath,
        outputPath: job.outputPath,
        overrides: job.overrides,
        onProgress,
        signal: job.controller.signal,
        config,
      });
      if (job.controller.signal.aborted)
        throw abortReason(job.controller.signal);
      const stat = await fs.lstat(job.outputPath);
      if (!stat.isFile() || stat.size === 0)
        throw new Error("Slicer did not produce a regular G-code file");
      if (stat.size > config.maxGcodeBytes)
        throw new Error("Slicer output exceeds configured G-code limit");
      await fs.chmod(job.outputPath, 0o600);
      job.outputBytes = stat.size;
      job.percent = 100;
      job.message = "";
      job.status = "done";
    } catch (error) {
      if (job.controller.signal.aborted) {
        const reason = abortReason(job.controller.signal);
        if (reason.code === "SLICE_TIMEOUT") {
          job.status = "error";
          job.publicError = jobError(
            "SLICE_TIMEOUT",
            "Slicing exceeded the configured time limit.",
            504,
          );
        } else {
          job.status = "cancelled";
          job.publicError = jobError(
            "SLICE_CANCELLED",
            "Slicing was cancelled.",
            409,
          );
        }
      } else {
        logger.error(
          `[slicer:${engine}] slice failed:`,
          safeErrorIdentity(error),
        );
        job.status = "error";
        job.publicError = jobError(
          "SLICE_FAILED",
          "Slicing failed. Check the server logs.",
          500,
        );
      }
      await cleanupPaths(job.outputPath);
    } finally {
      clearTimeout(timeout);
      job.updatedAt = Date.now();
      await cleanupJob(job, false);
      delete job.overrides;
    }
  };

  const cancelJob = (job) => {
    if (job.status === "queued") {
      clearTimeout(job.queueTimer);
      job.status =
        job.publicError?.code === "QUEUE_TIMEOUT" ? "error" : "cancelled";
      if (!job.publicError)
        job.publicError = jobError(
          "SLICE_CANCELLED",
          "Slicing was cancelled.",
          409,
        );
      job.updatedAt = Date.now();
      return scheduler.cancelQueued(job.id);
    }
    if (job.status === "running") {
      job.status = "cancelling";
      job.updatedAt = Date.now();
      const error = new Error("Slice cancelled by request");
      error.code = "SLICE_CANCELLED";
      job.controller.abort(error);
      return true;
    }
    return job.status === "cancelling";
  };

  const reserveUpload = (req, res, next) => {
    if (jobs.size + pendingUploads >= config.maxStoredJobs) {
      return sendError(
        res,
        new HttpError(503, "SERVER_BUSY", "The slicer job queue is full."),
      );
    }
    pendingUploads += 1;
    let released = false;
    req.releaseAdmission = () => {
      if (released) return;
      released = true;
      pendingUploads -= 1;
    };
    res.once("finish", req.releaseAdmission);
    res.once("close", req.releaseAdmission);
    next();
  };

  const asyncRoute = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);

  app.get("/ping", (req, res) => res.type("text/plain").send("pong"));

  // Engine provenance, so a client can decide whether this server is a route
  // it is allowed to send canonical work to. Read-only, and authenticated like
  // every other route on a secured deployment — the client sends the same
  // bearer token it uses to slice.
  app.get("/engine", (req, res) => res.json(buildEngineAttestation(engine)));

  app.post(
    "/slice",
    createRateMiddleware(sliceLimiter, config),
    reserveUpload,
    upload.single("file"),
    asyncRoute(async (req, res) => {
      const owned = new Set(req.file?.path ? [req.file.path] : []);
      try {
        if (!req.file)
          throw new HttpError(
            400,
            "FILE_REQUIRED",
            "A model or project file is required.",
          );
        const overrides = parseOverridesJson(
          req.body.overrides,
          config.maxOverridesBytes,
        );
        const stat = await fs.stat(req.file.path);
        if (stat.size < 5)
          throw new HttpError(
            400,
            "INVALID_MODEL",
            "The uploaded model file is invalid.",
          );
        const handle = await fs.open(req.file.path, "r");
        const magic = Buffer.alloc(4);
        try {
          await handle.read(magic, 0, 4, 0);
        } finally {
          await handle.close();
        }
        const isZip = magic[0] === 0x50 && magic[1] === 0x4b;
        if (isZip) await inspect3mf(req.file.path, config);
        else await inspectStl(req.file.path);
        await fs.chmod(req.file.path, 0o600);
        const modelPath = `${req.file.path}${isZip ? ".3mf" : ".stl"}`;
        const configPath = `${req.file.path}.json`;
        const outputPath = `${req.file.path}.gcode`;
        await fs.rename(req.file.path, modelPath);
        owned.delete(req.file.path);
        owned.add(modelPath);

        if (
          scheduler.active.size >= config.maxConcurrentJobs &&
          scheduler.queuedCount >= config.maxQueuedJobs
        ) {
          throw new HttpError(
            503,
            "SERVER_BUSY",
            "The slicer job queue is full.",
          );
        }
        const now = Date.now();
        const job = {
          id: crypto.randomUUID(),
          status: "queued",
          percent: 0,
          message: "",
          createdAt: now,
          updatedAt: now,
          controller: new AbortController(),
          modelPath,
          configPath,
          outputPath,
          overrides,
        };
        job.queueTimer = setTimeout(() => {
          if (job.status !== "queued") return;
          job.publicError = jobError(
            "QUEUE_TIMEOUT",
            "The slice waited too long for an engine slot.",
            503,
          );
          cancelJob(job);
        }, config.queueTimeoutMs);
        job.queueTimer.unref();
        jobs.set(job.id, job);
        owned.clear();
        req.releaseAdmission();
        scheduler.enqueue(
          job,
          () => executeJob(job),
          async () => {
            job.controller.abort(
              Object.assign(new Error("Queued slice cancelled"), {
                code: "SLICE_CANCELLED",
              }),
            );
            if (job.publicError?.code === "QUEUE_TIMEOUT") job.status = "error";
            else {
              job.status = "cancelled";
              job.publicError = jobError(
                "SLICE_CANCELLED",
                "Slicing was cancelled.",
                409,
              );
            }
            job.updatedAt = Date.now();
            await cleanupJob(job, true);
            delete job.overrides;
          },
        );

        if (req.query.async === "1")
          return res.status(202).json({ job: job.id });

        const abortOnDisconnect = () => {
          if (!res.writableEnded && ["queued", "running"].includes(job.status))
            cancelJob(job);
        };
        req.once("aborted", abortOnDisconnect);
        res.once("close", abortOnDisconnect);
        await job.completion;
        req.removeListener("aborted", abortOnDisconnect);
        res.removeListener("close", abortOnDisconnect);
        if (res.destroyed && !res.writableEnded) {
          await removeJob(job);
          return;
        }
        if (job.status !== "done") {
          const error =
            job.publicError ??
            jobError(
              "SLICE_FAILED",
              "Slicing failed. Check the server logs.",
              500,
            );
          await removeJob(job);
          return sendError(
            res,
            new HttpError(error.status, error.code, error.message),
          );
        }
        res.type("text/plain");
        try {
          await new Promise((resolve, reject) => {
            res.sendFile(job.outputPath, (error) =>
              error ? reject(error) : resolve(),
            );
          });
        } finally {
          await removeJob(job);
        }
      } catch (error) {
        await cleanupPaths(...owned);
        throw error;
      } finally {
        req.releaseAdmission?.();
      }
    }),
  );

  app.get("/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job)
      return sendError(
        res,
        new HttpError(404, "JOB_NOT_FOUND", "No such job."),
      );
    res.json({
      status: job.status,
      percent: job.percent,
      message: job.message,
      error: job.publicError?.message,
      errorCode: job.publicError?.code,
    });
  });

  app.get(
    "/jobs/:id/gcode",
    asyncRoute(async (req, res) => {
      const job = jobs.get(req.params.id);
      if (!job)
        return sendError(
          res,
          new HttpError(404, "JOB_NOT_FOUND", "No such job."),
        );
      if (job.status !== "done") {
        throw new HttpError(409, "JOB_NOT_READY", `Job is ${job.status}.`);
      }
      res.type("text/plain");
      try {
        await new Promise((resolve, reject) => {
          res.sendFile(job.outputPath, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      } finally {
        await removeJob(job);
      }
    }),
  );

  app.delete(
    "/jobs/:id",
    asyncRoute(async (req, res) => {
      const job = jobs.get(req.params.id);
      if (!job)
        return sendError(
          res,
          new HttpError(404, "JOB_NOT_FOUND", "No such job."),
        );
      if (!["queued", "running", "cancelling"].includes(job.status)) {
        throw new HttpError(
          409,
          "JOB_NOT_CANCELLABLE",
          `Job is ${job.status}.`,
        );
      }
      cancelJob(job);
      const status = job.status;
      res.status(status === "cancelled" ? 200 : 202).json({ status });
    }),
  );

  const WEB_ROOT =
    process.env.ORCAXR_WEB_ROOT || path.join(__dirname, "public");
  const SERVES_WEB_UI = existsSync(path.join(WEB_ROOT, "index.html"));

  if (SERVES_WEB_UI) {
    app.use(
      express.static(WEB_ROOT, {
        index: false,
        etag: true,
        lastModified: true,
        setHeaders: (res, filePath) => {
          applyWebHeaders(res);
          const rel = path.relative(WEB_ROOT, filePath);
          const contentHashed =
            rel.startsWith("assets" + path.sep) &&
            /-[A-Za-z0-9_-]{8,}\./.test(rel);
          res.setHeader(
            "Cache-Control",
            contentHashed
              ? "public, max-age=31536000, immutable"
              : "no-cache",
          );
        },
      }),
    );

    const INDEX_HTML = path.join(WEB_ROOT, "index.html");
    // Registered after every API route: anything that reaches here matched none
    // of them. Only real document navigations get the SPA shell.
    app.get(/.*/, (req, res, next) => {
      if (!req.accepts("html")) return next(); // fetch/XHR → JSON 404
      if (path.extname(req.path)) return next(); // missing asset → 404
      applyWebHeaders(res);
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(INDEX_HTML, (error) => (error ? next() : undefined));
    });
  }

  app.use(async (error, req, res, next) => {
    if (req.file?.path) await cleanupPaths(req.file.path);
    req.releaseAdmission?.();
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      const oversized = [
        "LIMIT_FILE_SIZE",
        "LIMIT_FIELD_VALUE",
        "LIMIT_PART_COUNT",
        "LIMIT_FILE_COUNT",
        "LIMIT_FIELD_COUNT",
      ].includes(error.code);
      return sendError(
        res,
        new HttpError(
          oversized ? 413 : 400,
          oversized ? "UPLOAD_LIMIT" : "INVALID_UPLOAD",
          oversized
            ? "The upload exceeds a configured limit."
            : "The multipart upload is invalid.",
        ),
      );
    }
    if (error?.type === "entity.too.large") {
      return sendError(
        res,
        new HttpError(
          413,
          "JSON_LIMIT",
          "The JSON request exceeds the configured limit.",
        ),
      );
    }
    if (error?.type === "entity.parse.failed") {
      return sendError(
        res,
        new HttpError(
          400,
          "INVALID_JSON",
          "The request body contains invalid JSON.",
        ),
      );
    }
    if (!(error instanceof HttpError)) {
      logger.error("[server] request failed:", safeErrorIdentity(error));
    }
    return sendError(res, error);
  });

  app.use((req, res) =>
    sendError(res, new HttpError(404, "NOT_FOUND", "No such endpoint.")),
  );

  const expiryTimer = setInterval(
    () => {
      const now = Date.now();
      for (const job of jobs.values()) {
        if (!["done", "error", "cancelled"].includes(job.status)) continue;
        if (now - job.updatedAt > config.jobTtlMs) void removeJob(job);
      }
    },
    Math.min(60_000, Math.max(1000, Math.floor(config.jobTtlMs / 2))),
  );
  expiryTimer.unref();

  const start = (port = config.port) => {
    const server = app.listen({ port, host: config.host }, () => {
      const address = server.address();
      const actualPort =
        typeof address === "object" && address ? address.port : port;
      logger.log(
        `OrcaXR External Slicer Server listening on ${config.host}:${actualPort} (engine: ${engine})`,
      );
      if (config.tokenGenerated && config.token) {
        logger.log(
          `[security] Generated server token persisted to ${config.generatedTokenPath}: Authorization: Bearer ${config.token}`,
        );
      }
      if (config.acceptLanExposure && !isLoopbackHost(config.host)) {
        logger.warn(
          `[security] WARNING: ORCAXR_TRUST=same-origin is active on non-loopback host ${config.host} (ORCAXR_ACCEPT_LAN_EXPOSURE=yes-i-understand). Unauthenticated LAN requests can slice.`,
        );
      }
    });
    server.requestTimeout = config.httpRequestTimeoutMs;
    server.timeout = config.httpRequestTimeoutMs;
    server.headersTimeout = Math.min(60_000, config.httpRequestTimeoutMs);
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 64;
    server.maxRequestsPerSocket = 100;
    server.maxConnections = config.maxConnections;
    return server;
  };

  const shutdown = async () => {
    clearInterval(expiryTimer);
    for (const job of jobs.values()) cancelJob(job);
    await Promise.allSettled(
      [...jobs.values()].map((job) => job.completion).filter(Boolean),
    );
    await Promise.allSettled([...jobs.values()].map((job) => removeJob(job)));
  };

  return { app, config, engine, jobs, scheduler, shutdown, start };
}

const defaultService = createSlicerService();
export const app = defaultService.app;
export function startServer(port = defaultService.config.port) {
  return defaultService.start(port);
}
export function shutdownServer() {
  return defaultService.shutdown();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const server = startServer();
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] received ${signal}; cancelling active slices`);
    server.close(() => {});
    server.closeIdleConnections?.();
    void shutdownServer().finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}
