import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { createHostedDraftStore } from '../lib/hosted-drafts.mjs';

const DB = 'encrypted-draft-tests', project = 'https://project.test';
const ownerA = '10000000-0000-4000-8000-000000000001', ownerB = '10000000-0000-4000-8000-000000000002';
const record = '20000000-0000-4000-8000-000000000001', request = '30000000-0000-4000-8000-000000000001';
const identity = { ownerId: ownerA, recordingId: record, requestId: request };
const key = Buffer.alloc(32, 73).toString('base64url'), otherKey = Buffer.alloc(32, 19).toString('base64url');
const pcm = (samples, value = 8192) => new Int16Array(samples).fill(value).buffer;
const fixture = (options = {}) => {
  const indexedDB = options.indexedDB || new IDBFactory();
  return { indexedDB, store: createHostedDraftStore({ indexedDB, crypto: webcrypto, dbName: DB, project, ...options }) };
};
async function raw(factory, mode, run) {
  const db = await new Promise((resolve, reject) => {
    const opening = factory.open(DB, 1); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(['drafts', 'blocks'], mode); let result;
      tx.oncomplete = () => resolve(typeof result === 'function' ? result() : result); tx.onabort = () => reject(tx.error);
      result = run(tx);
    });
  } finally { db.close(); }
}
async function rows(factory) {
  return raw(factory, 'readonly', tx => {
    const drafts = tx.objectStore('drafts').getAll(), blocks = tx.objectStore('blocks').getAll();
    return () => ({ drafts: drafts.result, blocks: blocks.result });
  });
}
async function changeBlock(factory, change) {
  await raw(factory, 'readwrite', tx => {
    const blocks = tx.objectStore('blocks'), get = blocks.getAll();
    get.onsuccess = () => { change(get.result, blocks, tx.objectStore('drafts')); };
  });
}

test('encrypted checkpoints survive refresh and reconstruct canonical mono 16 kHz WAV', async () => {
  const { indexedDB, store } = fixture();
  await store.begin(identity, key);
  store.append(pcm(4800)); store.append(pcm(4800)); store.append(pcm(4800));
  assert.deepEqual(await store.flush(), { samples24k: 14400, durationSeconds: 0.6 });
  store.close();
  const restored = fixture({ indexedDB }).store;
  const result = await restored.load(identity, key), wav = Buffer.from(await result.blob.arrayBuffer());
  assert.equal(result.durationSeconds, 0.6); assert.equal(result.samples24k, 14400);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1); assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.length, 44 + 9600 * 2); assert.equal(wav.readInt16LE(44), 8192);
  assert.equal(result.recordingId, record); assert.equal(result.requestId, request);
  restored.close();
});

test('no key, PCM, transcript or preparation text is persisted in plain text', async () => {
  const { indexedDB, store } = fixture();
  await store.begin({ ...identity, transcript: 'DO NOT STORE THIS', targetScript: 'PRIVATE SCRIPT' }, key);
  store.append(pcm(24000, 12345)); await store.flush();
  const saved = await rows(indexedDB);
  assert.doesNotMatch(JSON.stringify(saved), /DO NOT STORE THIS|PRIVATE SCRIPT/);
  assert.ok(!JSON.stringify(saved).includes(key));
  assert.equal(saved.blocks.length, 2);
  assert.ok(saved.blocks.every(block => block.ciphertext.byteLength === 24000 + 16 && block.iv.byteLength === 12));
  assert.notDeepEqual(saved.blocks[0].iv, saved.blocks[1].iv, 'Each encrypted block gets a fresh nonce');
  assert.equal(Buffer.from(saved.blocks[0].ciphertext).includes(Buffer.from(pcm(100, 12345))), false);
  assert.deepEqual(Object.keys(saved.drafts[0]).sort(), ['createdAt', 'key', 'manifest', 'ownerId', 'project', 'recordingId', 'requestId', 'samples', 'sequence', 'updatedAt', 'version']);
  store.close();
});

