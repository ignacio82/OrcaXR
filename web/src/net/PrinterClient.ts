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

/**
 * Ordered list of base URLs to try for a printer.
 *
 * If the host carries an explicit http(s):// scheme — e.g. a Tailscale Serve
 * endpoint `https://<name>.ts.net` or any HTTPS reverse proxy in front of
 * Moonraker — it is used verbatim: no port probing, no scheme fallback.
 * Preserving an https target exactly is what lets an https-hosted OrcaXR reach
 * the printer without the browser's mixed-content block. Otherwise we probe the
 * usual Moonraker/Snapmaker ports over http (dev also gets the origin-stripping
 * vite proxy).
 */
function printerBaseUrls(host: string, port: number): string[] {
  const clean = host.trim().replace(/\/$/, '');
  if (/^https?:\/\//i.test(clean)) return [clean];

  const isDev = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;
  const urls: string[] = [];
  if (clean.includes(':')) {
    // Host already carries a port (e.g. 192.168.1.50:7125) — don't append one.
    if (isDev) urls.push(`${window.location.origin}/moonraker/${clean}`);
    urls.push(`http://${clean}`);
    return urls;
  }
  const ports = port === 7125 ? [7125, 80, 8080] : [port];
  for (const p of ports) {
    if (isDev) urls.push(`${window.location.origin}/moonraker/${clean}:${p}`);
    urls.push(`http://${clean}${p !== 80 ? ':' + p : ''}`);
  }
  return urls;
}

/** Human-readable reason a fetch to `base` failed, distinguishing the
 *  browser's mixed-content block (https page → http printer) from a plain
 *  unreachable/CORS failure — the former can't be fixed with cors_domains. */
function describeFetchFailure(base: string): string {
  const pageHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'this app';
  if (pageHttps && base.startsWith('http://')) {
    return `Mixed content: this HTTPS page (${origin}) can't reach ${base} (http). `
      + `Use an HTTPS printer URL — e.g. Tailscale Serve → https://<name>.ts.net.`;
  }
  return `Could not reach ${base}. Check the printer is on this network and that `
    + `Moonraker cors_domains includes ${origin}.`;
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
      const resp = await fetch(`${base}/server/files/upload`, {
        method: 'POST',
        body: form,
      });
      if (!resp.ok) {
        lastErrorMsg = `Printer returned HTTP ${resp.status}.`;
        continue;
      }
      return {
        ok: true,
        message: startPrint
          ? `Uploaded ${safeName} and started print.`
          : `Uploaded ${safeName} to printer.`,
      };
    } catch (e) {
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
      const resp = await fetch(url);
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
