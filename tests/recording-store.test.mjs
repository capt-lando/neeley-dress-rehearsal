import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createRecordingStore } from '../lib/recording-store.mjs';

const DB = 'recording-store-test';
const audio = (text = 'audio bytes') => new Blob([text], { type: 'audio/wav' });
const entry = (id = 'recording-1', extra = {}) => ({ id, blob: audio(), duration: 12.5, caption: 'Practice café 😀', createdAt: 1_792_500_000_000, ...extra });

function openRaw(factory, version = 1) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Unexpected blocked raw database open'));
  });
}
async function rawRows(factory) {
  const database = await openRaw(factory);
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(['metadata', 'audio'], 'readonly');
      const metadata = tx.objectStore('metadata').getAll();
      const recordings = tx.objectStore('audio').getAll();
      tx.oncomplete = () => resolve({ metadata: metadata.result, audio: recordings.result });
      tx.onabort = () => reject(tx.error);
    });
  } finally { database.close(); }
}
function interceptFactory(factory, intercept) {
  return {
    open(...args) {
      const request = factory.open(...args);
      request.addEventListener('success', () => {
        const connection = request.result;
        const original = connection.transaction.bind(connection);
        connection.transaction = (...parameters) => {
          const tx = original(...parameters);
          intercept(tx, parameters);
          return tx;
        };
      });
      return request;
    },
  };
}

test('saved audio and metadata survive a new store instance without storing private coaching state', async () => {
  const indexedDB = new IDBFactory();
  const store = createRecordingStore({ indexedDB, dbName: DB });
  const value = entry('persistent', { apiKey: 'NEVER-SAVE-KEY', transcript: 'NEVER-SAVE-TRANSCRIPT', targetScript: 'NEVER-SAVE-SCRIPT', rubric: 'NEVER-SAVE-RUBRIC' });
  const saved = await store.save(value);
  assert.deepEqual(Object.keys(saved).sort(), ['caption', 'createdAt', 'duration', 'id', 'size', 'type']);
  store.close();
  const reopened = createRecordingStore({ indexedDB, dbName: DB });
  const result = await reopened.get('persistent');
  assert.equal(await result.blob.text(), 'audio bytes');
  assert.equal(result.caption, value.caption);
  assert.equal(result.duration, value.duration);
  assert.equal(result.createdAt, value.createdAt);
  assert.equal(result.size, value.blob.size);
  assert.deepEqual(await reopened.list(), [saved]);
  const raw = await rawRows(indexedDB);
  assert.deepEqual(Object.keys(raw.metadata[0]).sort(), ['caption', 'createdAt', 'duration', 'id', 'size', 'type']);
  assert.deepEqual(Object.keys(raw.audio[0]).sort(), ['blob', 'id']);
  assert.doesNotMatch(JSON.stringify(raw), /NEVER-SAVE/);
  reopened.close();
});

test('list is newest first and reads only metadata, with no audio blobs', async () => {
  const indexedDB = new IDBFactory();
  const scopes = [];
  const wrapped = interceptFactory(indexedDB, (_, [names, mode]) => scopes.push({ names, mode }));
  const store = createRecordingStore({ indexedDB: wrapped, dbName: DB });
  await store.save(entry('older', { createdAt: 100 }));
  await store.save(entry('newer', { createdAt: 300 }));
  await store.save(entry('middle', { createdAt: 200 }));
  const list = await store.list();
  assert.deepEqual(list.map(value => value.id), ['newer', 'middle', 'older']);
  assert.ok(list.every(value => !Object.hasOwn(value, 'blob')));
  assert.deepEqual(scopes.at(-1), { names: ['metadata'], mode: 'readonly' });
  list[0].caption = 'mutated in UI';
  assert.notEqual((await store.get('newer')).caption, 'mutated in UI');
  store.close();
});

test('concurrent operations share one open and keep all recordings', async () => {
  const actual = new IDBFactory();
  let opens = 0;
  const indexedDB = { open(...args) { opens++; return actual.open(...args); } };
  const store = createRecordingStore({ indexedDB, dbName: DB });
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.save(entry(`take-${index}`, { createdAt: index }))));
  assert.equal(opens, 1);
  assert.equal((await store.list()).length, 12);
  store.close();
});

