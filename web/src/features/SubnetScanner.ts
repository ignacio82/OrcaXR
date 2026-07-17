import { probePrinter } from '../net/PrinterClient';

export interface DiscoveredPrinter {
  host: string;
  name: string;
}

export class SubnetScanner {
  async scanLan(subnet: string, progress?: (done: number, total: number) => void): Promise<DiscoveredPrinter[]> {
    const discovered: DiscoveredPrinter[] = [];
    const total = 254;
    let done = 0;

    // In a browser, we are limited by CORS and parallel request limits.
    // We will scan in chunks of 16 to avoid exhausting browser connection limits.
    const chunks = [];
    for (let i = 1; i <= 254; i += 16) {
      const chunk = [];
      for (let j = i; j < i + 16 && j <= 254; j++) {
        chunk.push(j);
      }
      chunks.push(chunk);
    }

    for (const chunk of chunks) {
      const promises = chunk.map(async (lastOctet) => {
        const host = `${subnet}.${lastOctet}`;
        try {
          const res = await probePrinter({ host, port: 7125 });
          if (res.ok) {
            discovered.push({ host, name: `Printer at ${host}` });
          }
        } catch {
          // Ignore timeouts
        }
      });
      await Promise.all(promises);
      done += chunk.length;
      if (progress) progress(done, total);
    }
    return discovered;
  }
}
