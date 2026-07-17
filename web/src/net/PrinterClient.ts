/**
 * Send sliced G-code to a networked printer.
 *
 * The Elegoo Centauri Carbon (and most Klipper machines) expose Moonraker
 * on :7125 — `POST /server/files/upload` with the file, optionally with
 * `print=true` to start immediately. The browser can't discover the
 * printer (no mDNS), so the IP is entered by the user and remembered.
 *
 * Moonraker must list this page's origin in `[authorization] cors_domains`.
 * On current Chromium, Local Network Access can authorize an HTTPS OrcaXR page
 * to reach a local HTTP printer; other browsers still need HTTPS or a proxy.
 */
import { fetchLocalNetwork, localNetworkFailureMessage, normalizeHttpEndpoint } from './LocalNetworkAccess';

export interface PrinterConfig {
  host: string; // ip or hostname, no scheme
  port: number; // Moonraker default 7125
}

const STORAGE_KEY = 'orcaxr.printer';

export function loadPrinterConfig(): PrinterConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PrinterConfig;
  } catch {
    /* ignore */
  }
  return { host: '', port: 7125 };
}

export function savePrinterConfig(cfg: PrinterConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

export interface SendResult {
  ok: boolean;
  message: string;
}

/**
 * Ordered list of base URLs to try for a printer.
 *
 * If the host carries an explicit http(s):// scheme — e.g. a Tailscale Serve
 * endpoint `https://<name>.ts.net` or any HTTPS reverse proxy in front of
 * Moonraker — it is used verbatim: no port probing, no scheme fallback.
 * Preserving an explicit target exactly avoids accidental scheme changes.
 * Bare hosts probe the usual Moonraker/Snapmaker HTTP ports (dev also gets the
 * origin-stripping Vite proxy).
 */
function printerBaseUrls(host: string, port: number): string[] {
  const clean = host.trim().replace(/\/$/, '');
  const normalized = normalizeHttpEndpoint(clean);
  if (!normalized) return [];
  if (/^https?:\/\//i.test(clean)) return [normalized];

  const isDev = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;
  const urls: string[] = [];
  const parsed = new URL(normalized);
  if (parsed.port) {
    // Host already carries a port (e.g. 192.168.1.50:7125) — don't append one.
    if (isDev) urls.push(`${window.location.origin}/moonraker/${clean}`);
    urls.push(normalized);
    return urls;
  }
  const ports = port === 7125 ? [7125, 80, 8080] : [port];
  for (const p of ports) {
    if (isDev) urls.push(`${window.location.origin}/moonraker/${clean}:${p}`);
    const direct = new URL(normalized);
    direct.port = p === 80 ? '' : String(p);
    urls.push(direct.toString().replace(/\/$/, ''));
  }
  return urls;
}

/** Human-readable transport, Local Network Access, and CORS guidance. */
function describeFetchFailure(base: string): string {
  return localNetworkFailureMessage(base, 'printer', 'Moonraker cors_domains');
}

/** Upload G-code to Moonraker; when startPrint, also begins the job. */
export async function sendToPrinter(
  cfg: PrinterConfig,
  gcode: string,
  filename: string,
  startPrint: boolean,
): Promise<SendResult> {
  if (!cfg.host) return { ok: false, message: 'No printer IP set.' };
  const safeName = filename.replace(/[^\w.-]/g, '_') || 'orcaxr.gcode';

  const form = new FormData();
  form.append('file', new Blob([gcode], { type: 'text/plain' }), safeName);
  form.append('root', 'gcodes');
  if (startPrint) form.append('print', 'true');

  const baseUrls = printerBaseUrls(cfg.host, cfg.port);
  let lastErrorMsg = '';

  for (const base of baseUrls) {
    try {
      const resp = await fetchLocalNetwork(`${base}/server/files/upload`, {
        method: 'POST',
        body: form,
      });
      if (!resp.ok) {
        lastErrorMsg = `Printer returned HTTP ${resp.status}.`;
        continue;
      }
      return {
        ok: true,
        message: startPrint ? `Uploaded ${safeName} and started print.` : `Uploaded ${safeName} to printer.`,
      };
    } catch {
      // A network / mixed-content / CORS failure lands here as an opaque TypeError.
      lastErrorMsg = describeFetchFailure(base);
    }
  }
  return { ok: false, message: lastErrorMsg };
}

/** Quick reachability probe: Moonraker's /printer/info. */
export async function probePrinter(cfg: PrinterConfig): Promise<SendResult> {
  if (!cfg.host) return { ok: false, message: 'No printer IP set.' };

  const baseUrls = printerBaseUrls(cfg.host, cfg.port);
  let lastErrorMsg = '';

  for (const base of baseUrls) {
    const url = `${base}/printer/info`;
    try {
      const resp = await fetchLocalNetwork(url);
      if (!resp.ok) {
        lastErrorMsg = `HTTP ${resp.status} from printer.`;
        continue;
      }
      const info = await resp.json();
      const state = info?.result?.state ?? 'ready';
      return { ok: true, message: `Connected — printer ${state}.` };
    } catch {
      lastErrorMsg = describeFetchFailure(base);
    }
  }
  return { ok: false, message: lastErrorMsg };
}