test('save validates the audio, identifier, duration, caption and date before opening storage', async () => {
  let opened = false;
  const store = createRecordingStore({ indexedDB: { open() { opened = true; throw Error('Should not open'); } }, dbName: DB });
  const bad = [
    [entry('bad', { blob: new Blob([], { type: 'audio/wav' }) }), 'RECORDING_AUDIO'],
    [entry('bad', { blob: new Blob(['not audio'], { type: 'text/plain' }) }), 'RECORDING_AUDIO'],
    [entry('bad', { blob: { size: 12, type: 'audio/wav' } }), 'RECORDING_AUDIO'],
    [entry('bad', { blob: new Blob([new Uint8Array(30 * 1024 * 1024 + 1)], { type: 'audio/wav' }) }), 'RECORDING_AUDIO'],
    [entry('../bad'), 'RECORDING_ID'], [entry('__proto__'), 'RECORDING_ID'],
    [entry('bad\nkey'), 'RECORDING_ID'], [entry('x'.repeat(129)), 'RECORDING_ID'],
    [entry('bad', { duration: 0.49 }), 'RECORDING_DURATION'], [entry('bad', { duration: 900 + 1 / 16000 }), 'RECORDING_DURATION'],
    [entry('bad', { duration: NaN }), 'RECORDING_DURATION'],
    [entry('bad', { caption: 'x'.repeat(256) }), 'RECORDING_CAPTION'], [entry('bad', { caption: 'two\nlines' }), 'RECORDING_CAPTION'],
    [entry('bad', { createdAt: Infinity }), 'RECORDING_DATE'], [entry('bad', { createdAt: '2026-10-20' }), 'RECORDING_DATE'],
  ];
  for (const [value, code] of bad) await assert.rejects(store.save(value), { code });
  assert.equal(opened, false);
});

test('fifteen-minute and 30 MiB boundaries and 255-character captions survive browser storage', async () => {
  const store = createRecordingStore({ indexedDB: new IDBFactory(), dbName: DB });
  await store.save(entry('minimum', { duration: 0.5, caption: 'x'.repeat(255) }));
  await store.save(entry('maximum', { duration: 900, blob: new Blob([new Uint8Array(30 * 1024 * 1024)], { type: 'audio/wav' }) }));
  assert.equal((await store.list()).length, 2);
  const maximum = await store.get('maximum');
  assert.equal(maximum.duration, 900); assert.equal(maximum.blob.size, 30 * 1024 * 1024);
  store.close();
});

test('remove commits deletion of metadata and audio together and leaves other recordings intact', async () => {
  const indexedDB = new IDBFactory();
  const store = createRecordingStore({ indexedDB, dbName: DB });
  await store.save(entry('keep'));
  await store.save(entry('delete'));
  assert.equal(await store.remove('delete'), true);
  assert.equal(await store.get('delete'), null);
  assert.equal(await store.remove('missing'), true);
  const rows = await rawRows(indexedDB);
  assert.deepEqual(rows.metadata.map(value => value.id), ['keep']);
  assert.deepEqual(rows.audio.map(value => value.id), ['keep']);
  assert.equal(await (await store.get('keep')).blob.text(), 'audio bytes');
  store.close();
});

test('failed audio write rolls back metadata, preserves existing records, and reports quota recovery', async () => {
  const indexedDB = new IDBFactory();
  let fail = false;
  const wrapped = interceptFactory(indexedDB, (tx, [, mode]) => {
    if (!fail || mode !== 'readwrite') return;
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = name => {
      const value = objectStore(name);
      if (name === 'audio') value.put = () => { throw new DOMException('internal quota details', 'QuotaExceededError'); };
      return value;
    };
  });
  const store = createRecordingStore({ indexedDB: wrapped, dbName: DB });
  await store.save(entry('existing', { blob: audio('original'), caption: 'Original' }));
  fail = true;
  await assert.rejects(store.save(entry('new')), problem => problem.code === 'RECORDING_STORAGE_QUOTA' && /Download/.test(problem.message) && !/internal/.test(problem.message));
  await assert.rejects(store.save(entry('existing', { blob: audio('replacement'), caption: 'Replacement' })), { code: 'RECORDING_STORAGE_QUOTA' });
  assert.equal(await store.get('new'), null);
  const original = await store.get('existing');
  assert.equal(original.caption, 'Original');
  assert.equal(await original.blob.text(), 'original');
  const rows = await rawRows(indexedDB);
  assert.equal(rows.metadata.length, 1);
  assert.equal(rows.audio.length, 1);
  store.close();
});

test('a request success followed by transaction abort never reports a saved recording', async () => {
  const indexedDB = new IDBFactory();
  let individualSuccess = false;
  const wrapped = interceptFactory(indexedDB, (tx, [, mode]) => {
    if (mode !== 'readwrite') return;
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = name => {
      const value = objectStore(name);
      if (name === 'metadata') {
        const put = value.put.bind(value);
        value.put = (...args) => {
          const request = put(...args);
          request.addEventListener('success', () => { individualSuccess = true; tx.abort(); });
          return request;
        };
      }
      return value;
    };
  });
  const store = createRecordingStore({ indexedDB: wrapped, dbName: DB });
  await assert.rejects(store.save(entry()), { code: 'RECORDING_STORAGE_FAILED' });
  assert.equal(individualSuccess, true);
  assert.deepEqual(await rawRows(indexedDB), { metadata: [], audio: [] });
  store.close();
});

