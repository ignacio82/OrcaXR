#!/usr/bin/env node
/**
 * OrcaXR Android MCP Bridge (stdio <-> Android WebSocket)
 *
 * Connects AI desktop agents (Antigravity, Claude Desktop, Codex CLI, Cursor)
 * to the OrcaXR Android MCP server over ADB or local network.
 *
 * Usage with Claude Desktop / Antigravity:
 * {
 *   "mcpServers": {
 *     "orcaxr-android": {
 *       "command": "node",
 *       "args": ["/path/to/OrcaXR/tools/mcp/adb-mcp-bridge.mjs"]
 *     }
 *   }
 * }
 *
 * Optional environment variables:
 * - ORCAXR_MCP_PORT: Port number (default: 8765)
 * - ORCAXR_DEVICE_SERIAL: Specific ADB device serial
 * - ORCAXR_BEARER_TOKEN: Explicit Bearer token (if auto-discovery via ADB run-as is disabled)
 * - ORCAXR_HOST: Device host IP if connecting over LAN instead of ADB forward
 */

import { execSync } from "node:child_process";
import readline from "node:readline";

const PORT = parseInt(process.env.ORCAXR_MCP_PORT || "8765", 10);
let HOST = process.env.ORCAXR_HOST || "";
let SERIAL = process.env.ORCAXR_DEVICE_SERIAL || "";
let TOKEN = process.env.ORCAXR_BEARER_TOKEN || "";

function log(msg) {
  // Stdout is reserved strictly for JSON-RPC 2.0 messages; all logging goes to stderr.
  process.stderr.write(`[orcaxr-mcp-bridge] ${msg}\n`);
}

function adbCommand(args) {
  const serialFlag = SERIAL ? `-s ${SERIAL} ` : "";
  return execSync(`adb ${serialFlag}${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function findDevice() {
  try {
    const devicesOutput = execSync("adb devices", { encoding: "utf8" }).trim();
    const lines = devicesOutput.split("\n").slice(1).map(l => l.trim()).filter(l => l.includes("\tdevice"));
    if (lines.length === 0) {
      log("Warning: No authorized ADB devices found. Ensure device is connected and USB debugging is enabled.");
    } else {
      if (!SERIAL) {
        SERIAL = lines[0].split("\t")[0].trim();
      }
      log(`Found ADB device(s): ${lines.map(l => l.split("\t")[0]).join(", ")} (using ${SERIAL})`);
    }
  } catch (err) {
    log(`Warning: Failed to list ADB devices: ${err.message}`);
  }
}

function setupConnection() {
  findDevice();

  // If HOST is not explicitly provided, check if SERIAL is a Wi-Fi ADB address (IP:PORT)
  if (!HOST && SERIAL && SERIAL.includes(":")) {
    const candidate = SERIAL.split(":")[0].trim();
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(candidate)) {
      HOST = candidate;
      log(`Connecting directly to Wi-Fi ADB device IP ${HOST}:${PORT} (skipping local adb forward)`);
      return;
    }
  }

  if (HOST && HOST !== "127.0.0.1" && HOST !== "localhost") {
    log(`Connecting to remote host ${HOST}:${PORT}`);
    return;
  }

  // Try ADB port forward for USB connections or localhost
  try {
    adbCommand(`forward tcp:${PORT} tcp:${PORT}`);
    HOST = "127.0.0.1";
    log(`Forwarded local port tcp:${PORT} to device tcp:${PORT}`);
    return;
  } catch (err) {
    log(`ADB port forward attempt on tcp:${PORT} failed: ${err.message}`);
    // If adb forward fails (e.g. port already in use on host), try querying device LAN IP
    try {
      const route = adbCommand("shell ip route");
      const match = route.match(/src\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      if (match && match[1]) {
        HOST = match[1];
        log(`Fell back to device LAN IP: ${HOST}:${PORT}`);
        return;
      }
    } catch (_ignore) {}
  }

  HOST = "127.0.0.1";
}

function discoverBearerToken() {
  if (TOKEN) return TOKEN;

  try {
    const xml = adbCommand("shell run-as dev.orcaxr.nativeapp cat /data/data/dev.orcaxr.nativeapp/shared_prefs/orcaxr_mcp_prefs.xml");
    const match = xml.match(/<string name="bearer_token">([a-f0-9]{64})<\/string>/);
    if (match && match[1]) {
      TOKEN = match[1];
      log(`Auto-discovered Bearer token from device preferences.`);
      return TOKEN;
    }
  } catch (err) {
    log(`Could not auto-read token via ADB run-as: ${err.message}`);
    log(`Please set ORCAXR_BEARER_TOKEN environment variable with the token from the OrcaXR app settings.`);
  }

  return "";
}

setupConnection();
discoverBearerToken();

const wsUrl = `ws://${HOST}:${PORT}/mcp/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
log(`Connecting to ${HOST}:${PORT}...`);

let ws = null;
const pendingQueue = [];
let inFlight = 0;
let stdinClosed = false;

function connect() {
  try {
    const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
    ws = new WebSocket(wsUrl, { headers });

    ws.onopen = () => {
      log(`Connected to OrcaXR Android MCP server.`);
      while (pendingQueue.length > 0) {
        const item = pendingQueue.shift();
        ws.send(item);
      }
    };

    ws.onmessage = (event) => {
      // Forward text frame directly to agent's stdout
      process.stdout.write(event.data.toString() + "\n");
      inFlight = Math.max(0, inFlight - 1);
      if (stdinClosed && inFlight === 0) {
        setTimeout(() => {
          if (ws) ws.close();
          process.exit(0);
        }, 50);
      }
    };

    ws.onerror = (err) => {
      log(`WebSocket error: ${err.message || err}`);
    };

    ws.onclose = (event) => {
      if (stdinClosed && inFlight === 0) {
        process.exit(0);
        return;
      }
      log(`WebSocket connection closed (code ${event.code}: ${event.reason || "no reason"}). Reconnecting in 3s...`);
      setTimeout(connect, 3000);
    };
  } catch (err) {
    log(`Connection failed: ${err.message}. Retrying in 3s...`);
    setTimeout(connect, 3000);
  }
}

connect();

// Relay lines from stdin to WebSocket
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  inFlight++;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(trimmed);
  } else {
    pendingQueue.push(trimmed);
  }
});

rl.on("close", () => {
  stdinClosed = true;
  if (inFlight === 0) {
    setTimeout(() => {
      if (ws) ws.close();
      process.exit(0);
    }, 100);
  }
});

process.on("SIGINT", () => {
  if (ws) ws.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (ws) ws.close();
  process.exit(0);
});
