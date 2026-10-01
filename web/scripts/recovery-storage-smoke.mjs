import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';
const built = await build({
  entryPoints: ['src/persistence/IndexedDbRecoveryStore.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Recovery',
  write: false,
});
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<script>' + built.outputFiles[0].text + '</script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const Store = globalThis.Recovery.IndexedDbRecoveryStore;
    const name = 'recovery-smoke-' + Date.now();
    const a = new Store({ name, budgetBytes: 120 });
    const b = new Store({ name, budgetBytes: 120 });
    async function write(store, sessionId, fill = 1) {
      const bytes = new Uint8Array(20).fill(fill);
      const digest =
        'sha256:' +
        [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('');
      return store.write({
        guard: {
          projectId: 'project-one',
          revision: fill,
          semanticHash: 'fnv1a64:1111111111111111',
          assetFingerprint: 'fnv1a64:2222222222222222',
        },
        sessionId,
        projectName: 'Part',
        filename: 'Part.3mf',
        bytes,
        digest,
      });
    }
    const check = (value, message) => {
      if (!value) throw new Error(message);
    };
    const writes = await Promise.all([write(a, 'tab-a', 1), write(b, 'tab-a', 2), write(a, 'tab-b', 3)]);
    check(writes[0].key[2] !== writes[1].key[2], 'concurrent sequence collision');
    for (let i = 4; i < 7; i++) await write(a, 'tab-a', i);
    let rows = await a.list();
    check(rows.length === 4, 'retention must be three own snapshots plus the other tab');
    check(rows.filter((r) => r.key[1] === 'tab-b').length === 1, 'other tab pruned');
    const before = JSON.stringify(rows);
    const original = globalThis.IDBObjectStore.prototype.put;
    globalThis.IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'archives') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return original.apply(this, args);
    };
    let quota = false;
    try {
      await write(a, 'tab-a', 7);
    } catch (error) {
      quota = error.name === 'QuotaExceededError';
    } finally {
      globalThis.IDBObjectStore.prototype.put = original;
    }
    check(quota, 'quota injection did not fire');
    check(JSON.stringify(await a.list()) === before, 'failed transaction destroyed previous valid records');
    const latest = rows.filter((r) => r.key[1] === 'tab-a').at(-1);
    const db = await new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    async function mutate(storeName, value, key) {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], 'readwrite');
        transaction.objectStore(storeName).put(value, key);
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
      });
    }
    await mutate('archives', new Uint8Array(20).fill(99), latest.key);
    let corrupt = false;
    try {
      await a.read(latest.key);
    } catch (error) {
      corrupt = /integrity/.test(error.message);
    }
    check(corrupt, 'corruption not detected');
    const older = rows.find((row) => row.key[1] === 'tab-a' && row.key[2] !== latest.key[2]);
    check(
      (await a.read(older.key)).bytes.length === 20,
      'older valid recovery was not available after newest corruption',
    );
    check((await a.list()).length === rows.length, 'read deleted a corrupt record');
    const other = rows.find((r) => r.key[1] === 'tab-b');
    await mutate('metadata', { ...other.metadata, schemaVersion: 99 }, other.key);
    check(
      (await a.list()).find((r) => r.key[1] === 'tab-b').problem.includes('Unsupported'),
      'future schema was not reported',
    );
    check((await a.readForDownload(other.key)).bytes.length === 20, 'future archive cannot be explicitly downloaded');
    await a.discardSession('project-one', 'tab-a');
    rows = await a.list();
    check(rows.length === 1 && rows[0].key[1] === 'tab-b', 'discard crossed lineages');
    await b.discardSession('project-one', 'tab-b');
    check((await a.list()).length === 1, 'automatic discard removed future data');
    await a.discard(other.key);
    check((await a.list()).length === 0, 'explicit discard did not delete selected future record');
    const supported = await write(a, 'tab-a', 8);
    const futureKey = ['project-one', 'tab-a', 100];
    await mutate('metadata', { ...supported, key: futureKey, schemaVersion: 99 }, futureKey);
    await mutate('archives', new Uint8Array(20).fill(77), futureKey);
    const afterFuture = await write(a, 'tab-a', 9);
    check(afterFuture.key[2] === 101, 'an older writer reused a sequence allocated by a future version');
    await a.discardSession('project-one', 'tab-a');
    rows = await a.list();
    check(rows.length === 1 && rows[0].key[2] === 100, 'lineage discard removed a future record');
    await a.discard(futureKey);
    a.setBudget(20);
    b.setBudget(20);
    const peer = await write(b, 'tab-b', 10);
    let budget = false;
    try {
      await write(a, 'tab-a', 11);
    } catch (error) {
      budget = error.name === 'QuotaExceededError';
    }
    check(budget, 'budget pressure did not refuse another session eviction');
    check((await a.read(peer.key)).metadata.key[1] === 'tab-b', 'budget pressure removed another session');
    a.dispose();
    b.dispose();
    db.close();
    let disposed = false;
    try {
      await a.list();
    } catch (error) {
      disposed = /disposed/.test(error.message);
    }
    check(disposed, 'disposed store reopened');
    return {
      concurrentWrites: writes.length,
      rollback: true,
      corruption: true,
      futureVersion: true,
      sessionIsolation: true,
      globalBudget: true,
      futureSequence: true,
    };
  });
  assert.equal(result.rollback, true);
  console.log(result);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
