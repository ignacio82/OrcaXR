/**
 * Send sliced G-code to a networked printer.
 *
 * The Elegoo Centauri Carbon (and most Klipper machines) expose Moonraker
 * on :7125 — `POST /server/files/upload` with the file, optionally with
 * `print=true` to start immediately. The browser can't discover the
 * printer (no mDNS), so the IP is entered by the user and remembered.
 *
 * Note the CORS constraint: Moonraker must list this page's origin in its
 * `[authorization] cors_domains` (e.g. `http://127.0.0.1:8081`), otherwise
 * the browser blocks the response. surfaceError() makes that legible.
 */
export interface PrinterConfig {
  host: string; // ip or hostname, no scheme
  port: number; // Moonraker default 7125
}

const STORAGE_KEY = 'orcaxr.printer';

export function loadPrinterConfig(): PrinterConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PrinterConfig;
  } catch { /* ignore */ }
  return { host: '', port: 7125 };
}

export function savePrinterConfig(cfg: PrinterConfig) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

export interface SendResult {
  ok: boolean;
  message: string;
}

/** Upload G-code to Moonraker; when startPrint, also begins the job. */
export async function sendToPrinter(
  cfg: PrinterConfig,
  gcode: string,
  filename: string,
  startPrint: boolean,
): Promise<SendResult> {
  if (!cfg.host) return { ok: false, message: 'No printer IP set.' };
  const base = `http://${cfg.host}:${cfg.port}`;
  const safeName = filename.replace(/[^\w.-]/g, '_') || 'orcaxr.gcode';

  const form = new FormData();
  form.append('file', new Blob([gcode], { type: 'text/plain' }), safeName);
  form.append('root', 'gcodes');
  if (startPrint) form.append('print', 'true');

  try {
    const resp = await fetch(`${base}/server/files/upload`, {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) {
      return { ok: false, message: `Printer returned HTTP ${resp.status}.` };
    }
    return {
      ok: true,
      message: startPrint
        ? `Uploaded ${safeName} and started print.`
        : `Uploaded ${safeName} to printer.`,
    };
  } catch (e) {
    // A network/CORS failure lands here with an opaque TypeError.
    return {
      ok: false,
      message:
        `Could not reach ${base}. Check the IP, that the printer is on the ` +
        `same network, and that Moonraker's cors_domains allows this page.`,
    };
  }
}

/** Quick reachability probe: Moonraker's /printer/info. */
export async function probePrinter(cfg: PrinterConfig): Promise<SendResult> {
  if (!cfg.host) return { ok: false, message: 'No printer IP set.' };
  const url = `http://${cfg.host}:${cfg.port}/printer/info`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status} from printer.` };
    const info = await resp.json();
    const state = info?.result?.state ?? 'ready';
    return { ok: true, message: `Connected — printer ${state}.` };
  } catch {
    return { ok: false, message: `No response from ${cfg.host}:${cfg.port}.` };
  }
}
