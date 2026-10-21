import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createLiveTranscription } from '../lib/live-transcription.mjs';

function inspectWav(wav) {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1, 'audio must be uncompressed PCM');
  assert.equal(wav.readUInt16LE(22), 1, 'audio must be mono');
  assert.equal(wav.readUInt32LE(24), 16000, 'audio must be 16 kHz');
  assert.equal(wav.readUInt16LE(34), 16, 'audio must use 16-bit samples');
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  return { durationSeconds: wav.readUInt32LE(40) / wav.readUInt32LE(28) };
}

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const appHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const htmlIds = [...appHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const meterMarkup = appHtml.match(/id="input-level"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/)?.[1] || '';
const meterBarCount = [...meterMarkup.matchAll(/<span\b/g)].length;
const listenerStart = appSource.indexOf("$('settings-open').addEventListener");
assert.ok(listenerStart > 0, 'browser app must expose its declarations before wiring DOM events');
const declarations = appSource.slice(0, listenerStart);

class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.children = []; this.options = [];
    this.style = {}; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
    this.hidden = false; this.disabled = false; this.open = false; this.checked = false;
    this.currentTime = 0; this.duration = NaN; this.paused = true; this.ended = false;
    this.scrollTop = 0; this.clientHeight = 300; this.offsetTop = 0; this.offsetHeight = 20;
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => classes.add(value)),
      remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value),
      toggle: (value, force) => {
        const add = force ?? !classes.has(value);
        if (add) classes.add(value); else classes.delete(value);
        return add;
      },
    };
  }
  get textContent() { return this._textContent || ''; }
  set textContent(value) {
    if (this.ownerDocument && this.children?.some(child => child === this.ownerDocument.activeElement || child.contains?.(this.ownerDocument.activeElement))) this.ownerDocument.activeElement = this.ownerDocument.body;
    this._textContent = String(value); this.children = []; this.options = [];
  }
  get disabled() { return this._disabled || false; }
  set disabled(value) {
    this._disabled = Boolean(value);
    if (this._disabled && this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  contains(element) { return this === element || this.children.some(child => child === element || child.contains?.(element)); }
  append(...children) { this.children.push(...children); this.options.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.textContent = ''; this.children = []; this.options = []; this.append(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  addEventListener(name, handler) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(handler); this.listeners.set(name, listeners);
  }
  querySelectorAll(selector) {
    if (selector !== 'button') return this.children;
    return this.children.flatMap(child => [...(child.tagName === 'BUTTON' ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector() { return this.children[0] ?? null; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 600, bottom: 300 }; }
  focus() {
    this.focusCalls = (this.focusCalls || 0) + 1;
    if (this.disabled) this.disabledFocusCalls = (this.disabledFocusCalls || 0) + 1;
    else if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  click() { this.clicked = true; return Promise.all((this.listeners.get('click') || []).map(handler => handler({ type: 'click', target: this, preventDefault() {} }))); }
  select() {}
  scrollIntoView() {}
  scrollTo({ top }) { this.scrollTop = top; }
  load() { this.currentTime = 0; }
  pause() { this.paused = true; }
  async play() { this.paused = false; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(value) { return value; }

function harness(requestImpl = async () => { throw new Error('Unexpected browser-service request'); }, { startup = false, extractRubric = async () => { throw new Error('Unexpected document extraction'); }, mediaDevices = {}, permissions, recordings = {}, decodeAudioData } = {}) {
  const elements = new Map();
  const missingIds = [];
  let ownerDocument;
  const get = id => {
    if (!elements.has(id)) {
      const element = Object.assign(new Element(), { ownerDocument });
      if (id === 'input-level') element.append(...Array.from({ length: meterBarCount }, () => new Element()));
      if (id === 'saved-recordings-details') element.append(Object.assign(new Element(), { tagName: 'SUMMARY', ownerDocument }));
      elements.set(id, element);
    }
    return elements.get(id);
  };
  const track = { stop() {}, onended: null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const graphNode = () => ({ connect() {}, disconnect() {} });
  class AudioContext {
    constructor() { this.sampleRate = 16000; this.state = 'running'; this.destination = {}; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    async decodeAudioData(bytes) { if (!decodeAudioData) throw new Error('Unexpected audio decoding'); return decodeAudioData(bytes); }
    createMediaStreamSource() { return graphNode(); }
    createScriptProcessor() { return graphNode(); }
    createAnalyser() { return { ...graphNode(), fftSize: 256, getByteTimeDomainData: values => values.fill(128) }; }
    createGain() { return { ...graphNode(), gain: { value: 0 } }; }
  }
  let blobCounter = 0;
  let progressHandler = () => {};
  const revoked = [];
  const objectUrls = new Map(), createdElements = [], timers = [];
  const savedRecords = new Map(), storageCalls = { save: [], get: [], remove: [], list: 0 };
  const recordingStore = {
    async save(record) { storageCalls.save.push({ ...record }); savedRecords.set(record.id, { ...record }); },
    async list() { storageCalls.list++; return [...savedRecords.values()].map(({ blob, ...metadata }) => metadata); },
    async get(id) { storageCalls.get.push(id); return savedRecords.get(id) || null; },
    async remove(id) { storageCalls.remove.push(id); savedRecords.delete(id); },
    ...recordings,
  };
  const mediaEvents = new Element(), windowEvents = new Element(), documentEvents = new Element();
  const context = {
    document: {
      getElementById: id => {
        if (startup && !htmlIds.includes(id)) { missingIds.push(id); return null; }
        return get(id);
      },
      createElement: tag => { const element = Object.assign(new Element(), { tagName: tag.toUpperCase(), ownerDocument }); createdElements.push(element); return element; },
      createDocumentFragment: () => new Element(),
      createTextNode: text => Object.assign(new Element(), { textContent: text }),
      querySelector: selector => get(selector),
      querySelectorAll: () => [],
      addEventListener: (...args) => documentEvents.addEventListener(...args),
      body: new Element(),
    },
    navigator: {
      mediaDevices: { async getUserMedia() { return stream; }, async enumerateDevices() { return []; }, addEventListener: (...args) => mediaEvents.addEventListener(...args), ...mediaDevices },
      permissions,
    },
    window: {
      AudioContext, matchMedia: () => ({ matches: false }), addEventListener: (...args) => windowEvents.addEventListener(...args),
      rehearsalService: { request: requestImpl, setProgressHandler(handler) { progressHandler = handler; } },
      rehearsalDocuments: { extractRubric },
      rehearsalRecordings: recordingStore,
    },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    Blob, Uint8Array, Float32Array, ArrayBuffer, DataView, Math, Date, AbortController, DOMException,
    URL: {
      createObjectURL: blob => { const url = `blob:rehearsal-${++blobCounter}`; objectUrls.set(url, blob); return url; },
      revokeObjectURL: value => revoked.push(value),
    },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setInterval: () => 1, clearInterval() {},
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    console,
  };
  ownerDocument = context.document;
  ownerDocument.body.ownerDocument = ownerDocument;
  ownerDocument.activeElement = ownerDocument.body;
  vm.createContext(context);
  vm.runInContext(`${startup ? appSource : declarations}
globalThis.audioTest = {
  state, updateConfig, saveSettings, enableMic, enumerateInputs, openInputSelector, cleanupMic, initializeInputDetection, meterLoop, resetMeter,
  startRecording, stopRecording, captureRecordingSamples, toggleRecordingPause, uploadAudio, cancelLiveSession,
  wordIndexAtTime, seekPlayback, ensureTranscript, setAudio, discardAudio, renderFollowTranscript,
  runAnalysis, renderReport, annotationSegments, buildAnnotatedDocument, renderAnnotatedTranscript,
  analysisInput, updateTargetHint, setTargetView, loadPromptPreview, importRubric, removeRubric, setBusy,
  autosaveRecording, refreshSavedRecordings, openSavedRecording, deleteSavedRecording,
  downloadCurrentAudio, downloadSavedRecording, warnBeforeLeaving
};`, context);
  const emit = async (target, type, event = {}) => Promise.all((target.listeners.get(type) || []).map(handler => handler({ type, ...event })));
  return { ...context.audioTest, get, revoked, missingIds, document: context.document, navigator: context.navigator, window: context.window,
    objectUrls, createdElements, storageCalls, savedRecords, recordingStore, flushTimers: () => { while (timers.length) timers.shift()(); },
    emitMediaEvent: (type, event) => emit(mediaEvents, type, event),
    emitWindowEvent: (type, event) => emit(windowEvents, type, event),
    emitDocumentEvent: (type, event) => emit(documentEvents, type, event),
    emitProgress: message => progressHandler(message) };
}

function microphone(label) {
  const track = { label, readyState: 'live', stopped: 0, onended: null, stop() { this.stopped++; this.readyState = 'ended'; } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
const inputDevice = (deviceId, label = '') => ({ kind: 'audioinput', deviceId, label });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const elementText = element => String(element.textContent || '') + element.children.map(elementText).join('');
const settleAudioSaves = async h => { await Promise.all([...h.state.pendingAudioSaves]); await nextTurn(); };
const savedTake = (id, caption = id) => ({ id, blob: new Blob([`audio-${id}`], { type: 'audio/wav' }), duration: 4, caption, createdAt: 1_760_000_000_000 });
const clickedDownloads = h => h.createdElements.filter(element => element.tagName === 'A' && element.clicked);
const libraryAction = (h, caption, action) => h.get('saved-recordings-list').querySelectorAll('button').find(button => button.getAttribute('aria-label')?.startsWith(`${action} ${caption},`));
function liveSpeech(h, recognize) {
  const sessions = [];
  h.window.rehearsalLiveSpeech = { startSession(options) {
    const calls = [];
    const session = createLiveTranscription({ sampleRate: options.sampleRate, onUpdate: options.onUpdate,
      transcribe: async (samples, metadata) => { calls.push({ samples, metadata }); return recognize(samples, metadata, sessions.length - 1); },
    });
    sessions.push({ session, options, calls });
    return session;
  } };
  return sessions;
}

test('completed takes autosave only audio metadata once, and short takes are not saved', async () => {
  const h = harness();
  await h.enableMic(); await h.startRecording();
  h.get('analysis-api-key').value = 'secret-api-key';
  h.get('transcript').value = 'Private transcript';
  h.get('target-script').value = 'Private script';
  h.get('target-talking-points').value = 'Private points';
  h.get('planned-introduction').value = 'Private introduction';
  h.get('instructor-rubric').value = 'Private rubric';
  h.captureRecordingSamples(new Float32Array(16000).fill(0.25), 16000);
  h.toggleRecordingPause();
  h.captureRecordingSamples(new Float32Array(32000).fill(0.9), 16000);
  h.stopRecording(); h.stopRecording();
  await settleAudioSaves(h);
  assert.equal(h.storageCalls.save.length, 1);
  const stored = h.storageCalls.save[0];
  assert.deepEqual(Object.keys(stored).sort(), ['blob', 'caption', 'createdAt', 'duration', 'id']);
  assert.equal(stored.blob, h.state.audioBlob);
  assert.equal(stored.duration, 1);
  assert.equal(inspectWav(Buffer.from(await stored.blob.arrayBuffer())).durationSeconds, 1);
  assert.ok(Number.isFinite(stored.createdAt));
  assert.doesNotMatch(JSON.stringify(stored), /Private|secret-api-key/);
  assert.equal(h.state.audioSave.status, 'saved');
  await h.startRecording();
  h.captureRecordingSamples(new Float32Array(4000), 16000);
  h.stopRecording(); await settleAudioSaves(h);
  assert.equal(h.storageCalls.save.length, 1, 'a take below half a second cannot become a saved recording');
});

test('uploaded audio saves the prepared mono WAV rather than the original file', async () => {
  const h = harness(undefined, { decodeAudioData: async () => ({
    duration: 1, sampleRate: 16000, length: 16000, numberOfChannels: 2,
    getChannelData: index => new Float32Array(16000).fill(index ? 0.5 : 0.25),
  }) });
  const original = { name: 'Practice.m4a', size: 12, async arrayBuffer() { return new ArrayBuffer(12); } };
  await h.uploadAudio(original); await settleAudioSaves(h);
  assert.equal(h.storageCalls.save.length, 1);
  const record = h.storageCalls.save[0];
  assert.equal(record.caption, 'Practice.m4a');
  assert.equal(record.duration, 1);
  assert.equal(record.blob.type, 'audio/wav');
  assert.equal(inspectWav(Buffer.from(await record.blob.arrayBuffer())).durationSeconds, 1);
  assert.equal(record.blob, h.state.audioBlob);
});

test('an older pending save survives replacement without changing the newer take status', async () => {
  const first = deferred(), second = deferred(), saved = [];
  const h = harness(undefined, { recordings: { save(record) { saved.push(record); return saved.length === 1 ? first.promise : second.promise; }, async list() { return []; } } });
  const old = savedTake('old'), current = savedTake('current');
  h.setAudio(old.blob, old.duration, old.caption);
  const previousRecord = h.state.audioSave;
  assert.equal(h.state.pendingAudioSaves.size, 1);
  h.setAudio(current.blob, current.duration, current.caption);
  const currentRecord = h.state.audioSave;
  assert.match(elementText(h.get('audio-save-status')), /Saving in this browser/);
  first.resolve(); await nextTurn();
  assert.equal(saved[0].blob, old.blob);
  assert.equal(previousRecord.status, 'saved');
  assert.equal(h.state.audioSave, currentRecord);
  assert.equal(currentRecord.status, 'saving');
  assert.equal(h.state.audioBlob, current.blob);
  assert.match(elementText(h.get('audio-save-status')), /Saving in this browser/);
  second.resolve(); await settleAudioSaves(h);
  assert.equal(currentRecord.status, 'saved');
  assert.equal(h.state.pendingAudioSaves.size, 0);
});

test('clearing playback during a pending save unloads audio without deleting its saved copy', async () => {
  const pending = deferred(); let saved;
  const h = harness(undefined, { recordings: { save(record) { saved = record; return pending.promise; } } });
  const take = savedTake('cleared');
  h.setAudio(take.blob, take.duration, take.caption);
  h.discardAudio();
  assert.equal(h.state.audioBlob, null);
  assert.equal(h.state.audioSave, null);
  assert.equal(h.state.pendingAudioSaves.size, 1);
  assert.deepEqual(h.storageCalls.remove, []);
  pending.resolve(); await settleAudioSaves(h);
  assert.equal(saved.blob, take.blob);
  assert.equal(h.state.audioBlob, null);
  assert.equal(h.state.audioSave, null);
  assert.deepEqual(h.storageCalls.remove, []);
  assert.equal(elementText(h.get('audio-save-status')), '');
});

test('saved metadata loads on startup without restoring audio or accessing a saved blob', async () => {
  const take = savedTake('existing'); let gets = 0, saves = 0;
  const { blob, ...metadata } = take;
  const h = harness(async () => response({ analysisConfigured: false }), { startup: true, recordings: {
    async list() { return [metadata]; }, async get() { gets++; return take; }, async save() { saves++; },
  } });
  await nextTurn();
  assert.equal(h.state.savedRecordings.length, 1);
  assert.equal(h.get('saved-recordings-count').textContent, '1');
  assert.equal(h.state.audioBlob, null);
  assert.equal(h.state.report, null);
  assert.equal(gets, 0); assert.equal(saves, 0);
  assert.deepEqual(h.missingIds, []);
});

test('opening a saved recording clears stale transcript and feedback without saving a duplicate', async () => {
  const take = savedTake('saved', 'Saved rehearsal');
  const h = harness(undefined, { recordings: { async get(id) { assert.equal(id, take.id); return take; } } });
  h.setAudio(new Blob(['prior'], { type: 'audio/wav' }), 2, 'Prior take');
  await settleAudioSaves(h);
  h.state.transcriptText = 'Old recognized text'; h.get('transcript').value = 'Old recognized text';
  h.state.report = { transcript: 'Old recognized text' };
  const count = h.storageCalls.save.length;
  await h.openSavedRecording(take.id);
  assert.equal(h.state.audioBlob, take.blob);
  assert.equal(h.state.audioDuration, take.duration);
  assert.equal(h.state.audioSave.id, take.id);
  assert.equal(h.state.audioSave.status, 'saved');
  assert.equal(h.state.transcriptText, ''); assert.equal(h.get('transcript').value, '');
  assert.equal(h.state.report, null);
  assert.equal(h.storageCalls.save.length, count);
  assert.equal(h.state.libraryBusy, false);
});

test('a late saved-recording open cannot replace a newer take or a cleared player', async () => {
  for (const clear of [false, true]) {
    const pending = deferred();
    const h = harness(undefined, { recordings: { get() { return pending.promise; } } });
    const loading = h.openSavedRecording('old');
    const fresh = savedTake('fresh');
    if (clear) h.discardAudio(); else h.setAudio(fresh.blob, fresh.duration, fresh.caption);
    pending.resolve(savedTake('old')); await loading; await settleAudioSaves(h);
    assert.equal(h.state.audioBlob, clear ? null : fresh.blob);
    assert.equal(h.state.libraryBusy, false);
    assert.equal(h.storageCalls.save.length, clear ? 0 : 1);
  }
});

test('an out-of-order saved-list refresh cannot resurrect stale metadata', async () => {
  const old = deferred(), fresh = deferred(); let calls = 0;
  const h = harness(undefined, { recordings: { list() { return ++calls === 1 ? old.promise : fresh.promise; } } });
  const previous = h.refreshSavedRecordings(), latest = h.refreshSavedRecordings();
  fresh.resolve([{ ...savedTake('new'), blob: undefined }]); await latest;
  old.resolve([{ ...savedTake('deleted'), blob: undefined }]); await previous;
  assert.equal(h.state.savedRecordings.length, 1);
  assert.equal(h.state.savedRecordings[0].id, 'new');
  assert.doesNotMatch(elementText(h.get('saved-recordings-list')), /deleted/);
});

test('returning to the app preserves the same saved-recording action without taking focus from other fields', async () => {
  const h = harness(async () => response({ analysisConfigured: false }), { startup: true });
  await nextTurn();
  h.savedRecords.set('first', savedTake('first', 'First take'));
  h.savedRecords.set('second', savedTake('second', 'Second take'));
  h.get('saved-recordings-details').open = true;
  await h.refreshSavedRecordings();
  const previous = libraryAction(h, 'Second take', 'Download');
  previous.focus();
  await h.emitWindowEvent('focus'); await nextTurn();
  assert.notEqual(h.document.activeElement, previous, 'a refresh renders new controls');
  assert.equal(h.document.activeElement, libraryAction(h, 'Second take', 'Download'));
  h.get('target-script').focus();
  await h.emitWindowEvent('focus'); await nextTurn();
  assert.equal(h.document.activeElement, h.get('target-script'), 'background list refresh must not move focus into the library');
});

test('deleting a focused take waits for enabled controls and focuses the next take, previous take, or disclosure', async () => {
  const removed = deferred();
  const h = harness(undefined, { recordings: { async remove(id) { await removed.promise; h.savedRecords.delete(id); } } });
  for (const caption of ['First', 'Middle', 'Last']) h.savedRecords.set(caption, savedTake(caption, caption));
  h.get('saved-recordings-details').open = true;
  await h.refreshSavedRecordings();
  libraryAction(h, 'Middle', 'Delete').focus();
  const deletion = h.deleteSavedRecording('Middle');
  assert.equal(h.document.activeElement, h.document.body);
  assert.ok(h.get('saved-recordings-list').querySelectorAll('button').every(button => button.disabled));
  await h.refreshSavedRecordings();
  assert.equal(h.document.activeElement, h.document.body, 'no disabled row control should receive focus during deletion');
  removed.resolve(); await deletion;
  assert.equal(h.document.activeElement, libraryAction(h, 'Last', 'Open'));
  libraryAction(h, 'Last', 'Delete').focus(); await h.deleteSavedRecording('Last');
  assert.equal(h.document.activeElement, libraryAction(h, 'First', 'Open'));
  libraryAction(h, 'First', 'Delete').focus(); await h.deleteSavedRecording('First');
  assert.equal(h.document.activeElement, h.get('saved-recordings-details').querySelector('summary'));
  assert.ok(h.createdElements.every(element => !element.disabledFocusCalls), 'restoration must never attempt to focus a disabled action');
});

test('finishing deletion does not steal focus when the user moves outside the saved library', async () => {
  const removed = deferred();
  const h = harness(undefined, { recordings: { async remove(id) { await removed.promise; h.savedRecords.delete(id); } } });
  h.savedRecords.set('first', savedTake('first', 'First'));
  h.savedRecords.set('next', savedTake('next', 'Next'));
  h.get('saved-recordings-details').open = true;
  await h.refreshSavedRecordings();
  libraryAction(h, 'First', 'Delete').focus();
  const deletion = h.deleteSavedRecording('first');
  h.get('target-talking-points').focus();
  removed.resolve(); await deletion;
  assert.equal(h.document.activeElement, h.get('target-talking-points'));
});

test('unsaved-take warnings survive window refocus and clear after a successful retry', async () => {
  let fail = true;
  const h = harness(async () => response({ analysisConfigured: false }), {
    startup: true,
    recordings: { async save(record) { if (fail) throw new Error('Storage is full'); h.savedRecords.set(record.id, record); } },
  });
  await nextTurn();
  const take = savedTake('failed');
  h.setAudio(take.blob, take.duration, take.caption); await settleAudioSaves(h);
  await h.emitWindowEvent('focus'); await nextTurn();
  assert.match(h.get('saved-recordings-status').textContent, /1 recording is not saved.*Download unsaved takes/);
  assert.equal(h.get('saved-recordings-status').classList.contains('error'), true);
  assert.doesNotMatch(h.get('saved-recordings-status').textContent, /save here automatically/);
  fail = false;
  await h.autosaveRecording(h.state.audioSave); await settleAudioSaves(h);
  assert.equal(h.state.unsavedRecordings.size, 0);
  assert.match(h.get('saved-recordings-status').textContent, /^Saved only in this browser/);
  assert.equal(h.get('saved-recordings-status').classList.contains('error'), false);
});

test('deleting an open saved copy preserves playback and downloading while removing only that entry', async () => {
  const h = harness();
  const take = savedTake('delete-current');
  h.setAudio(take.blob, take.duration, take.caption); await settleAudioSaves(h);
  const id = h.state.audioSave.id, url = h.state.audioURL;
  await h.deleteSavedRecording(id);
  assert.deepEqual(h.storageCalls.remove, [id]);
  assert.equal(h.state.audioBlob, take.blob);
  assert.equal(h.state.audioURL, url);
  assert.equal(h.state.audioSave.status, 'removed');
  assert.equal(h.state.savedRecordings.length, 0);
  assert.equal(h.get('download-audio').disabled, false);
  h.downloadCurrentAudio();
  const [download] = clickedDownloads(h);
  assert.equal(h.objectUrls.get(download.href), take.blob);
  assert.ok(!h.revoked.includes(url), 'deleting stored metadata must not revoke open playback');
  h.flushTimers();
  assert.ok(h.revoked.includes(download.href));
});

test('failed older saves remain downloadable after replacement and can be reopened and retried', async () => {
  const pending = deferred(); let saves = 0;
  const h = harness(undefined, { recordings: { save() { return ++saves === 1 ? pending.promise : Promise.resolve(); } } });
  const old = savedTake('old-failed', 'Old/unsafe:take.mp3'), fresh = savedTake('fresh');
  h.setAudio(old.blob, old.duration, old.caption);
  const oldRecord = h.state.audioSave;
  h.setAudio(fresh.blob, fresh.duration, fresh.caption);
  pending.reject(new Error('Browser storage is full.')); await settleAudioSaves(h);
  assert.equal(h.state.audioBlob, fresh.blob);
  assert.equal(h.state.audioSave.status, 'saved');
  assert.equal(h.state.unsavedRecordings.get(oldRecord.id).blob, old.blob);
  assert.match(elementText(h.get('saved-recordings-list')), /Not saved; download to keep/);
  await h.downloadSavedRecording(oldRecord.id);
  const [download] = clickedDownloads(h);
  assert.equal(h.objectUrls.get(download.href), old.blob);
  assert.equal(download.download, 'Old-unsafe-take.wav');
  assert.deepEqual(h.storageCalls.get, [], 'failed local audio must not be fetched from IndexedDB');
  await h.openSavedRecording(oldRecord.id);
  assert.equal(h.state.audioBlob, old.blob);
  assert.equal(h.state.audioSave.status, 'failed');
  assert.match(elementText(h.get('audio-save-status')), /Not saved in this browser.*storage is full/);
  await h.autosaveRecording(h.state.audioSave); await settleAudioSaves(h);
  assert.equal(saves, 3);
  assert.equal(h.state.audioSave.status, 'saved');
  assert.equal(h.state.unsavedRecordings.size, 0);
});

test('deleting an unsaved failed take removes only its in-memory recovery entry', async () => {
  const h = harness(undefined, { recordings: { async save() { throw new Error('Storage unavailable'); } } });
  const take = savedTake('unsaved');
  h.setAudio(take.blob, take.duration, take.caption); await settleAudioSaves(h);
  assert.equal(h.state.audioSave.status, 'failed');
  const id = h.state.audioSave.id;
  await h.deleteSavedRecording(id);
  assert.equal(h.state.unsavedRecordings.size, 0);
  assert.deepEqual(h.storageCalls.remove, []);
  assert.equal(h.state.audioBlob, take.blob);
  assert.equal(h.state.audioSave.status, 'removed');
});

test('leaving warns for active, pending or failed recordings without tearing down the microphone', async () => {
  const pending = deferred();
  const h = harness(async () => response({ analysisConfigured: false }), { startup: true, recordings: { save() { return pending.promise; } } });
  await nextTurn(); await h.enableMic(); await h.startRecording();
  const stream = h.state.stream;
  let prevented = 0;
  const event = () => ({ preventDefault() { prevented++; } });
  await h.emitWindowEvent('beforeunload', event());
  assert.equal(prevented, 1); assert.equal(h.state.stream, stream); assert.equal(h.state.recording, true);
  h.captureRecordingSamples(new Float32Array(16000), 16000); h.stopRecording();
  const waiting = event(); h.warnBeforeLeaving(waiting);
  assert.equal(waiting.returnValue, ''); assert.equal(prevented, 2);
  pending.reject(new Error('Quota exceeded')); await settleAudioSaves(h);
  const failed = event(); h.warnBeforeLeaving(failed);
  assert.equal(failed.returnValue, ''); assert.equal(prevented, 3);
  assert.equal(h.state.stream, stream);
  await h.deleteSavedRecording(h.state.audioSave.id);
  const safe = event(); h.warnBeforeLeaving(safe);
  assert.equal(safe.returnValue, undefined); assert.equal(prevented, 3);
});

test('microphone discovery on startup and focus never requests permission or starts recording', async () => {
  let requested = 0, listed = 0, permissionListener;
  const h = harness(async () => response({ analysisConfigured: false }), {
    startup: true,
    mediaDevices: {
      async getUserMedia() { requested++; throw new Error('Page load must not activate a microphone'); },
      async enumerateDevices() { listed++; return [inputDevice('default')]; },
    },
    permissions: { async query({ name }) { assert.equal(name, 'microphone'); return { state: 'prompt', addEventListener(type, listener) { assert.equal(type, 'change'); permissionListener = listener; } }; } },
  });
  await nextTurn();
  assert.ok(listed >= 1);
  assert.equal(requested, 0);
  assert.equal(h.state.stream, null);
  assert.equal(h.state.recording, false);
  assert.equal(h.get('audio-input').options[0].label, 'Detect microphones…');
  const previous = listed;
  await h.emitWindowEvent('focus');
  await permissionListener();
  assert.ok(listed >= previous + 2);
  assert.equal(requested, 0);
  assert.deepEqual(h.missingIds, [], 'removed controls such as record-description must not be accessed');
});

test('device enumeration labels the actual system default and removes duplicate aliases', async () => {
  const h = harness(undefined, { mediaDevices: { async enumerateDevices() { return [
    inputDevice('default', 'Default - USB Microphone'), inputDevice('communications', 'Communications - USB Microphone'),
    inputDevice('usb', 'USB Microphone'), inputDevice('usb', 'Duplicate USB'), inputDevice('built-in', 'Laptop microphone'),
    { kind: 'audiooutput', deviceId: 'speaker', label: 'Speaker' },
  ]; } } });
  await h.enumerateInputs();
  assert.deepEqual(h.get('audio-input').options.map(option => [option.value, option.label]), [
    ['', 'System default · USB Microphone'], ['usb', 'USB Microphone'], ['built-in', 'Laptop microphone'],
  ]);
  assert.equal(h.get('audio-input').value, '');
  assert.equal(h.state.inputsNamed, true);
});

test('the first dropdown gesture enables microphone names once without recording', async () => {
  const pending = deferred();
  const stream = microphone('USB Microphone');
  let calls = 0, prevented = 0;
  const h = harness(undefined, { mediaDevices: {
    getUserMedia(options) { calls++; assert.equal(options.video, false); assert.equal(options.audio.deviceId, undefined); return pending.promise; },
    async enumerateDevices() { return [inputDevice('default', stream.track.label), inputDevice('usb', stream.track.label)]; },
  } });
  await h.openInputSelector({ type: 'keydown', key: 'Tab', preventDefault() { throw new Error('Tab must remain navigation'); } });
  assert.equal(calls, 0);
  const first = h.openInputSelector({ type: 'pointerdown', preventDefault() { prevented++; } });
  await h.openInputSelector({ type: 'keydown', key: 'ArrowDown', preventDefault() { prevented++; } });
  assert.equal(calls, 1);
  assert.equal(prevented, 1);
  pending.resolve(stream); await first;
  assert.equal(h.state.stream, stream);
  assert.equal(h.state.inputsNamed, true);
  assert.equal(h.state.recording, false);
  assert.equal(h.state.sampleCount, 0);
  assert.match(h.get('mic-status').textContent, /USB Microphone/);
  await h.openInputSelector({ type: 'pointerdown', preventDefault() { throw new Error('Named list should open normally'); } });
  assert.equal(calls, 1);
});

test('a denied microphone detection recovers on a later permitted gesture', async () => {
  const stream = microphone('Recovered microphone');
  let calls = 0;
  const h = harness(undefined, { mediaDevices: {
    async getUserMedia() { if (++calls === 1) throw Object.assign(new Error('Denied'), { name: 'NotAllowedError' }); return stream; },
    async enumerateDevices() { return [inputDevice('default', stream.track.label)]; },
  } });
  const gesture = { type: 'keydown', key: 'Enter', preventDefault() {} };
  await h.openInputSelector(gesture);
  assert.equal(h.state.stream, null);
  assert.equal(h.state.requestingMic, false);
  assert.equal(h.get('audio-input').disabled, false);
  assert.match(h.get('app-status').textContent, /permission was blocked/);
  await h.openInputSelector(gesture);
  assert.equal(calls, 2);
  assert.equal(h.state.stream, stream);
  assert.equal(h.state.recording, false);
  assert.equal(h.get('app-status').hidden, true, 'a successful retry clears the previous permission error');
});

test('switching to an exact microphone retains its selection through refreshes and preserves it on failure', async () => {
  const streams = { laptop: microphone('Laptop microphone'), usb: microphone('USB microphone') };
  const requested = [];
  const h = harness(undefined, { mediaDevices: {
    async getUserMedia(options) {
      const id = options.audio.deviceId?.exact; requested.push(id);
      if (id === 'unavailable') throw Object.assign(new Error('Unavailable'), { name: 'NotReadableError' });
      return streams[id];
    },
    async enumerateDevices() { return [inputDevice('default', 'Default - Laptop microphone'), inputDevice('laptop', 'Laptop microphone'), inputDevice('usb', 'USB microphone')]; },
  } });
  assert.equal(await h.enableMic('laptop'), true);
  assert.equal(await h.enableMic('usb'), true);
  await h.enumerateInputs();
  assert.equal(h.state.inputDevice, 'usb');
  assert.equal(h.get('audio-input').value, 'usb');
  assert.equal(h.state.stream, streams.usb);
  assert.equal(streams.laptop.track.stopped, 1);
  assert.equal(streams.usb.track.stopped, 0);
  assert.equal(await h.enableMic('unavailable'), false);
  assert.equal(h.state.stream, streams.usb);
  assert.equal(h.get('audio-input').value, 'usb');
  assert.equal(streams.usb.track.stopped, 0);
  assert.deepEqual(requested, ['laptop', 'usb', 'unavailable']);
});

test('late device enumeration cannot overwrite a newer hotplug result', async () => {
  const old = deferred(), fresh = deferred();
  let listed = 0;
  const h = harness(undefined, { mediaDevices: { enumerateDevices() { return ++listed === 1 ? old.promise : fresh.promise; } } });
  const beforePermission = h.enumerateInputs();
  const afterHotplug = h.enumerateInputs();
  fresh.resolve([inputDevice('default', 'Default - USB microphone'), inputDevice('usb', 'USB microphone')]);
  await afterHotplug;
  old.resolve([inputDevice('default')]);
  await beforePermission;
  assert.equal(h.state.inputsNamed, true);
  assert.deepEqual(h.get('audio-input').options.map(option => option.value), ['', 'usb']);
  assert.match(h.get('audio-input').options[0].label, /USB microphone/);
});

test('a hotplug refresh cannot switch an active recording when its device is briefly absent', async () => {
  const stream = microphone('USB microphone');
  let devices = [inputDevice('usb', stream.track.label)], requested = 0;
  const h = harness(async () => response({ analysisConfigured: false }), { startup: true, mediaDevices: {
    async getUserMedia() { requested++; return stream; },
    async enumerateDevices() { return devices; },
  } });
  await nextTurn();
  await h.enableMic('usb'); await h.startRecording();
  h.captureRecordingSamples(new Float32Array(16000).fill(0.1), 16000);
  devices = [inputDevice('default', 'Default - Laptop microphone'), inputDevice('laptop', 'Laptop microphone')];
  await h.emitMediaEvent('devicechange');
  assert.equal(requested, 1);
  assert.equal(h.state.stream, stream);
  assert.equal(h.state.inputDevice, 'usb');
  assert.equal(h.get('audio-input').value, 'usb');
  assert.equal(h.state.recording, true);
  assert.equal(h.state.sampleCount, 16000);
  assert.equal(stream.track.stopped, 0);
  stream.track.readyState = 'ended';
  stream.track.onended();
  await nextTurn();
  assert.equal(h.state.recording, false);
  assert.equal(h.state.stream, null);
  assert.equal(h.state.audioDuration, 1);
  assert.equal(requested, 1, 'a disconnected recording must not silently continue on another input');
});

test('all 32 meter bars reflect their actual audio samples and reset after microphone cleanup', () => {
  const h = harness();
  const bars = h.get('input-level').children;
  assert.equal(bars.length, 32);
  const samples = new Uint8Array(256).fill(128);
  h.state.analyser = { fftSize: samples.length, getByteTimeDomainData: values => values.set(samples), disconnect() {} };
  h.meterLoop();
  assert.ok(bars.every(bar => bar.style.height === '3px'));
  assert.equal(h.get('.input-meter').getAttribute('aria-valuenow'), '0');
  samples.fill(192, 0, 8);
  samples.fill(144, 8, 16);
  h.meterLoop();
  const loud = parseFloat(bars[0].style.height), quiet = parseFloat(bars[1].style.height);
  assert.ok(loud > quiet && quiet > 3, 'different measured amplitudes must produce different heights');
  assert.ok(bars.slice(2).every(bar => bar.style.height === '3px'), 'silent samples must not generate decorative movement');
  assert.ok(Number(h.get('.input-meter').getAttribute('aria-valuenow')) > 0);
  h.cleanupMic();
  assert.ok(bars.every(bar => bar.style.height === '3px'));
  assert.equal(h.get('.input-meter').getAttribute('aria-valuenow'), '0');
  assert.equal(h.state.meterFrame, null);
});

test('pending recording startup locks controls and duplicate starts cannot reset captured speech', async () => {
  const h = harness();
  await h.enableMic();
  const resume = deferred(); let resumeCalls = 0;
  h.state.context.resume = () => { resumeCalls++; return resume.promise; };
  const starting = h.startRecording();
  assert.equal(h.state.startingRecording, true);
  for (const id of ['record-button', 'enable-mic', 'audio-input', 'upload-button', 'discard-audio', 'analyze-button']) {
    assert.equal(h.get(id).disabled, true, `${id} must wait for microphone startup`);
  }
  await h.startRecording();
  assert.equal(resumeCalls, 1, 'a second start cannot enter the pending audio operation');
  resume.resolve(); await starting;
  assert.equal(h.state.startingRecording, false);
  assert.equal(h.state.recording, true);
  assert.equal(h.get('record-button').disabled, false, 'Stop must become available');
  h.captureRecordingSamples(new Float32Array(16000).fill(0.4), 16000);
  const generation = h.state.audioGeneration;
  await h.startRecording();
  assert.equal(h.state.sampleCount, 16000);
  assert.equal(h.state.audioGeneration, generation);
  h.stopRecording(); await settleAudioSaves(h);
  assert.equal(h.state.audioDuration, 1);
  assert.equal(h.storageCalls.save.length, 1);
});

test('microphone removal during pending startup preserves the previous take and allows a fresh start', async () => {
  const h = harness();
  const previous = new Blob(['previous take'], { type: 'audio/wav' });
  h.setAudio(previous, 4, 'Previous');
  await h.enableMic();
  const resume = deferred();
  h.state.context.resume = () => resume.promise;
  const starting = h.startRecording();
  h.cleanupMic();
  resume.resolve(); await starting;
  assert.equal(h.state.recording, false);
  assert.equal(h.state.startingRecording, false);
  assert.equal(h.state.context, null);
  assert.equal(h.state.audioBlob, previous, 'a failed start must not discard the existing recording');
  for (const id of ['record-button', 'enable-mic', 'audio-input', 'upload-button']) assert.equal(h.get(id).disabled, false);
  await h.startRecording();
  assert.equal(h.state.recording, true);
  h.stopRecording();
});

test('a failed audio-context resume releases the start lock without losing saved playback', async () => {
  const h = harness();
  const previous = new Blob(['previous take'], { type: 'audio/wav' });
  h.setAudio(previous, 4, 'Previous');
  await h.enableMic();
  h.state.context.resume = async () => { throw new Error('Audio device unavailable'); };
  await assert.rejects(h.startRecording(), /Audio device unavailable/);
  assert.equal(h.state.recording, false);
  assert.equal(h.state.startingRecording, false);
  assert.equal(h.state.audioBlob, previous);
  assert.equal(h.get('record-button').disabled, false);
  h.state.context.resume = async () => {};
  await h.startRecording();
  assert.equal(h.state.recording, true);
  h.stopRecording();
});

test('recording pause excludes captured microphone frames from the saved WAV and duration', async () => {
  const h = harness();
  await h.enableMic();
  await h.startRecording();
  const capture = value => h.state.processor.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array(16000).fill(value) },
  });
  capture(0.25);
  h.toggleRecordingPause();
  capture(0.9);
  capture(0.9);
  assert.equal(h.state.sampleCount, 16000);
  h.toggleRecordingPause();
  capture(-0.25);
  h.stopRecording();
  const wav = Buffer.from(await h.state.audioBlob.arrayBuffer());
  assert.equal(inspectWav(wav).durationSeconds, 2);
  assert.equal(h.state.audioDuration, 2);
  assert.equal(wav.readInt16LE(44), 8191);
  assert.equal(wav.readInt16LE(44 + 16000 * 2), -8192);
  assert.equal(h.state.recording, false);
  assert.equal(h.state.recordingPaused, false);
});

test('stopping during a pause saves the previous speech and recording limits exclude paused time', async () => {
  const h = harness();
  await h.enableMic();
  await h.startRecording();
  h.state.config.maxDurationSeconds = 2;
  h.captureRecordingSamples(new Float32Array(16000), 16000);
  h.toggleRecordingPause();
  h.captureRecordingSamples(new Float32Array(16000 * 5), 16000);
  assert.equal(h.state.recording, true, 'paused samples cannot trigger the maximum-duration stop');
  h.stopRecording();
  assert.equal(h.state.audioDuration, 1);
  assert.equal(inspectWav(Buffer.from(await h.state.audioBlob.arrayBuffer())).durationSeconds, 1);
  h.toggleRecordingPause();
  assert.equal(h.state.recordingPaused, false, 'pause has no effect after the take ends');
});

test('recording caps saved audio at the maximum when the final input block crosses the limit', async () => {
  const h = harness();
  await h.enableMic();
  await h.startRecording();
  h.state.config.maxDurationSeconds = 2;
  h.captureRecordingSamples(new Float32Array(16000 * 3), 16000);
  assert.equal(h.state.recording, false);
  assert.equal(h.state.audioDuration, 2);
  assert.equal(inspectWav(Buffer.from(await h.state.audioBlob.arrayBuffer())).durationSeconds, 2);
});

test('live batches leave capture uninterrupted, save immediately on stop, and reuse only the completed transcript for coaching', async () => {
  const first = deferred(), last = deferred(), requests = [];
  const h = harness(async (url, options) => {
    requests.push({ url, input: JSON.parse(options.body) });
    assert.equal(url, '/api/analyze-text', 'the completed live transcript must avoid whole-take inference');
    return { transcript: requests.at(-1).input.text, wordStats: {}, blunders: {}, analysis: {} };
  });
  const sessions = liveSpeech(h, (_samples, metadata) => metadata.index ? last.promise : first.promise);
  await h.startRecording();
  sessions[0].options.onProgress('Downloading English speech model: 42%');
  assert.match(h.get('follow-transcript-status').textContent, /Downloading.*42%/);
  h.captureRecordingSamples(new Float32Array(16000 * 8).fill(0.25), 16000);
  await nextTurn();
  assert.equal(sessions[0].calls.length, 1);
  assert.equal(h.state.sampleCount, 128000);
  assert.equal(requests.length, 0, 'capture cannot make an AI request');
  first.resolve({ text: 'Practice helps.' }); await nextTurn();
  assert.equal(h.get('follow-transcript').textContent, 'Practice helps.');
  h.get('follow-transcript').scrollTop = 17;
  h.captureRecordingSamples(new Float32Array(16000 * 2).fill(-0.25), 16000);
  assert.equal(h.get('follow-transcript').scrollTop, 17, 'unchanged text must not reset the reader while new audio arrives');
  h.toggleRecordingPause();
  h.captureRecordingSamples(new Float32Array(16000 * 3), 16000);
  assert.equal(h.state.sampleCount, 160000, 'paused samples enter neither the saved audio nor live queue');
  assert.match(h.get('follow-transcript-status').textContent, /^Paused/);
  h.stopRecording();
  assert.equal(h.state.recording, false);
  assert.equal(h.storageCalls.save.length, 1, 'saving starts without waiting for recognition');
  assert.equal(inspectWav(Buffer.from(await h.state.audioBlob.arrayBuffer())).durationSeconds, 10);
  assert.equal(h.state.transcriptText, '', 'the visible draft is not a complete cached transcript');
  assert.equal(h.get('analyze-button').disabled, true);
  assert.match(h.get('follow-transcript-status').textContent, /^Finishing/);
  await h.runAnalysis(); assert.equal(requests.length, 0);
  const replayTranscript = h.ensureTranscript();
  h.get('target-talking-points').value = 'Latest preparation after recording';
  last.resolve({ text: 'Practice helps. Everyone benefits.' });
  assert.equal(await replayTranscript, 'Practice helps. Everyone benefits.');
  assert.equal(h.state.transcriptModel, h.state.config.transcriptionModel);
  assert.equal(h.get('analyze-button').disabled, false);
  await h.runAnalysis();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input.text, 'Practice helps. Everyone benefits.');
  assert.equal(requests[0].input.targetTalkingPoints, 'Latest preparation after recording');
  assert.equal(sessions[0].calls[1].samples.length, 16000 * 4, 'the final remainder carries two seconds of overlap, not paused audio');
});

test('canceling live transcription keeps recording and requires a complete retry instead of analyzing a partial draft', async () => {
  const requests = [];
  const h = harness(async (url, options) => {
    if (url === '/api/config') return {};
    requests.push(url);
    if (url === '/api/transcribe') return { text: 'Complete recording transcript.', durationSeconds: 9 };
    const input = JSON.parse(options.body);
    assert.equal(input.text, 'Complete recording transcript.');
    return { transcript: input.text, wordStats: {}, blunders: {}, analysis: {} };
  }, { startup: true });
  const sessions = liveSpeech(h, async () => ({ text: 'Partial draft.' }));
  await h.startRecording();
  h.captureRecordingSamples(new Float32Array(16000 * 8), 16000); await nextTurn();
  assert.equal(h.get('follow-transcript').textContent, 'Partial draft.');
  await h.get('live-transcription-cancel').click();
  assert.equal(h.state.recording, true);
  assert.equal(sessions[0].session.getState().cancelled, true);
  h.captureRecordingSamples(new Float32Array(16000), 16000);
  h.stopRecording();
  assert.equal(h.state.audioDuration, 9);
  assert.equal(h.state.transcriptText, '');
  assert.equal(h.get('follow-transcript-connect').hidden, false);
  await h.runAnalysis();
  assert.deepEqual(requests, ['/api/transcribe', '/api/analyze-text']);
});

test('a failed live batch preserves audio and late results cannot replace a new take or its transcript', async () => {
  const recognition = deferred();
  const h = harness();
  const sessions = liveSpeech(h, () => recognition.promise);
  await h.startRecording();
  h.captureRecordingSamples(new Float32Array(16000 * 8), 16000); await nextTurn();
  h.stopRecording(); const finishing = h.state.livePromise.catch(() => 'cancelled');
  await h.startRecording();
  assert.equal(sessions[0].session.getState().cancelled, true);
  recognition.resolve({ text: 'Old take must stay gone.' }); await finishing; await nextTurn();
  assert.equal(h.state.recording, true);
  assert.equal(h.state.transcriptText, '');
  assert.doesNotMatch(h.get('follow-transcript').textContent, /Old take/);
  h.captureRecordingSamples(new Float32Array(16000), 16000);
  h.stopRecording(); await h.state.livePromise;
  const saved = h.state.audioBlob;
  await h.startRecording();
  const failed = new Error('Model unavailable');
  sessions[2].options.onUpdate({ error: failed });
  assert.equal(h.state.recording, true);
  h.captureRecordingSamples(new Float32Array(16000), 16000); h.stopRecording();
  assert.notEqual(h.state.audioBlob, saved);
  assert.equal(h.state.audioDuration, 1);
  assert.equal(h.state.transcriptText, '');
  assert.match(h.get('follow-transcript-status').textContent, /Model unavailable/);
});

test('changing models, clearing, and very short takes cancel live work without accepting partial text', async () => {
  const h = harness();
  const sessions = liveSpeech(h, async () => ({ text: 'Draft words.' }));
  await h.startRecording();
  h.captureRecordingSamples(new Float32Array(16000), 16000);
  h.updateConfig({ transcriptionModel: 'onnx-community/whisper-small.en' });
  assert.equal(sessions[0].session.getState().cancelled, true);
  assert.equal(h.state.recording, true);
  h.stopRecording();
  assert.equal(h.state.audioDuration, 1);
  assert.equal(h.state.transcriptText, '');
  assert.match(h.get('follow-transcript-status').textContent, /model changed/);
  await h.startRecording(); h.captureRecordingSamples(new Float32Array(4000), 16000); h.stopRecording();
  assert.equal(sessions[1].session.getState().cancelled, true);
  assert.equal(h.state.audioBlob, null);
  await h.startRecording(); h.captureRecordingSamples(new Float32Array(16000), 16000); h.stopRecording();
  const finishing = h.state.livePromise.catch(() => 'cancelled');
  h.discardAudio(); await finishing;
  assert.equal(sessions[2].session.getState().cancelled, true);
  assert.equal(h.state.audioBlob, null);
  assert.equal(h.get('follow-transcript-panel').hidden, true);
});

test('uploading a replacement cancels pending live work before decoding and preserves old audio if decoding fails', async () => {
  const recognition = deferred(), decode = deferred();
  const h = harness(undefined, { decodeAudioData: () => decode.promise });
  const sessions = liveSpeech(h, () => recognition.promise);
  await h.startRecording(); h.captureRecordingSamples(new Float32Array(16000 * 8), 16000); await nextTurn(); h.stopRecording();
  const oldAudio = h.state.audioBlob;
  const finishing = h.state.livePromise.catch(() => 'cancelled');
  const upload = h.uploadAudio({ name: 'Broken.wav', size: 10, arrayBuffer: async () => new ArrayBuffer(10) });
  assert.equal(sessions[0].session.getState().cancelled, true);
  decode.reject(new Error('Invalid audio')); await upload; await finishing;
  recognition.resolve({ text: 'Stale old draft.' }); await nextTurn();
  assert.equal(h.state.audioBlob, oldAudio);
  assert.equal(h.state.transcriptText, '');
  assert.equal(h.get('follow-transcript-connect').hidden, false);
});

test('estimated transcript position handles empty text and boundaries without invalid word indices', () => {
  const { wordIndexAtTime } = harness();
  assert.equal(wordIndexAtTime(1, 0, 10), -1);
  assert.equal(wordIndexAtTime(1, 10, 0), -1);
  assert.equal(wordIndexAtTime(1, NaN, 10), -1);
  assert.equal(wordIndexAtTime(-3, 10, 10), 0);
  assert.equal(wordIndexAtTime(0, 10, 10), 0);
  assert.equal(wordIndexAtTime(4.5, 10, 10), 4);
  assert.equal(wordIndexAtTime(10, 10, 10), 9);
  assert.equal(wordIndexAtTime(1000, 10, 10), 9);
});

test('seeking clamps to the saved audio and updates the corresponding transcript word', () => {
  const h = harness();
  h.setAudio(new Blob(['audio']), 10, 'Test take');
  h.renderFollowTranscript('One two three four five six seven eight nine ten.');
  assert.equal(h.seekPlayback(4.5), 4.5);
  assert.equal(h.get('playback').currentTime, 4.5);
  assert.equal(h.state.activeWordIndex, 4);
  assert.equal(h.seekPlayback(-4), 0);
  assert.equal(h.state.activeWordIndex, 0);
  assert.equal(h.seekPlayback(999), 10);
  assert.equal(h.state.activeWordIndex, 9);
});

test('concurrent replay transcription requests share one local service operation and cache the transcript', async () => {
  const pending = deferred();
  const calls = [];
  const h = harness(async (url, init) => {
    calls.push({ url, init });
    return pending.promise;
  });
  h.state.config.speechConfigured = true;
  const blob = new Blob(['first recording']);
  h.setAudio(blob, 10, 'Test take');
  const first = h.ensureTranscript();
  const second = h.ensureTranscript();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/transcribe');
  assert.equal(calls[0].init.body, blob);
  pending.resolve(response({ text: 'Hello from the rehearsal.', durationSeconds: 10 }));
  const results = await Promise.all([first, second]);
  assert.equal(results[0], 'Hello from the rehearsal.');
  assert.equal(results[1], results[0]);
  assert.equal(await h.ensureTranscript(), results[0]);
  assert.equal(calls.length, 1);
});

test('changing speech models rebuilds the transcript while preserving audio and its browser save', async () => {
  let recognitions = 0;
  const h = harness(async path => {
    assert.equal(path, '/api/transcribe');
    return { text: ++recognitions === 1 ? 'Base recognized these words.' : 'Small recognized different words.', durationSeconds: 4 };
  });
  const audio = new Blob(['recording'], { type: 'audio/wav' });
  h.setAudio(audio, 4, 'Original'); await settleAudioSaves(h);
  const saved = h.state.audioSave, url = h.state.audioURL;
  await h.ensureTranscript();
  h.state.report = { transcript: h.state.transcriptText };
  h.seekPlayback(2);
  h.updateConfig({ transcriptionModel: 'onnx-community/whisper-small.en' });
  assert.equal(h.state.audioBlob, audio);
  assert.equal(h.state.audioURL, url);
  assert.equal(h.state.audioSave, saved);
  assert.equal(h.get('playback').currentTime, 2);
  assert.equal(h.state.transcriptText, '');
  assert.equal(h.get('transcript').value, '');
  assert.equal(h.state.report, null);
  assert.equal(h.get('follow-transcript-connect').hidden, false);
  assert.equal(await h.ensureTranscript(), 'Small recognized different words.');
  assert.equal(recognitions, 2);
  h.updateConfig({ analysisProvider: 'google', analysisConfigured: true });
  assert.equal(await h.ensureTranscript(), 'Small recognized different words.');
  assert.equal(recognitions, 2, 'changing the coach must preserve the same speech-model transcript');
  assert.equal(h.storageCalls.save.length, 1, 'a model change must not create another saved recording');
  assert.ok(!h.revoked.includes(url));
});

test('changing a speech model aborts old recognition and ignores its late result', async () => {
  const requests = [];
  const h = harness((url, init) => {
    const pending = deferred(); requests.push({ url, init, pending }); return pending.promise;
  });
  const audio = new Blob(['recording'], { type: 'audio/wav' });
  h.setAudio(audio, 4, 'Original');
  const old = h.ensureTranscript();
  const rejected = assert.rejects(old, { name: 'AbortError' });
  h.updateConfig({ transcriptionModel: 'onnx-community/whisper-small.en' });
  assert.equal(requests[0].init.signal.aborted, true);
  const current = h.ensureTranscript();
  requests[0].pending.resolve({ text: 'Stale Base result.', durationSeconds: 999 });
  await rejected;
  assert.equal(h.state.transcriptText, '');
  assert.equal(h.state.audioDuration, 4);
  assert.ok(h.state.transcriptPromise, 'the old result cannot clear the new model request');
  requests[1].pending.resolve({ text: 'Current Small result.', durationSeconds: 4 });
  assert.equal(await current, 'Current Small result.');
  assert.equal(h.state.transcriptModel, 'onnx-community/whisper-small.en');
});

test('changing a speech model aborts dependent coaching and restores controls without accepting its late report', async () => {
  const coaching = deferred(); let coachingSignal;
  const h = harness(async (path, options) => {
    if (path === '/api/transcribe') return { text: 'My name is Jordan. Practice helps.', durationSeconds: 4 };
    assert.equal(path, '/api/analyze-text'); coachingSignal = options.signal; return coaching.promise;
  });
  h.setAudio(new Blob(['audio'], { type: 'audio/wav' }), 4, 'Original');
  await h.ensureTranscript();
  const analyzing = h.runAnalysis(); await nextTurn();
  assert.equal(h.state.busy, true);
  h.updateConfig({ transcriptionModel: 'onnx-community/whisper-small.en' });
  assert.equal(coachingSignal.aborted, true);
  assert.equal(h.state.busy, false);
  assert.equal(h.get('analyze-button').disabled, false);
  assert.equal(h.get('cancel-analysis').hidden, true);
  coaching.resolve({ transcript: 'Stale coaching transcript.', wordStats: {}, blunders: {}, analysis: {} });
  await analyzing;
  assert.equal(h.state.report, null);
  assert.equal(h.state.transcriptText, '');
});

test('audio preparation hides unsupported cancellation and releases controls on decode failure', async () => {
  const decoded = deferred();
  const h = harness(undefined, { decodeAudioData: () => decoded.promise });
  const previous = new Blob(['previous'], { type: 'audio/wav' });
  h.setAudio(previous, 4, 'Previous');
  const upload = h.uploadAudio({ name: 'replacement.wav', size: 12, arrayBuffer: async () => new ArrayBuffer(12) });
  await nextTurn();
  assert.equal(h.state.preparingAudio, true);
  assert.equal(h.state.busy, true);
  assert.equal(h.get('cancel-analysis').hidden, true, 'the app must not offer a cancel action that cannot stop decoding');
  h.updateConfig({ transcriptionModel: 'onnx-community/whisper-small.en' });
  assert.equal(h.state.busy, true, 'changing models must not unlock a separate audio preparation operation');
  decoded.reject(Object.assign(new Error('Invalid media'), { name: 'EncodingError' }));
  await upload;
  assert.equal(h.state.audioBlob, previous);
  assert.equal(h.state.preparingAudio, false);
  assert.equal(h.state.busy, false);
  assert.equal(h.get('record-button').disabled, false);
  assert.equal(h.get('cancel-analysis').hidden, true);
  assert.match(h.get('app-status').textContent, /could not read that audio format/);
});

test('a late transcript from a replaced recording cannot overwrite the new take or clear its pending request', async () => {
  const requests = [];
  const h = harness((url, init) => {
    const pending = deferred();
    requests.push({ url, init, pending });
    return pending.promise;
  });
  h.state.config.speechConfigured = true;
  h.setAudio(new Blob(['old audio']), 5, 'Old take');
  const oldResult = h.ensureTranscript().catch(() => '');
  h.setAudio(new Blob(['new audio']), 8, 'New take');
  assert.equal(requests[0].init.signal.aborted, true);
  const newResult = h.ensureTranscript();
  requests[0].pending.resolve(response({ text: 'STALE old transcript.', durationSeconds: 999 }));
  await oldResult;
  assert.notEqual(h.state.transcriptText, 'STALE old transcript.');
  assert.equal(h.state.audioDuration, 8);
  assert.ok(h.state.transcriptPromise, 'the old request must not clear the new pending request');
  requests[1].pending.resolve(response({ text: 'Fresh transcript.', durationSeconds: 8 }));
  assert.equal(await newResult, 'Fresh transcript.');
  assert.equal(h.state.transcriptText, 'Fresh transcript.');
});

test('discarding a recording aborts transcription and ignores a response arriving after discard', async () => {
  const pending = deferred();
  let signal;
  const h = harness(async (_url, init) => { signal = init.signal; return pending.promise; });
  h.state.config.speechConfigured = true;
  h.setAudio(new Blob(['audio']), 5, 'Discarded take');
  const result = h.ensureTranscript().catch(() => '');
  h.discardAudio();
  assert.equal(signal.aborted, true);
  pending.resolve(response({ text: 'Do not show this old recording.', durationSeconds: 5 }));
  await result;
  assert.equal(h.state.audioBlob, null);
  assert.equal(h.state.transcriptText, '');
  assert.equal(h.state.transcriptWords.length, 0);
  assert.equal(h.state.transcriptPromise, null);
});

test('analysis and corrected feedback reuse the replay transcript without repeating local recognition', async () => {
  const calls = [];
  const h = harness(async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/transcribe') return response({ text: 'My name is Jordan. Rehearsal helps.', durationSeconds: 4 });
    if (url === '/api/analyze-text') {
      const input = JSON.parse(init.body);
      return response({ transcript: input.text, wordStats: { durationSeconds: 4 }, analysis: {}, blunders: {} });
    }
    throw new Error(`Unexpected path ${url}`);
  });
  h.state.config.speechConfigured = true;
  h.state.config.analysisConfigured = true;
  h.setAudio(new Blob(['audio']), 4, 'Test take');
  await h.ensureTranscript();
  await h.runAnalysis();
  h.get('transcript').value = 'My name is Jordan. Practice helps everyone.';
  await h.runAnalysis({ corrected: true });
  assert.equal(calls.filter(item => item.url === '/api/transcribe').length, 1);
  const analyses = calls.filter(item => item.url === '/api/analyze-text');
  assert.equal(analyses.length, 2);
  assert.equal(JSON.parse(analyses[1].init.body).text, 'My name is Jordan. Practice helps everyone.');
  assert.equal(h.state.report.transcript, 'My name is Jordan. Practice helps everyone.');
});

function annotation(text, quote, category = 'thesis', comment = 'Review this passage.') {
  const start = text.indexOf(quote);
  assert.ok(start >= 0, 'test annotation must quote the original transcript');
  return { quote, category, comment, start, end: start + quote.length };
}

function decodeHtmlText(text) {
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => entities[entity]);
}

function exportedTranscript(document) {
  const match = document.match(/<div class="transcript">([\s\S]*?)<\/div>/);
  assert.ok(match, 'download must contain the transcript');
  return decodeHtmlText(match[1]
    .replace(/<a class="annotation-ref"[^>]*>\[\d+\]<\/a>/g, '')
    .replace(/<\/?mark\b[^>]*>/g, ''));
}

test('annotation segments and download preserve original Unicode, newlines and unmarked text exactly', () => {
  const h = harness();
  const text = '  Hi, I’m Maya. 🚀\nCafe\u0301s & cafés need longer hours.\n\nLet’s practice.\t ';
  const annotations = [
    annotation(text, 'Cafe\u0301s & cafés need longer hours.', 'thesis', 'Explain who benefits.'),
    annotation(text, 'Let’s practice.', 'structure', 'A specific close.'),
  ];
  const segments = h.annotationSegments(text, annotations);
  assert.equal(segments.map(segment => segment.text).join(''), text);
  const marked = segments.filter(segment => segment.annotation);
  assert.equal(marked.length, 2);
  for (const segment of marked) {
    assert.equal(text.slice(segment.annotation.start, segment.annotation.end), segment.text);
  }
  const html = h.buildAnnotatedDocument({ transcript: text, analysis: { method: 'ai', annotations } });
  assert.equal(exportedTranscript(html), text);
  assert.match(html, /charset="utf-8"/);
  assert.match(html, /white-space:pre-wrap/);
});

test('annotation validation refuses mismatched ranges, unknown categories and overlapping highlights', () => {
  const h = harness();
  const text = 'Students need time. Practice makes ideas clearer.';
  const valid = annotation(text, 'Students need time.', 'thesis');
  const candidates = [
    { ...valid, start: -1 },
    { ...valid, end: text.length + 5 },
    { ...valid, start: 0.5 },
    { ...valid, end: 0 },
    { ...valid, quote: 'Invented quote' },
    { ...valid, category: '__proto__' },
    { ...valid, comment: '' },
    valid,
    annotation(text, 'need time.', 'clarity', 'Overlapping excerpt.'),
    { ...valid, comment: 'Duplicate excerpt.' },
    annotation(text, 'Practice makes ideas clearer.', 'evidence'),
  ];
  const segments = h.annotationSegments(text, candidates);
  const marked = segments.filter(segment => segment.annotation);
  assert.equal(marked.length, 2);
  assert.ok(marked[0].annotation.end <= marked[1].annotation.start);
  assert.equal(segments.map(segment => segment.text).join(''), text);
  const html = h.buildAnnotatedDocument({ transcript: text, analysis: { method: 'ai', annotations: candidates } });
  assert.equal((html.match(/<mark\b/g) || []).length, 2);
  assert.ok(!html.includes('Invented quote') && !html.includes('Duplicate excerpt.'));
});

test('hostile transcript and comment markup remain inert text in the page and downloaded document', () => {
  const h = harness();
  const text = 'My claim: <script>globalThis.pwned = true</script>\n<img src=x onerror="pwned=true"> &lt;literal&gt; 🚀';
  const comment = '</li><script>alert("key")</script><a href="javascript:alert(1)">click</a> & \'quoted\'';
  const quote = '<script>globalThis.pwned = true</script>';
  const report = { transcript: text, analysis: { method: 'ai', annotations: [annotation(text, quote, 'clarity', comment)] } };
  const html = h.buildAnnotatedDocument(report);
  assert.equal(exportedTranscript(html), text, 'literal entities must not be double-decoded');
  assert.doesNotMatch(html, /<script\b|<img\b|<[^>]*\b(?:href="javascript:|onerror=)/i);
  assert.ok(html.includes('&lt;script&gt;globalThis.pwned = true&lt;/script&gt;'));
  assert.ok(html.includes('&lt;a href=&quot;javascript:alert(1)&quot;&gt;click&lt;/a&gt;'));
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  h.renderAnnotatedTranscript(report);
  const mark = h.get('annotated-transcript').children.find(child => child.tagName === 'MARK');
  assert.equal(mark.textContent, quote);
  assert.equal(h.get('annotations-notes').children[0].children[1].textContent, comment);
});

test('local reports never display or export AI highlights even if stale annotation data is present', () => {
  const h = harness();
  const text = 'Our students need practice.';
  const annotations = [annotation(text, text, 'thesis', 'Stale API comment.')];
  for (const method of ['local', 'rules', undefined]) {
    const report = { transcript: text, analysis: { method, annotations } };
    const html = h.buildAnnotatedDocument(report);
    assert.equal(exportedTranscript(html), text);
    assert.doesNotMatch(html, /<mark\b|Stale API comment\./);
    h.renderAnnotatedTranscript(report);
    assert.equal(h.get('annotations-notes').children.length, 0);
    assert.equal(h.get('annotated-transcript').children.length, 1);
    assert.equal(h.get('annotated-transcript').children[0].textContent, text);
  }
});

test('annotation display and export keep the analyzed version while textarea corrections are pending', () => {
  const h = harness();
  const original = 'Original claim: rehearsal improves clarity.';
  const correction = 'Edited claim: practice improves confidence.';
  const report = {
    transcript: original,
    analysis: { method: 'ai', annotations: [annotation(original, 'rehearsal improves clarity.', 'thesis')] },
  };
  const snapshot = JSON.stringify(report);
  h.state.report = report;
  h.state.transcriptText = correction;
  h.get('transcript').value = correction;
  const html = h.buildAnnotatedDocument(report);
  h.renderAnnotatedTranscript(report);
  assert.equal(exportedTranscript(html), original);
  assert.ok(!html.includes(correction));
  assert.equal(h.get('transcript').value, correction);
  assert.match(h.get('annotation-status').textContent, /analyzed version/);
  assert.equal(JSON.stringify(report), snapshot, 'rendering and downloading must not mutate the report');
});

test('full browser startup binds existing HTML controls and never references a removed element', async () => {
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'HTML element IDs must be unique');
  const referencedIds = [...appSource.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  const unknownIds = [...new Set(referencedIds.filter(id => !htmlIds.includes(id)))];
  assert.deepEqual(unknownIds, [], 'literal element references must exist in the current HTML');
  const calls = [];
  const h = harness(async url => {
    calls.push(url);
    assert.equal(url, '/api/config', 'startup must not process audio or request AI coaching');
    return response({ configured: false, speechConfigured: true, localSpeech: true, analysisConfigured: false, transcriptionModel: 'onnx-community/whisper-base.en' });
  }, { startup: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.missingIds, []);
  assert.deepEqual(calls, ['/api/config']);
  for (const [id, event] of [
    ['record-button', 'click'], ['pause-recording', 'click'], ['playback-toggle', 'click'],
    ['playback-scrub', 'input'], ['playback-scrub', 'keydown'], ['playback', 'timeupdate'],
    ['transcript', 'input'], ['download-transcript', 'click'], ['analyze-button', 'click'],
  ]) assert.ok(h.get(id).listeners.get(event)?.length, `${id} must bind its ${event} action`);
  assert.notEqual(h.get('app-status').className, 'app-status error', 'initial settings must render successfully');
});

test('local speech needs no coaching key and progress plus cancellation reach the browser service', async () => {
  const pending = deferred();
  let transcriptionSignal;
  const h = harness(async (path, options) => {
    if (path === '/api/config') return { analysisConfigured: false, speechConfigured: true, localSpeech: true };
    assert.equal(path, '/api/transcribe');
    transcriptionSignal = options.signal;
    return pending.promise;
  }, { startup: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.config.analysisConfigured, false);
  h.setAudio(new Blob(['private recording']), 4, 'Local take');
  const result = h.ensureTranscript();
  h.emitProgress('Downloading English speech model: 42%');
  assert.equal(h.get('local-model-status').textContent, 'Downloading English speech model: 42%');
  assert.equal(h.get('follow-transcript-status').textContent, 'Downloading English speech model: 42%');
  assert.equal(h.get('cancel-analysis').hidden, false);
  h.get('cancel-analysis').listeners.get('click')[0]();
  assert.equal(transcriptionSignal.aborted, true);
  pending.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(h.get('cancel-analysis').hidden, true);
  assert.equal(h.state.audioBlob.size, 'private recording'.length);
  assert.equal(h.state.transcriptText, '');
});

test('switching preparation views preserves both complete inputs in prompt preview', async () => {
  let payload;
  const h = harness(async (path, options) => {
    assert.equal(path, '/api/prompt-preview');
    payload = JSON.parse(options.body);
    return { prompt: 'Prepared prompt' };
  });
  const transcript = `  ${'Spoken words. '.repeat(8000)}\nFINAL SPOKEN WORDS  `;
  const script = `  ${'Script context. '.repeat(1600)}\nFINAL SCRIPT POINT  `;
  const points = '  First point.\nSecond point.\nFINAL CHECKLIST POINT  ';
  h.get('transcript').value = transcript;
  for (const [scriptValue, pointsValue, inferredMode] of [
    [script, points, 'both'], [script, '', 'script'], ['', points, 'points'], ['', '', 'points'],
    [' \n ', points, 'points'], [script, ' \n ', 'script'],
  ]) {
    h.get('target-script').value = scriptValue;
    h.get('target-talking-points').value = pointsValue;
    h.updateTargetHint();
    for (const view of ['points', 'script', 'points']) {
      h.setTargetView(view);
      assert.equal(h.get('talking-points-field').hidden, view !== 'points');
      assert.equal(h.get('full-script-field').hidden, view !== 'script');
      assert.equal(await h.loadPromptPreview(), 'Prepared prompt');
      assert.equal(payload.text, transcript);
      assert.equal(payload.targetScript, scriptValue, 'the hidden script remains included');
      assert.equal(payload.targetTalkingPoints, pointsValue, 'the hidden checklist remains included');
      assert.equal(payload.targetMode, inferredMode, 'the visible editor does not filter coaching context');
      assert.equal(h.get('target-script').value, scriptValue, 'switching views must not edit the script');
      assert.equal(h.get('target-talking-points').value, pointsValue, 'switching views must not edit the checklist');
      assert.ok(!Object.hasOwn(payload, 'analysisApiKey') && !Object.hasOwn(payload, 'token'));
    }
  }
  assert.doesNotMatch(appHtml, /name="target-mode"/);
  assert.doesNotMatch(appHtml, /<[^>]*id="talking-points-field"[^>]*\bhidden\b/);
});

test('static entrypoint is subdirectory-safe and speech setup offers English local models without credentials', () => {
  assert.match(appHtml, /<script type="module" src="\.\/bootstrap\.js"><\/script>/);
  assert.match(appHtml, /href="\.\/styles\.css"/);
  assert.match(appHtml, /href="\.\/" aria-label="Neeley Dress Rehearsal home"/);
  assert.match(appHtml, /value="onnx-community\/whisper-base\.en"/);
  assert.match(appHtml, /value="onnx-community\/whisper-small\.en"/);
  assert.ok(!htmlIds.includes('api-token') && !htmlIds.includes('transcription-endpoint'));
  assert.doesNotMatch(appSource, /\b(?:localStorage|sessionStorage)\b/);
});

test('collapsed practice context is preserved exactly in analysis and prompt preview', async () => {
  const detailsParents = new Map();
  const stack = [];
  for (const [tag] of appHtml.matchAll(/<\/?details\b[^>]*>/g)) {
    if (tag.startsWith('</')) { stack.pop(); continue; }
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    if (id) detailsParents.set(id, [...stack]);
    stack.push(id || '(unnamed details)');
  }
  for (const id of ['personal-details', 'transitions-details', 'rubric-details']) {
    assert.deepEqual(detailsParents.get(id), [], `${id} must stay available when another optional section is closed`);
    assert.match(appHtml, new RegExp(`<details class="speaker-details[^\"]*" id="${id}">`));
  }
  let payload;
  const h = harness(async (path, options) => {
    assert.equal(path, '/api/prompt-preview');
    payload = JSON.parse(options.body);
    return { prompt: 'Context included' };
  });
  const transitions = '  From the problem,\nlet’s move to our proposed solution.  ';
  const introduction = '  Before we begin, picture your first day on campus.\nThat experience is the reason for this proposal.  ';
  const rubric = `  Instructor criteria:\n${'Support each claim with evidence. '.repeat(1100)}\nFINAL CRITERION  `;
  h.get('transcript').value = 'My recorded presentation.';
  h.get('planned-introduction').value = introduction;
  h.get('planned-transitions').value = transitions;
  h.get('instructor-rubric').value = rubric;
  h.state.rubricFileName = 'Course rubric.pdf';
  h.get('personal-details').open = false;
  h.get('transitions-details').open = false;
  h.get('rubric-details').open = false;
  assert.equal(await h.loadPromptPreview(), 'Context included');
  assert.equal(payload.plannedIntroduction, introduction);
  assert.ok(!Object.hasOwn(payload, 'speakerName'));
  assert.equal(payload.plannedTransitions, transitions);
  assert.equal(payload.instructorRubric, rubric);
  assert.equal(payload.rubricFileName, 'Course rubric.pdf');
  assert.ok(!Object.hasOwn(payload, 'file') && !Object.hasOwn(payload, 'analysisApiKey'));
  assert.ok(!htmlIds.includes('speaker-name'));
  assert.match(appHtml, /id="planned-introduction" maxlength="8000"/);
});

test('rubric replacement and removal ignore late extraction results without re-enabling active analysis', async () => {
  const extractions = [];
  const h = harness(undefined, { extractRubric: file => {
    const pending = deferred(); extractions.push({ file, pending }); return pending.promise;
  } });
  const first = h.importRubric({ name: 'first.pdf', size: 100 });
  assert.equal(h.state.rubricLoading, true);
  assert.equal(h.get('analyze-button').disabled, true);
  assert.equal(h.get('reanalyze-button').disabled, true);
  assert.equal(h.get('instructor-rubric').disabled, true);
  const second = h.importRubric({ name: 'second.docx', size: 100 });
  extractions[0].pending.resolve({ name: 'first.pdf', text: 'Old rubric' });
  await first;
  assert.equal(h.get('instructor-rubric').value, '');
  assert.equal(h.state.rubricLoading, true, 'the old operation cannot unlock the replacement');
  h.removeRubric();
  extractions[1].pending.resolve({ name: 'second.docx', text: 'Removed rubric' });
  await second;
  assert.equal(h.get('instructor-rubric').value, '');
  assert.equal(h.state.rubricFileName, '');
  assert.equal(h.state.rubricLoading, false);
  const third = h.importRubric({ name: 'third.txt', size: 100 });
  h.setBusy(true);
  extractions[2].pending.resolve({ name: 'third.txt', text: '  Current rubric\nExact spacing.  ' });
  await third;
  assert.equal(h.get('instructor-rubric').value, '  Current rubric\nExact spacing.  ');
  assert.equal(h.state.rubricFileName, 'third.txt');
  assert.equal(h.state.busy, true);
  assert.equal(h.get('analyze-button').disabled, true, 'extraction completion cannot unlock an active analysis');
  h.setBusy(false);
  assert.equal(h.get('analyze-button').disabled, false);
});

test('failed rubric replacement clears the old criteria and supports manual text fallback', async () => {
  const h = harness(undefined, { extractRubric: async () => { throw new Error('Scanned page has no readable text.'); } });
  h.get('instructor-rubric').value = 'Old rubric criteria'; h.state.rubricFileName = 'old.pdf';
  await h.importRubric({ name: 'scanned.pdf', size: 100 });
  assert.equal(h.get('instructor-rubric').value, '');
  assert.equal(h.state.rubricFileName, '');
  assert.match(h.get('rubric-status').textContent, /previous rubric is no longer included/);
  assert.equal(h.get('instructor-rubric').disabled, false);
  h.get('instructor-rubric').value = 'Manually pasted criteria.';
  assert.equal(h.analysisInput('Speech').instructorRubric, 'Manually pasted criteria.');
  assert.equal(h.analysisInput('Speech').rubricFileName, '');
  await h.importRubric({ name: 'old-format.doc', size: 100 });
  assert.match(h.get('rubric-status').textContent, /PDF, DOCX, or TXT/);
  assert.equal(h.get('instructor-rubric').value, '');
});

test('pending rubric extraction prevents incomplete coaching and prompt requests', async () => {
  let requestCount = 0;
  const pending = deferred();
  const h = harness(async () => { requestCount++; throw new Error('Must not run with partial rubric text'); }, { extractRubric: () => pending.promise });
  h.get('transcript').value = 'My completed speech.';
  const importing = h.importRubric({ name: 'rubric.pdf', size: 100 });
  await h.runAnalysis({ corrected: true });
  assert.equal(await h.loadPromptPreview(), '');
  assert.equal(requestCount, 0);
  assert.equal(h.state.busy, false);
  h.setBusy(false);
  assert.equal(h.get('analyze-button').disabled, true, 'clearing other work cannot bypass a pending rubric');
  h.removeRubric(); pending.resolve({ name: 'rubric.pdf', text: 'Removed before completion.' });
  await importing;
});

test('report context badges describe the analyzed snapshot rather than subsequently edited fields', async () => {
  const pending = deferred();
  let submitted;
  const h = harness(async (path, options) => {
    assert.equal(path, '/api/analyze-text'); submitted = JSON.parse(options.body); return pending.promise;
  });
  h.get('transcript').value = 'My completed speech.';
  h.get('planned-introduction').value = 'Picture your first day on campus.';
  h.get('planned-transitions').value = 'Next, consider the evidence.';
  h.get('instructor-rubric').value = 'Provide clear evidence.';
  h.state.rubricFileName = 'instructor.txt';
  const analyzing = h.runAnalysis({ corrected: true });
  h.get('planned-introduction').value = ''; h.get('planned-transitions').value = ''; h.removeRubric();
  pending.resolve({ transcript: submitted.text, wordStats: {}, blunders: {}, analysis: {} });
  await analyzing;
  assert.equal(h.state.report.input.instructorRubric, 'Provide clear evidence.');
  assert.equal(h.state.report.input.plannedIntroduction, 'Picture your first day on campus.');
  assert.equal(h.state.report.input.plannedTransitions, 'Next, consider the evidence.');
  assert.equal(h.state.report.input.rubricFileName, 'instructor.txt');
  assert.equal(h.get('report-rubric-badge').hidden, false);
  assert.equal(h.get('report-transitions-badge').hidden, false);
  assert.equal(h.analysisInput('Next rehearsal.').instructorRubric, '');
});

test('missing coaching key shows setup and adding it analyzes existing corrected text without retranscription', async () => {
  const requests = [];
  let connected = false;
  const h = harness(async (path, options) => {
    if (path === '/api/config') return { analysisConfigured: false };
    requests.push(path);
    if (path === '/api/transcribe') return { text: 'Practice improves clarity.', durationSeconds: 4 };
    if (path === '/api/settings') { connected = true; return { analysisConfigured: true }; }
    assert.equal(path, '/api/analyze-text');
    const input = JSON.parse(options.body);
    assert.equal(input.useAI, true, 'analysis requests coaching even when the service must report a missing key');
    return { transcript: input.text, meta: { coachingStatus: connected ? 'complete' : 'not_connected' },
      analysis: connected ? { method: 'ai', overallRating: 82, annotations: [annotation(input.text, input.text)] } : { method: 'rules', overallLabel: 'Provisional observations' } };
  }, { startup: true });
  await nextTurn();
  h.setAudio(new Blob(['audio']), 4, 'Existing take');
  await h.runAnalysis();
  assert.equal(h.get('coaching-notice').hidden, false);
  assert.equal(h.get('speech-analysis-content').hidden, true, 'do not present an empty rating or heuristic thesis as AI coaching');
  assert.equal(h.get('coaching-action').textContent, 'Connect AI coach');
  assert.equal(h.get('annotation-title').textContent, 'Your transcript.');
  assert.equal(h.get('annotation-legend').hidden, true);
  const beforeSettings = requests.length;
  await h.get('coaching-action').click();
  assert.equal(h.get('settings-dialog').open, true);
  assert.equal(requests.length, beforeSettings, 'opening setup must not send transcript data');
  h.get('analysis-api-key').value = 'fake-test-key';
  await h.saveSettings({ preventDefault() {} });
  assert.equal(h.get('coaching-action').textContent, 'Analyze with AI');
  assert.equal(requests.filter(path => path === '/api/analyze-text').length, 1, 'saving a key does not start a paid request');
  h.get('transcript').value = 'Corrected words about rehearsal.';
  await h.get('coaching-action').click();
  assert.equal(requests.filter(path => path === '/api/transcribe').length, 1);
  assert.equal(h.state.report.transcript, 'Corrected words about rehearsal.');
  assert.equal(h.get('coaching-notice').hidden, true);
  assert.equal(h.get('speech-analysis-content').hidden, false);
  assert.equal(elementText(h.get('overall-rating')), '82 / 100');
  assert.equal(h.get('annotation-legend').hidden, false);
  assert.equal(h.get('annotation-title').textContent, 'Your transcript, annotated.');
});

test('failed coaching keeps the provider reason visible and offers retry instead of pretending the key is absent', () => {
  const h = harness();
  h.state.config.analysisConfigured = true;
  for (const coachingStatus of ['failed', 'invalid_response']) {
    h.state.report = { transcript: 'Practice improves clarity.', analysis: { method: 'rules' },
      warnings: ['Provider quota exhausted.'], meta: { coachingStatus } };
    h.renderReport();
    assert.equal(h.get('coaching-title').textContent, 'AI coaching could not finish.');
    assert.equal(h.get('coaching-action').textContent, 'Retry AI coaching');
    assert.equal(h.get('coaching-settings').hidden, false);
    assert.match(elementText(h.get('report-warnings')), /Provider quota exhausted/);
    assert.equal(h.get('speech-analysis-content').hidden, true);
    assert.match(h.get('annotation-status').textContent, /did not finish/);
  }
});

test('Codex settings apply only the speech model and never show a provider-key message', async () => {
  let saved;
  const config = { coachingViaHost: true, analysisConfigured: true, analysisProvider: 'codex', analysisProviderLabel: 'Codex', transcriptionModel: 'onnx-community/whisper-base.en' };
  const h = harness(async (path, options) => {
    assert.equal(path, '/api/settings'); saved = JSON.parse(options.body); return { ...config, ...saved };
  });
  h.updateConfig(config);
  assert.equal(h.get('connection-label').textContent, 'Codex coaching');
  assert.match(h.get('privacy-copy').textContent, /current Codex conversation/);
  assert.doesNotMatch(h.get('privacy-copy').textContent, /API key|OpenAI|Claude|Gemini/);
  h.get('analysis-api-key').value = 'must-not-be-used';
  h.get('analysis-model').value = 'must-not-be-used';
  h.get('transcription-model').value = 'onnx-community/whisper-small.en';
  await h.saveSettings({ preventDefault() {} });
  assert.deepEqual(saved, { transcriptionModel: 'onnx-community/whisper-small.en' });
  assert.match(h.get('app-status').textContent, /this Codex conversation/);
  assert.equal(h.state.config.analysisProvider, 'codex');
});

test('a denied panel export retains audio and reports the host limitation', async () => {
  const h = harness();
  const blob = new Blob(['audio']);
  h.setAudio(blob, 4, 'Retain this rehearsal');
  h.window.rehearsalDownloads = { async download(value, name) {
    assert.equal(value, blob);
    assert.equal(name, 'Retain this rehearsal.wav');
    throw new Error('This host does not support file downloads from the panel.');
  } };
  await h.downloadCurrentAudio();
  assert.match(h.get('app-status').textContent, /does not support file downloads/);
  assert.equal(h.state.audioBlob, blob);
  assert.equal(clickedDownloads(h).length, 0);
});

test('panel microphone permission policy failure keeps upload and manual transcript usable', async () => {
  let microphoneRequests = 0;
  const h = harness(undefined, { mediaDevices: { async getUserMedia() { microphoneRequests++; throw new Error('Should not request'); } } });
  h.state.config.coachingViaHost = true;
  h.document.permissionsPolicy = { allowsFeature: () => false };
  assert.equal(await h.enableMic(), false);
  assert.equal(microphoneRequests, 0);
  assert.equal(h.get('upload-button').disabled, false);
  assert.match(h.get('app-status').textContent, /Upload a recording or paste a transcript/);
});

test('changing a panel speech model preserves a manually pasted transcript and its report', () => {
  const h = harness();
  h.get('transcript').value = 'Manually pasted rehearsal.';
  h.state.transcriptText = 'Manually pasted rehearsal.';
  const report = { transcript: h.state.transcriptText, analysis: { method: 'ai' } };
  h.state.report = report;
  h.updateConfig({ coachingViaHost: true, analysisConfigured: true, analysisProvider: 'codex', transcriptionModel: 'onnx-community/whisper-small.en' });
  assert.equal(h.get('transcript').value, 'Manually pasted rehearsal.');
  assert.equal(h.state.transcriptText, 'Manually pasted rehearsal.');
  assert.equal(h.state.report, report);
  assert.equal(h.state.config.transcriptionModel, 'onnx-community/whisper-small.en');
});
