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
        const raw = printer.host.trim().replace(/\/$/, '');
        const withScheme = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
        if (raw.includes(':') && !raw.startsWith('http')) {
            this.baseUrl = withScheme;
        } else if (printer.port === 80 || printer.port === 0) {
            this.baseUrl = withScheme;
        } else {
            this.baseUrl = `${withScheme}:${printer.port}`;
        }
    }

    private async execute<T>(path: string, options?: RequestInit): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const headers: Record<string, string> = {
            'Accept': 'application/json',
            ...((options?.headers as Record<string, string>) || {})
        };

        if (this.printer.apiKey) {
            headers['X-Api-Key'] = this.printer.apiKey;
        }

        try {
            const response = await fetch(url, { ...options, headers });
            const body = await response.text();
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${body}`);
            }
            
            return JSON.parse(body) as T;
        } catch (e: any) {
            throw new Error(`MoonrakerClient error: ${e.message}`);
        }
    }

    async ping(): Promise<PrinterInfo> {
        const res = await this.execute<any>('/printer/info');
        const obj = res.result || {};
        return {
            state: obj.state || 'unknown',
            klippyState: obj.state || 'unknown',
            hostname: obj.hostname || '',
            softwareVersion: obj.software_version || ''
        };
    }

    async serverInfo(): Promise<ServerInfo> {
        const res = await this.execute<any>('/server/info');
        const obj = res.result || {};
        return {
            components: obj.components || [],
            klippyState: obj.klippy_state || 'unknown',
            moonrakerVersion: obj.moonraker_version || ''
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
                loaded = (v === true || v === 1 || v === 'true' || v === '1');
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
                vendor: vendors[i] || ''
            });
        }

        return slots;
    }
}