test('owner, project and exact request binding prevent cross-account or spoofed local recovery', async () => {
  const { indexedDB, store } = fixture(); await store.begin(identity, key); store.append(pcm(12000)); await store.flush();
  assert.equal(await store.load({ ...identity, ownerId: ownerB }, key), null);
  assert.equal(await store.load({ ...identity, requestId: '30000000-0000-4000-8000-000000000002' }, key), null);
  const anotherProject = fixture({ indexedDB, project: 'https://another-project.test' }).store;
  assert.equal(await anotherProject.load(identity, key), null);
  await assert.rejects(store.load(identity, otherKey), { code: 'DRAFT_CORRUPT' });
  // Renaming the visible metadata cannot move the encrypted audio to another owner.
  await raw(indexedDB, 'readwrite', tx => {
    const drafts = tx.objectStore('drafts'), get = drafts.getAll();
    get.onsuccess = () => {
      const row = get.result[0]; row.ownerId = ownerB; row.key = JSON.stringify([project, ownerB]); drafts.put(row);
    };
  });
  await assert.rejects(store.load({ ...identity, ownerId: ownerB }, key), { code: 'DRAFT_CORRUPT' });
  store.close(); anotherProject.close();
});

test('ciphertext modification, block deletion, sequence swaps and truncated manifests are detected', async () => {
  for (const mutation of ['ciphertext', 'delete', 'sequence', 'manifest']) {
    const { indexedDB, store } = fixture(); await store.begin(identity, key); store.append(pcm(24000)); await store.flush();
    await changeBlock(indexedDB, (blocks, objectStore, drafts) => {
      if (mutation === 'ciphertext') { new Uint8Array(blocks[0].ciphertext)[0] ^= 1; objectStore.put(blocks[0]); }
      if (mutation === 'delete') objectStore.delete([blocks[0].ownerKey, 0]);
      if (mutation === 'sequence') { const ciphertext = blocks[0].ciphertext; blocks[0].ciphertext = blocks[1].ciphertext; blocks[1].ciphertext = ciphertext; objectStore.put(blocks[0]); objectStore.put(blocks[1]); }
      if (mutation === 'manifest') {
        objectStore.delete([blocks[0].ownerKey, 1]);
        const get = drafts.get(blocks[0].ownerKey); get.onsuccess = () => { const row = get.result; row.sequence = 1; row.samples = 12000; drafts.put(row); };
      }
    });
    await assert.rejects(store.load(identity, key), { code: 'DRAFT_CORRUPT' }, mutation);
    store.close();
  }
});

test('one active draft per owner is enforced without replacing another account draft', async () => {
  const { indexedDB, store } = fixture(); await store.begin(identity, key); store.append(pcm(12000)); await store.flush();
  const second = fixture({ indexedDB }).store;
  await assert.rejects(second.begin({ ...identity, recordingId: '20000000-0000-4000-8000-000000000002' }, key), { code: 'DRAFT_ACTIVE' });
  await second.begin({ ...identity, ownerId: ownerB }, otherKey); second.append(pcm(12000, -10000)); await second.flush();
  assert.equal((await store.load(identity, key)).samples24k, 12000);
  assert.equal((await second.load({ ...identity, ownerId: ownerB }, otherKey)).samples24k, 12000);
  store.close(); second.close();
});

test('remove is exact-request scoped and queued writes cannot resurrect an explicitly discarded draft', async () => {
  const { indexedDB, store } = fixture(); await store.begin(identity, key); store.append(pcm(24000));
  assert.equal(await store.remove({ ...identity, requestId: '30000000-0000-4000-8000-000000000002' }), false);
  assert.equal(await store.remove(identity), true);
  assert.deepEqual(await rows(indexedDB), { drafts: [], blocks: [] });
  assert.equal(await store.load(identity, key), null);
  assert.throws(() => store.append(pcm(1)), { code: 'DRAFT_UNAVAILABLE' }); store.close();
});

test('sign-out cleanup affects only that owner and project', async () => {
  const { indexedDB, store } = fixture(); await store.begin(identity, key); store.append(pcm(12000)); await store.flush();
  const other = fixture({ indexedDB }).store, otherId = { ...identity, ownerId: ownerB };
  await other.begin(otherId, otherKey); other.append(pcm(12000)); await other.flush();
  await store.clearOwner(ownerA);
  assert.equal(await store.load(identity, key), null); assert.ok(await other.load(otherId, otherKey));
  store.close(); other.close();
});

