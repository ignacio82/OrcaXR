import assert from 'node:assert';
import {
  loadPrinterEndpointPreferences,
  savePrinterEndpointPreferences,
  type KeyValueStorage,
} from '../PrinterEndpointPreferences';

class MemoryStorage implements KeyValueStorage {
  value: string | null = null;
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, value: string): void {
    this.value = value;
  }
}

const storage = new MemoryStorage();
assert.deepStrictEqual(loadPrinterEndpointPreferences(storage), { host: '', port: 7125 });

savePrinterEndpointPreferences({ host: ' https://printer.example/ ', port: 443 }, storage);
assert.strictEqual(storage.value, '{"host":"https://printer.example/","port":443}');
assert.deepStrictEqual(loadPrinterEndpointPreferences(storage), { host: 'https://printer.example/', port: 443 });

storage.value = '{"host":7,"port":0,"apiKey":"must-not-load"}';
assert.deepStrictEqual(loadPrinterEndpointPreferences(storage), { host: '', port: 7125 });
assert.strictEqual(storage.value, '{"host":"","port":7125}');
assert.ok(!storage.value.includes('apiKey'));

storage.value = '{bad json';
assert.deepStrictEqual(loadPrinterEndpointPreferences(storage), { host: '', port: 7125 });
assert.strictEqual(storage.value, '{"host":"","port":7125}');

assert.throws(() => savePrinterEndpointPreferences({ host: 'printer', port: 0 }, storage));

console.log('Printer endpoint preference tests passed');
