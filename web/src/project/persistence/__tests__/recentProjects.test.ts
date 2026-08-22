import assert from 'node:assert/strict';
import { RecentProjectsStore, type RecentProjectsStorage, RECENT_PROJECTS_STORAGE_KEY } from '../recentProjects';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class TestStorage implements RecentProjectsStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

test('lists empty array when storage is empty or corrupt', () => {
  const storage = new TestStorage();
  const store = new RecentProjectsStore(storage);
  assert.deepEqual(store.list(), []);

  storage.setItem(RECENT_PROJECTS_STORAGE_KEY, 'invalid json');
  assert.deepEqual(store.list(), []);

  storage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify([{ invalid: 'entry' }]));
  assert.deepEqual(store.list(), []);
});

test('adds and lists recent projects newest-first up to max capacity', () => {
  const storage = new TestStorage();
  const store = new RecentProjectsStore(storage, 3);

  store.add({
    id: 'p1',
    name: 'project1.3mf',
    openedAt: '2026-08-01T10:00:00Z',
    storageOrigin: 'local-file',
    modelCount: 2,
    plateCount: 1,
  });

  store.add({
    id: 'p2',
    name: 'project2.3mf',
    openedAt: '2026-08-02T10:00:00Z',
    storageOrigin: 'imported-archive',
    modelCount: 1,
    plateCount: 2,
  });

  store.add({
    id: 'p3',
    name: 'project3.3mf',
    openedAt: '2026-08-03T10:00:00Z',
    storageOrigin: 'local-file',
  });

  let list = store.list();
  assert.equal(list.length, 3);
  assert.equal(list[0].id, 'p3');
  assert.equal(list[1].id, 'p2');
  assert.equal(list[2].id, 'p1');

  // Adding a 4th pushes the oldest out (bounded cap = 3)
  store.add({
    id: 'p4',
    name: 'project4.3mf',
    openedAt: '2026-08-04T10:00:00Z',
    storageOrigin: 'session-autosave',
  });

  list = store.list();
  assert.equal(list.length, 3);
  assert.equal(list[0].id, 'p4');
  assert.equal(list[1].id, 'p3');
  assert.equal(list[2].id, 'p2');
});

test('re-adding an existing project moves it to front without duplicate', () => {
  const storage = new TestStorage();
  const store = new RecentProjectsStore(storage, 5);

  store.add({
    id: 'p1',
    name: 'cube.3mf',
    openedAt: '2026-08-01T10:00:00Z',
    storageOrigin: 'local-file',
  });
  store.add({
    id: 'p2',
    name: 'benchy.3mf',
    openedAt: '2026-08-02T10:00:00Z',
    storageOrigin: 'local-file',
  });

  assert.equal(store.list()[0].name, 'benchy.3mf');

  store.add({
    id: 'p1-new',
    name: 'cube.3mf',
    openedAt: '2026-08-03T10:00:00Z',
    storageOrigin: 'local-file',
  });

  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'cube.3mf');
  assert.equal(list[1].name, 'benchy.3mf');
});

test('removes and clears entries', () => {
  const storage = new TestStorage();
  const store = new RecentProjectsStore(storage);

  const e1 = store.add({
    name: 'a.3mf',
    storageOrigin: 'local-file',
  });
  const e2 = store.add({
    name: 'b.3mf',
    storageOrigin: 'local-file',
  });

  assert.equal(store.list().length, 2);

  store.remove(e1.id);
  const remaining = store.list();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, e2.id);

  store.clear();
  assert.deepEqual(store.list(), []);
});

console.log(`\nRecent projects store tests: ${passed} passed.`);