test('an aborted deletion restores both stores', async () => {
  const indexedDB = new IDBFactory();
  let fail = false;
  const wrapped = interceptFactory(indexedDB, (tx, [, mode]) => {
    if (!fail || mode !== 'readwrite') return;
    const objectStore = tx.objectStore.bind(tx);
    tx.objectStore = name => {
      const value = objectStore(name);
      if (name === 'metadata') {
        const remove = value.delete.bind(value);
        value.delete = id => { const request = remove(id); request.addEventListener('success', () => tx.abort()); return request; };
      }
      return value;
    };
  });
  const store = createRecordingStore({ indexedDB: wrapped, dbName: DB });
  await store.save(entry('keep'));
  fail = true;
  await assert.rejects(store.remove('keep'), { code: 'RECORDING_STORAGE_FAILED' });
  assert.equal(await (await store.get('keep')).blob.text(), 'audio bytes');
  const rows = await rawRows(indexedDB);
  assert.equal(rows.metadata.length, 1);
  assert.equal(rows.audio.length, 1);
  store.close();
});

test('missing or security-blocked IndexedDB rejects operations without breaking factory creation', async () => {
  const missing = createRecordingStore({ indexedDB: undefined });
  await assert.rejects(missing.list(), { code: 'RECORDING_STORAGE_UNAVAILABLE' });
  const guarded = createRecordingStore({ get indexedDB() { throw new DOMException('blocked', 'SecurityError'); } });
  await assert.rejects(guarded.list(), { code: 'RECORDING_STORAGE_UNAVAILABLE' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  try {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
    const defaultStore = createRecordingStore();
    await assert.rejects(defaultStore.list(), { code: 'RECORDING_STORAGE_UNAVAILABLE' });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous); else delete globalThis.indexedDB;
  }
});

test('a synchronous browser open failure is actionable and can be retried', async () => {
  const actual = new IDBFactory();
  let attempts = 0;
  const store = createRecordingStore({ dbName: DB, indexedDB: { open(...args) { if (++attempts === 1) throw new DOMException('private browser details', 'SecurityError'); return actual.open(...args); } } });
  await assert.rejects(store.list(), problem => problem.code === 'RECORDING_STORAGE_UNAVAILABLE' && !problem.message.includes('private browser details'));
  assert.deepEqual(await store.list(), []);
  store.close();
});

test('blocked open rejects immediately, releases late connections, and allows a new attempt', async () => {
  const actual = new IDBFactory();
  const blockedRequest = {};
  let attempts = 0, closed = 0, aborted = 0;
  const store = createRecordingStore({ dbName: DB, indexedDB: { open(...args) { return ++attempts === 1 ? blockedRequest : actual.open(...args); } } });
  const first = store.list();
  blockedRequest.onblocked();
  await assert.rejects(first, problem => problem.code === 'RECORDING_STORAGE_BLOCKED' && /Close the other tabs/.test(problem.message));
  await store.save(entry('after-block'));
  blockedRequest.transaction = { abort() { aborted++; } };
  blockedRequest.onupgradeneeded();
  blockedRequest.result = { close() { closed++; } };
  blockedRequest.onsuccess();
  assert.equal(aborted, 1);
  assert.equal(closed, 1);
  assert.equal((await store.list())[0].id, 'after-block');
  store.close();
});

test('close cancels a pending open, closes its late connection, and permits reopening', async () => {
  const actual = new IDBFactory();
  const openingRequest = {};
  let attempts = 0, closed = 0;
  const store = createRecordingStore({ dbName: DB, indexedDB: { open(...args) { return ++attempts === 1 ? openingRequest : actual.open(...args); } } });
  const pending = store.list();
  store.close();
  await assert.rejects(pending, { code: 'RECORDING_STORAGE_CLOSED' });
  openingRequest.result = { close() { closed++; } };
  openingRequest.onsuccess();
  assert.equal(closed, 1);
  assert.deepEqual(await store.list(), []);
  await store.save(entry());
  store.close();
  assert.equal((await store.list()).length, 1);
  store.close();
});

test('version changes release the connection without deleting recordings', async () => {
  const indexedDB = new IDBFactory();
  const store = createRecordingStore({ indexedDB, dbName: DB });
  await store.save(entry());
  const upgraded = await openRaw(indexedDB, 2);
  assert.equal(upgraded.version, 2);
  const saved = await new Promise((resolve, reject) => {
    const tx = upgraded.transaction('metadata');
    const request = tx.objectStore('metadata').getAll();
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error);
  });
  assert.equal(saved.length, 1);
  upgraded.close();
  await assert.rejects(store.list(), { code: 'RECORDING_STORAGE_UNAVAILABLE' });
  store.close();
});
