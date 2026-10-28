import { MAX_RECORDING_SECONDS } from './recording-limits.mjs';

const VERSION = 1, META = 'drafts', BLOCKS = 'blocks';
const RATE = 24_000, BLOCK_SAMPLES = RATE / 2, MAX_SAMPLES = RATE * MAX_RECORDING_SECONDS, MAX_PENDING_BYTES = RATE * 2 * 30;
const MAX_AGE = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure = (code, message) => Object.assign(new Error(message), { code });
const corrupt = () => failure('DRAFT_CORRUPT', 'The interrupted recording could not be verified. It has not been restored.');
const unavailable = () => failure('DRAFT_UNAVAILABLE', 'Refresh recovery could not save this recording in your browser. Keep this page open until you stop and save.');
const bytesOf = value => value instanceof ArrayBuffer ? new Uint8Array(value)
  : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;

function canonicalWav(bytes) {
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), samples = bytes.byteLength / 2;
  const length = Math.round(samples * 16_000 / RATE), buffer = new ArrayBuffer(44 + length * 2), wav = new DataView(buffer);
  const label = (offset, value) => { for (let i = 0; i < value.length; i++) wav.setUint8(offset + i, value.charCodeAt(i)); };
  label(0, 'RIFF'); wav.setUint32(4, buffer.byteLength - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
  wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
  wav.setUint32(24, 16_000, true); wav.setUint32(28, 32_000, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
  label(36, 'data'); wav.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const first = Math.floor(i * 1.5), end = Math.min(samples, Math.max(first + 1, Math.floor((i + 1) * 1.5)));
    let sum = 0;
    for (let j = first; j < end; j++) sum += input.getInt16(j * 2, true);
    wav.setInt16(44 + i * 2, sum / (end - first), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Encrypted, owner-bound checkpoints. The decryption key is never persisted. */
export function createHostedDraftStore({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto,
  dbName = 'neeley-encrypted-live-drafts', project, now = Date.now, onWarning } = {}) {
  let projectId;
  try {
    const url = new URL(project);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    projectId = url.href.replace(/\/$/, '');
  } catch { throw failure('DRAFT_PROJECT', 'Provide the verified recording service for refresh recovery.'); }
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
  let database, opening, writer, closed = false;
  function identity(value) {
    if (!value || ![value.ownerId, value.recordingId, value.requestId].every(item => typeof item === 'string' && UUID.test(item))) {
      throw failure('DRAFT_IDENTITY', 'The interrupted recording owner could not be verified.');
    }
    return { ownerId: value.ownerId, recordingId: value.recordingId, requestId: value.requestId };
  }
  const ownerKey = ownerId => JSON.stringify([projectId, ownerId]);
  const same = (row, id) => row?.project === projectId && row.ownerId === id.ownerId && row.recordingId === id.recordingId && row.requestId === id.requestId;
  const aad = (id, kind, ...details) => encoder.encode(JSON.stringify(['neeley-live-draft', VERSION, projectId, id.ownerId, id.recordingId, id.requestId, kind, ...details]));
  function warn(error, own = writer) {
    if (own && !own.error) {
      own.error = error instanceof Error ? error : unavailable();
      try { onWarning?.(own.error); } catch { /* Reporting cannot expose or invalidate a previous checkpoint. */ }
    }
    return own?.error || error;
  }
  function open() {
    if (closed || !indexedDB?.open || !crypto?.subtle || !crypto?.getRandomValues) return Promise.reject(unavailable());
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      let settled = false, request;
      const finish = (error, result) => {
        if (settled) { result?.close(); return; }
        settled = true; clearTimeout(timer);
        if (error) reject(error); else { database = result; resolve(result); }
      };
      const timer = setTimeout(() => finish(unavailable()), 10_000);
      try { request = indexedDB.open(dbName, VERSION); } catch { finish(unavailable()); return; }
      request.onerror = () => finish(unavailable()); request.onblocked = () => finish(unavailable());
      request.onupgradeneeded = () => {
        if (settled || closed) { request.transaction.abort(); return; }
        const db = request.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(BLOCKS)) {
          const blocks = db.createObjectStore(BLOCKS, { keyPath: ['ownerKey', 'sequence'] });
          blocks.createIndex('owner', 'ownerKey', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (closed) { db.close(); finish(unavailable()); return; }
        db.onversionchange = () => { db.close(); if (database === db) database = null; };
        db.onclose = () => { if (database === db) database = null; };
        finish(null, db);
      };
    }).finally(() => { opening = null; });
    return opening;
  }
  async function transaction(mode, execute) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let tx, value, cause, settled = false;
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => { cause = unavailable(); try { tx?.abort(); } catch { finish(cause); } }, 10_000);
      try { tx = db.transaction([META, BLOCKS], mode); } catch { finish(unavailable()); return; }
      const abort = error => { cause ||= error; try { tx.abort(); } catch { finish(cause); } };
      const request = (operation, success = () => {}) => {
        operation.onerror = () => abort(operation.error?.name === 'QuotaExceededError'
          ? failure('DRAFT_QUOTA', 'Your browser storage is full. Keep this page open until this recording is saved.') : unavailable());
        operation.onsuccess = () => { try { success(operation.result); } catch (error) { abort(error); } };
      };
      tx.onabort = () => finish(cause || unavailable()); tx.onerror = () => { cause ||= unavailable(); };
      tx.oncomplete = () => finish(cause);
      try { execute(tx, request, result => { value = result; }); } catch (error) { abort(error); }
    });
  }
  async function importKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}=?$/.test(value)) throw failure('DRAFT_KEY', 'The refresh recovery key is invalid.');
    let bytes;
    try {
      bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
      if (bytes.length !== 32 || !crypto?.subtle) throw new Error();
      return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    } catch { throw failure('DRAFT_KEY', 'The refresh recovery key is invalid.'); }
    finally { bytes?.fill(0); }
  }
  async function encrypt(key, data, additionalData) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return { iv, ciphertext: await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, data) };
  }
  async function decrypt(key, value, additionalData, expectedBytes) {
    const iv = bytesOf(value?.iv), ciphertext = bytesOf(value?.ciphertext);
    if (iv?.length !== 12 || !ciphertext || ciphertext.length !== expectedBytes + 16) throw corrupt();
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData, tagLength: 128 }, key, ciphertext)); }
    catch { throw corrupt(); }
  }
  function manifestData(id, sequence, samples, createdAt) {
    return encoder.encode(JSON.stringify({ version: VERSION, project: projectId, ...id, sequence, samples, createdAt }));
  }
  async function signedManifest(own, sequence, samples) {
    const data = manifestData(own.id, sequence, samples, own.createdAt);
    return { ...(await encrypt(own.key, data, aad(own.id, 'manifest'))), size: data.length };
  }
  function discardBlocks(tx, request, key) {
    request(tx.objectStore(BLOCKS).index('owner').openKeyCursor(key), cursor => {
      if (!cursor) return;
      tx.objectStore(BLOCKS).delete(cursor.primaryKey); cursor.continue();
    });
  }
  async function begin(value, keyValue) {
    const id = identity(value);
    if (writer && !writer.stopped) {
      if (same({ project: projectId, ...writer.id }, id) && !writer.error) return;
      throw failure('DRAFT_ACTIVE', 'Save or recover the current recording before starting another.');
    }
    const key = await importKey(keyValue), createdAt = now();
    const own = { id, key, createdAt, ownerKey: ownerKey(id.ownerId), chain: Promise.resolve(), buffer: new Uint8Array(BLOCK_SAMPLES * 2),
      buffered: 0, received: 0, queuedSamples: 0, sequence: 0, pendingBytes: 0, stopped: false, error: null };
    const manifest = await signedManifest(own, 0, 0);
    await transaction('readwrite', (tx, request) => {
      request(tx.objectStore(META).get(own.ownerKey), row => {
        if (row && Number.isFinite(row.createdAt) && now() - row.createdAt < MAX_AGE) {
          throw failure('DRAFT_ACTIVE', 'Recover the interrupted recording before starting another.');
        }
        discardBlocks(tx, request, own.ownerKey);
        request(tx.objectStore(META).put({ key: own.ownerKey, project: projectId, ...id, version: VERSION,
          sequence: 0, samples: 0, createdAt, updatedAt: createdAt, manifest }));
      });
    });
    if (closed) throw unavailable();
    writer = own;
  }
  function queueBlock(own, bytes) {
    if (own.sequence >= 10_000) throw warn(failure('DRAFT_LIMIT', 'This recovery recording has too many checkpoints.'), own);
    const sequence = own.sequence++, offset = own.queuedSamples, samples = bytes.length / 2;
    own.queuedSamples += samples; own.pendingBytes += bytes.length;
    own.chain = own.chain.then(async () => {
      if (own.error || own.stopped) return;
      const encrypted = await encrypt(own.key, bytes, aad(own.id, 'block', sequence, offset, samples));
      bytes.fill(0);
      const manifest = await signedManifest(own, sequence + 1, offset + samples);
      if (own.stopped) return;
      await transaction('readwrite', (tx, request) => {
        request(tx.objectStore(META).get(own.ownerKey), row => {
          if (own.stopped || !same(row, own.id) || row.sequence !== sequence || row.samples !== offset || row.createdAt !== own.createdAt) throw corrupt();
          request(tx.objectStore(BLOCKS).add({ ownerKey: own.ownerKey, sequence, offset, samples, ...encrypted }));
          request(tx.objectStore(META).put({ ...row, sequence: sequence + 1, samples: offset + samples, updatedAt: now(), manifest }));
        });
      });
    }).catch(error => { warn(error, own); }).finally(() => { bytes.fill(0); own.pendingBytes -= bytes.length; });
  }
  function append(value) {
    const own = writer, bytes = bytesOf(value);
    if (!own || own.stopped || closed) throw unavailable();
    if (own.error) throw own.error;
    if (!bytes || !bytes.length || bytes.length % 2 || bytes.length > RATE * 2) throw failure('DRAFT_AUDIO', 'Provide a small mono PCM16 audio frame for refresh recovery.');
    if (own.received + bytes.length / 2 > MAX_SAMPLES) throw failure('DRAFT_LIMIT', 'Refresh recovery accepts at most fifteen minutes of audio.');
    if (own.pendingBytes + own.buffered + bytes.length > MAX_PENDING_BYTES) throw warn(unavailable(), own);
    own.received += bytes.length / 2;
    let offset = 0;
    while (offset < bytes.length) {
      const count = Math.min(own.buffer.length - own.buffered, bytes.length - offset);
      own.buffer.set(bytes.subarray(offset, offset + count), own.buffered); own.buffered += count; offset += count;
      if (own.buffered === own.buffer.length) {
        queueBlock(own, own.buffer); own.buffer = new Uint8Array(BLOCK_SAMPLES * 2); own.buffered = 0;
      }
    }
    return bytes.length / 2;
  }
  async function flush() {
    const own = writer;
    if (!own || own.stopped || closed) throw unavailable();
    if (own.error) throw own.error;
    if (own.buffered) {
      queueBlock(own, own.buffer.slice(0, own.buffered)); own.buffer.fill(0); own.buffered = 0;
    }
    await own.chain;
    if (own.error) throw own.error;
    return { samples24k: own.queuedSamples, durationSeconds: own.queuedSamples / RATE };
  }
  async function load(value, keyValue) {
    const id = identity(value), key = await importKey(keyValue), keyId = ownerKey(id.ownerId);
    const snapshot = await transaction('readonly', (tx, request, result) => {
      request(tx.objectStore(META).get(keyId), row => {
        if (!same(row, id)) { result(null); return; }
        request(tx.objectStore(BLOCKS).index('owner').getAll(keyId), blocks => result({ row, blocks }));
      });
    });
    if (!snapshot) return null;
    const { row, blocks } = snapshot;
    if (row.version !== VERSION || !Number.isSafeInteger(row.sequence) || row.sequence < 0 || row.sequence > 10_000 ||
        !Number.isSafeInteger(row.samples) || row.samples < 0 || row.samples > MAX_SAMPLES || !Number.isFinite(row.createdAt) ||
        !Number.isSafeInteger(row.manifest?.size) || row.manifest.size < 1 || row.manifest.size > 4096 || blocks.length !== row.sequence) throw corrupt();
    const signed = await decrypt(key, row.manifest, aad(id, 'manifest'), row.manifest.size);
    const expected = manifestData(id, row.sequence, row.samples, row.createdAt);
    if (decoder.decode(signed) !== decoder.decode(expected)) throw corrupt();
    if (now() - row.createdAt >= MAX_AGE || row.createdAt > now() + 60_000) throw failure('DRAFT_EXPIRED', 'This interrupted recording is too old to restore.');
    if (row.samples === 0) return null;
    const audio = new Uint8Array(row.samples * 2);
    let offset = 0;
    blocks.sort((a, b) => a.sequence - b.sequence);
    for (let sequence = 0; sequence < blocks.length; sequence++) {
      const block = blocks[sequence];
      if (block.ownerKey !== keyId || block.sequence !== sequence || block.offset !== offset || !Number.isSafeInteger(block.samples) ||
          block.samples < 1 || block.samples > BLOCK_SAMPLES || offset + block.samples > row.samples) throw corrupt();
      const plaintext = await decrypt(key, block, aad(id, 'block', sequence, offset, block.samples), block.samples * 2);
      audio.set(plaintext, offset * 2); plaintext.fill(0); offset += block.samples;
    }
    if (offset !== row.samples) throw corrupt();
    const blob = canonicalWav(audio); audio.fill(0);
    return { blob, durationSeconds: Math.round(row.samples * 16_000 / RATE) / 16_000, samples24k: row.samples,
      checkpointedAt: row.updatedAt, recordingId: id.recordingId, requestId: id.requestId };
  }
  async function remove(value) {
    const id = identity(value), key = ownerKey(id.ownerId);
    if (writer && same({ project: projectId, ...writer.id }, id)) {
      const own = writer; own.stopped = true; own.buffer.fill(0); await own.chain;
      if (writer === own) writer = null;
    }
    return transaction('readwrite', (tx, request, result) => {
      request(tx.objectStore(META).get(key), row => {
        if (!same(row, id)) { result(false); return; }
        request(tx.objectStore(META).delete(key)); discardBlocks(tx, request, key); result(true);
      });
    });
  }
  async function clearOwner(ownerId) {
    if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw failure('DRAFT_IDENTITY', 'The recording owner could not be verified.');
    if (writer?.id.ownerId === ownerId) {
      const own = writer; own.stopped = true; own.buffer.fill(0); await own.chain;
      if (writer === own) writer = null;
    }
    const key = ownerKey(ownerId);
    return transaction('readwrite', (tx, request, result) => {
      request(tx.objectStore(META).delete(key)); discardBlocks(tx, request, key); result(true);
    });
  }
  function close() {
    closed = true;
    if (writer) { writer.stopped = true; writer.buffer.fill(0); writer = null; }
    database?.close(); database = null;
  }
  return { begin, append, flush, load, remove, clearOwner, close };
}
