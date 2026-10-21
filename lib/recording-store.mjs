const DEFAULT_DATABASE = 'neeley-dress-rehearsal-recordings';
const DATABASE_VERSION = 1;
const METADATA = 'metadata';
const AUDIO = 'audio';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class RecordingStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'RecordingStoreError'; this.code = code; }
}
const problem = (code, message) => new RecordingStoreError(code, message);
function storageError(cause) {
  if (cause instanceof RecordingStoreError) return cause;
  if (cause?.name === 'QuotaExceededError') return problem('RECORDING_STORAGE_QUOTA', 'Browser storage is full. Download this recording, then delete saved recordings you no longer need and try again.');
  if (['SecurityError', 'NotAllowedError', 'InvalidStateError', 'VersionError', 'NotFoundError'].includes(cause?.name)) return unavailable();
  return problem('RECORDING_STORAGE_FAILED', 'Recording storage could not finish. Try again, or download the recording to keep a copy.');
}
const unavailable = () => problem('RECORDING_STORAGE_UNAVAILABLE', 'Saved recordings are unavailable in this browser. Allow site storage or use a regular browser window. Download your current recording to keep it.');
const corrupt = () => problem('RECORDING_STORAGE_CORRUPT', 'This saved recording could not be read. Try reopening the app; other saved recordings have not been removed.');

function validId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw problem('RECORDING_ID', 'The recording could not be identified. Try recording or importing it again.');
  return id;
}
function validBlob(blob) {
  if (typeof Blob !== 'function' || !(blob instanceof Blob) || !blob.size || blob.size > MAX_AUDIO_BYTES || !/^audio\/[a-z0-9.+-]+(?:\s*;[\x20-\x7e]*)?$/i.test(blob.type) || blob.type.length > 128) {
    throw problem('RECORDING_AUDIO', 'Choose a nonempty audio recording of 20 MB or less.');
  }
  return blob;
}
function metadataFrom(value) {
  if (!value || typeof value !== 'object') throw corrupt();
  const id = validId(value.id);
  if (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0.5 || value.duration > 600.05) throw problem('RECORDING_DURATION', 'Saved recordings must be between half a second and 10 minutes.');
  if (typeof value.caption !== 'string' || value.caption.length > 255 || /[\u0000-\u001f\u007f]/.test(value.caption)) throw problem('RECORDING_CAPTION', 'Use a recording title of 255 characters or fewer without line breaks.');
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0 || !Number.isFinite(new Date(value.createdAt).getTime())) throw problem('RECORDING_DATE', 'The recording date could not be read. Try saving it again.');
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > MAX_AUDIO_BYTES || typeof value.type !== 'string' || !/^audio\//i.test(value.type) || value.type.length > 128) throw corrupt();
  // Explicit fields prevent API keys, transcripts, rubric text, or future UI
  // state accidentally entering storage or leaking back through a read.
  return { id, duration: value.duration, caption: value.caption, createdAt: value.createdAt, size: value.size, type: value.type };
}

