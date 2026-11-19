// IndexedDB persistence (falls back to memory where IndexedDB is unavailable).
const DB_NAME = 'notes-on-foar';
const VERSION = 1;
let db = null;
const memory = { notes: new Map(), folders: new Map(), kv: new Map() };

export async function open() {
  if (!globalThis.indexedDB) return;
  db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('notes', { keyPath: 'id' });
      d.createObjectStore('folders', { keyPath: 'id' });
      d.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    console.warn('IndexedDB unavailable, using memory storage', err);
    return null;
  });
}

function run(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getAll(store) {
  if (!db) return [...memory[store].values()];
  return run(store, 'readonly', (s) => s.getAll());
}

export async function writeNotes(puts, deletes) {
  if (!puts.length && !deletes.length) return;
  if (!db) {
    for (const n of puts) memory.notes.set(n.id, n);
    for (const id of deletes) memory.notes.delete(id);
    return;
  }
  await run('notes', 'readwrite', (s) => {
    for (const n of puts) s.put(n);
    for (const id of deletes) s.delete(id);
  });
}

export async function replaceFolders(folders) {
  if (!db) {
    memory.folders = new Map(folders.map((f) => [f.id, f]));
    return;
  }
  await run('folders', 'readwrite', (s) => {
    s.clear();
    for (const f of folders) s.put(f);
  });
}

export async function kvGet(key) {
  if (!db) return memory.kv.get(key);
  return run('kv', 'readonly', (s) => s.get(key));
}

export async function kvSet(key, value) {
  if (!db) {
    memory.kv.set(key, value);
    return;
  }
  await run('kv', 'readwrite', (s) => s.put(value, key));
}
