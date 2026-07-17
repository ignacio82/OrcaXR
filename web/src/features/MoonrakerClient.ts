import { fetchLocalNetwork, localNetworkFailureMessage, normalizeHttpEndpoint } from '../net/LocalNetworkAccess';

export interface PrinterConfig {
  host: string;
  port: number;
  apiKey?: string;
}

export interface PrinterInfo {
  state: string;
  klippyState: string;
  hostname: string;
  softwareVersion: string;
}

export interface ServerInfo {
  components: string[];
  klippyState: string;
  moonrakerVersion: string;
}

export interface PrintSnapshot {
  state: string;
  filename: string;
  message: string;
  progress: number;
  printDurationSec: number;
  totalDurationSec: number;
  currentLayer: number | null;
  totalLayers: number | null;
  nozzleTemp: number;
  nozzleTarget: number;
  bedTemp: number;
  bedTarget: number;
  slotLoaded: boolean[];
  liveZmm: number | null;
  gcodeFilePosition: number | null;
  gcodeFileSize: number | null;
}

export interface FilamentSlot {
  slotIndex: number;
  colorHex: string;
  material: string;
  vendor: string;
}

export class MoonrakerClient {
  private printer: PrinterConfig;
  private baseUrl: string;

  constructor(printer: PrinterConfig) {
    this.printer = printer;
    this.baseUrl = normalizeHttpEndpoint(printer.host);
  }

  private async execute<T>(path: string, options?: RequestInit): Promise<T> {
    const baseUrls: string[] = [];

    const isDev = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;
    const hasScheme = /^https?:\/\//i.test(this.printer.host.trim());
    const hasExplicitPort = (() => {
      try {
        return new URL(this.baseUrl).port !== '';
      } catch {
        return false;
      }
    })();

    if (hasScheme) {
      // Explicit URL — including local HTTP, Tailscale Serve, or another
      // HTTPS reverse proxy. Use it verbatim: don't append ports or
      // silently change the user's chosen scheme.
      baseUrls.push(this.baseUrl);
    } else if (hasExplicitPort) {
      if (isDev) baseUrls.push(`${window.location.origin}/moonraker/${this.printer.host}`);
      baseUrls.push(this.baseUrl);
    } else if (this.printer.port === 7125) {
      // Default Klipper port is 7125, but Snapmaker U1 uses port 80 or 8080
      const hostRaw = this.printer.host.trim().replace(/\/$/, '');
      if (isDev) {
        baseUrls.push(`${window.location.origin}/moonraker/${hostRaw}:7125`);
        baseUrls.push(`${window.location.origin}/moonraker/${hostRaw}:80`);
        baseUrls.push(`${window.location.origin}/moonraker/${hostRaw}:8080`);
      }
      baseUrls.push(`${this.baseUrl}:7125`);
      baseUrls.push(this.baseUrl); // port 80 (default http)
      baseUrls.push(`${this.baseUrl}:8080`); // alternative web interface port
    } else if (this.printer.port === 80 || this.printer.port === 0) {
      const hostRaw = this.printer.host.trim().replace(/\/$/, '');
      if (isDev) baseUrls.push(`${window.location.origin}/moonraker/${hostRaw}:80`);
      baseUrls.push(this.baseUrl);
    } else {
      const hostRaw = this.printer.host.trim().replace(/\/$/, '');
      if (isDev) baseUrls.push(`${window.location.origin}/moonraker/${hostRaw}:${this.printer.port}`);
      baseUrls.push(`${this.baseUrl}:${this.printer.port}`);
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...((options?.headers as Record<string, string>) || {}),
    };

    if (this.printer.apiKey) {
      headers['X-Api-Key'] = this.printer.apiKey;
    }

    let lastError: any;
    for (const base of baseUrls) {
      const url = `${base}${path}`;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const response = await fetchLocalNetwork(url, { ...options, headers, signal: controller.signal });
        clearTimeout(timeoutId);
        const body = await response.text();

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${body}`);
        }

        return JSON.parse(body) as T;
      } catch (e: any) {
        lastError = e;
      }
    }

    let msg = lastError?.message || 'Unknown error';
    if (msg === 'Failed to fetch') {
      msg += ` (${localNetworkFailureMessage(this.baseUrl, 'printer', 'Moonraker cors_domains')})`;
    }
    throw new Error(`MoonrakerClient error: ${msg}`);
  }

  async ping(): Promise<PrinterInfo> {
    const res = await this.execute<any>('/printer/info');
    const obj = res.result || {};
    return {
      state: obj.state || 'unknown',
      klippyState: obj.state || 'unknown',
      hostname: obj.hostname || '',
      softwareVersion: obj.software_version || '',
    };
  }

  async serverInfo(): Promise<ServerInfo> {
    const res = await this.execute<any>('/server/info');
    const obj = res.result || {};
    return {
      components: obj.components || [],
      klippyState: obj.klippy_state || 'unknown',
      moonrakerVersion: obj.moonraker_version || '',
    };
  }

  async queryFilamentSlots(): Promise<FilamentSlot[]> {
    const res = await this.execute<any>('/printer/objects/query?print_task_config=&filament_detect=');
    const status = res.result?.status || {};
    const cfg = status.print_task_config;
    if (!cfg) {
      throw new Error("Printer didn't expose print_task_config");
    }

    const colors = cfg.filament_color_rgba || [];
    const types = cfg.filament_type || [];
    const vendors = cfg.filament_vendor || [];
    const exists = cfg.filament_exist || [];

    const slots: FilamentSlot[] = [];
    for (let i = 0; i < colors.length; i++) {
      let loaded = true;
      if (i < exists.length) {
        const v = exists[i];
        loaded = v === true || v === 1 || v === 'true' || v === '1';
      }
      if (!loaded) continue;

      let colorHex = (colors[i] || '').trim().replace(/^#/, '').toUpperCase();
      colorHex = colorHex.length >= 6 ? colorHex.substring(0, 6) : 'FFFFFF';
      colorHex = `#${colorHex}`;

      let material = (types[i] || '').trim().toUpperCase();
      if (material.startsWith('PLA')) material = 'PLA';
      else if (material.startsWith('PETG')) material = 'PETG';
      else if (material.startsWith('ABS')) material = 'ABS';
      else if (material.startsWith('ASA')) material = 'ASA';
      else if (material.startsWith('TPU')) material = 'TPU';
      else if (material.startsWith('PA')) material = 'PA';
      else if (material.startsWith('PVA')) material = 'PVA';
      else material = 'PLA';

      slots.push({
        slotIndex: i,
        colorHex,
        material,
        vendor: vendors[i] || '',
      });
    }

    return slots;
  }
}