export function createRecordingStore(options = {}) {
  let indexedDB, dbName = DEFAULT_DATABASE, accessError;
  try {
    indexedDB = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalThis.indexedDB;
    dbName = options.dbName ?? DEFAULT_DATABASE;
    if (!indexedDB || typeof indexedDB.open !== 'function' || typeof dbName !== 'string' || !dbName || dbName.length > 255) accessError = unavailable();
  } catch { accessError = unavailable(); }
  let database = null;
  let pending = null;

  function open() {
    if (accessError) return Promise.reject(accessError);
    if (database) return Promise.resolve(database);
    if (pending) return pending.promise;
    const attempt = { settled: false, timer: null, promise: null, reject: null };
    pending = attempt;
    attempt.promise = new Promise((resolve, reject) => {
      const fail = cause => {
        if (attempt.settled) return;
        attempt.settled = true;
        clearTimeout(attempt.timer);
        if (pending === attempt) pending = null;
        reject(storageError(cause));
      };
      attempt.reject = fail;
      let request;
      try { request = indexedDB.open(dbName, DATABASE_VERSION); }
      catch (cause) { fail(cause); return; }
      attempt.timer = setTimeout(() => fail(unavailable()), 10_000);
      request.onblocked = () => fail(problem('RECORDING_STORAGE_BLOCKED', 'Another Dress Rehearsal tab is blocking saved recordings. Close the other tabs and try again, or download this recording.'));
      request.onerror = () => fail(request.error);
      request.onupgradeneeded = () => {
        if (attempt.settled) { try { request.transaction.abort(); } catch {} return; }
        try {
          const connection = request.result;
          if (!connection.objectStoreNames.contains(METADATA)) connection.createObjectStore(METADATA, { keyPath: 'id' });
          if (!connection.objectStoreNames.contains(AUDIO)) connection.createObjectStore(AUDIO, { keyPath: 'id' });
        } catch (cause) {
          try { request.transaction.abort(); } catch {}
          fail(cause);
        }
      };
      request.onsuccess = () => {
        const connection = request.result;
        // Blocked opens cannot be cancelled. If one later succeeds, release its
        // connection instead of leaking it or replacing a newer connection.
        if (attempt.settled) { connection.close(); return; }
        if (!connection.objectStoreNames.contains(METADATA) || !connection.objectStoreNames.contains(AUDIO)) {
          connection.close(); fail(unavailable()); return;
        }
        attempt.settled = true;
        clearTimeout(attempt.timer);
        if (pending === attempt) pending = null;
        database = connection;
        connection.onversionchange = () => { connection.close(); if (database === connection) database = null; };
        connection.onclose = () => { if (database === connection) database = null; };
        resolve(connection);
      };
    });
    return attempt.promise;
  }

  async function transaction(stores, mode, execute) {
    const connection = await open();
    return new Promise((resolve, reject) => {
      let tx, result, failure;
      try { tx = connection.transaction(stores, mode); }
      catch (cause) { if (database === connection) database = null; reject(storageError(cause)); return; }
      const abort = cause => {
        failure ||= cause;
        try { tx.abort(); } catch { reject(storageError(failure)); }
      };
      const request = (operation, success = () => {}) => {
        operation.onerror = () => abort(operation.error);
        operation.onsuccess = () => { try { success(operation.result); } catch (cause) { abort(cause); } };
        return operation;
      };
      tx.onerror = event => { failure ||= event.target?.error || tx.error; };
      tx.onabort = () => reject(storageError(failure || tx.error));
      // A successful individual request does not establish a committed save.
      tx.oncomplete = () => failure ? reject(storageError(failure)) : resolve(result);
      try { execute(tx, request, value => { result = value; }); }
      catch (cause) { abort(cause); }
    });
  }

  return {
    async save(value) {
      const blob = validBlob(value?.blob);
      const metadata = metadataFrom({ id: value.id, duration: value.duration, caption: value.caption, createdAt: value.createdAt, size: blob.size, type: blob.type });
      return transaction([METADATA, AUDIO], 'readwrite', (tx, request, result) => {
        request(tx.objectStore(METADATA).put(metadata));
        request(tx.objectStore(AUDIO).put({ id: metadata.id, blob }));
        result(metadata);
      });
    },
    async list() {
      return transaction([METADATA], 'readonly', (tx, request, result) => {
        request(tx.objectStore(METADATA).getAll(), rows => {
          const metadata = rows.map(metadataFrom);
          metadata.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
          result(metadata);
        });
      });
    },
    async get(id) {
      validId(id);
      return transaction([METADATA, AUDIO], 'readonly', (tx, request, result) => {
        let metadata, audio, finished = 0;
        const complete = () => {
          if (++finished < 2) return;
          if (!metadata && !audio) { result(null); return; }
          if (!metadata || !audio) throw corrupt();
          const entry = metadataFrom(metadata);
          const blob = validBlob(audio.blob);
          if (entry.id !== id || audio.id !== id || blob.size !== entry.size || blob.type !== entry.type) throw corrupt();
          result({ ...entry, blob });
        };
        request(tx.objectStore(METADATA).get(id), value => { metadata = value; complete(); });
        request(tx.objectStore(AUDIO).get(id), value => { audio = value; complete(); });
      });
    },
    async remove(id) {
      validId(id);
      return transaction([METADATA, AUDIO], 'readwrite', (tx, request, result) => {
        request(tx.objectStore(METADATA).delete(id));
        request(tx.objectStore(AUDIO).delete(id));
        result(true);
      });
    },
    close() {
      const connection = database;
      database = null;
      try { connection?.close(); } catch {}
      pending?.reject(problem('RECORDING_STORAGE_CLOSED', 'Recording storage was closed. Try again, or download the recording to keep a copy.'));
    },
  };
}