test('the latest partial checkpoint is flushed without padding or duplicate samples', async () => {
  const { store } = fixture(); await store.begin(identity, key);
  store.append(new Int16Array([12000, 6000, -6000, -12000, 4000]).buffer);
  await store.flush(); await store.flush();
  const result = await store.load(identity, key), wav = Buffer.from(await result.blob.arrayBuffer());
  assert.equal(result.samples24k, 5); assert.equal(wav.length, 44 + 3 * 2);
  assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)], [12000, 0, -12000]);
  store.close();
});

test('draft keys and authenticated metadata expire without an old draft blocking a new take', async () => {
  let now = 1_800_000_000_000;
  const { store } = fixture({ now: () => now }); await store.begin(identity, key); store.append(pcm(12000)); await store.flush();
  now += 24 * 60 * 60 * 1000;
  await assert.rejects(store.load(identity, key), { code: 'DRAFT_EXPIRED' });
  await store.remove(identity); await store.begin({ ...identity, requestId: '30000000-0000-4000-8000-000000000002' }, otherKey);
  assert.equal(await store.load({ ...identity, requestId: '30000000-0000-4000-8000-000000000002' }, otherKey), null);
  store.close();
});

test('invalid keys, inputs and unavailable storage fail explicitly', async () => {
  const { store } = fixture();
  await assert.rejects(store.begin(identity, 'invalid'), { code: 'DRAFT_KEY' });
  await store.begin(identity, key);
  assert.throws(() => store.append(new Uint8Array(3)), { code: 'DRAFT_AUDIO' });
  assert.throws(() => store.append(new ArrayBuffer(48002)), { code: 'DRAFT_AUDIO' });
  const unavailable = createHostedDraftStore({ indexedDB: null, crypto: webcrypto, project });
  await assert.rejects(unavailable.begin(identity, key), { code: 'DRAFT_UNAVAILABLE' });
  store.close(); unavailable.close();
});

test('a stalled checkpoint writer bounds its plaintext queue and warns once', async () => {
  const warnings = [], { store } = fixture({ onWarning: error => warnings.push(error) });
  await store.begin(identity, key);
  for (let index = 0; index < 30; index++) store.append(pcm(24000));
  assert.throws(() => store.append(pcm(1)), { code: 'DRAFT_UNAVAILABLE' });
  assert.throws(() => store.append(pcm(1)), { code: 'DRAFT_UNAVAILABLE' });
  await assert.rejects(store.flush(), { code: 'DRAFT_UNAVAILABLE' });
  assert.equal(warnings.length, 1); store.close();
});

test('a full fifteen-minute encrypted draft restores exactly and refuses one sample beyond the limit', async () => {
  const { indexedDB, store } = fixture();
  await store.begin(identity, key);
  const frame = pcm(24000, -12345);
  for (let second = 0; second < 900; second++) {
    store.append(frame);
    // Drain like a working browser while keeping each queued burst below its bound.
    if (second % 20 === 19) await store.flush();
  }
  assert.deepEqual(await store.flush(), { samples24k: 21_600_000, durationSeconds: 900 });
  assert.throws(() => store.append(pcm(1)), { code: 'DRAFT_LIMIT' });
  store.close();
  const restored = fixture({ indexedDB }).store;
  try {
    const result = await restored.load(identity, key), wav = Buffer.from(await result.blob.arrayBuffer());
    assert.equal(result.samples24k, 21_600_000); assert.equal(result.durationSeconds, 900);
    assert.equal(wav.length, 44 + 900 * 32000);
    assert.equal(wav.readUInt32LE(40), 900 * 32000);
    assert.equal(wav.readInt16LE(44), -12345); assert.equal(wav.readInt16LE(wav.length - 2), -12345);
    assert.equal(await restored.remove(identity), true);
    assert.deepEqual(await rows(indexedDB), { drafts: [], blocks: [] });
  } finally { restored.close(); }
});
