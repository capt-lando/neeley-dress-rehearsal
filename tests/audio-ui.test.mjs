import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createHostedLiveSession } from '../lib/hosted-live.mjs';
import { createRealtimeSocketFixture } from './fixtures/realtime-socket.mjs';
import { createProcessingProgress } from '../lib/processing-progress.mjs';
import { validateAudioUploadHeader } from '../lib/audio-upload-header.mjs';
import { renderDiscussableTranscript, selectedTranscriptQuote, createAnnotationPopover, annotationAssessment, annotationCategory } from '../lib/transcript-discussion.mjs';
import { createRehearsalChat } from '../public/rehearsal-chat.js';
import { analyzeSpeech, sanitizeAiFeedback, MAX_TRANSCRIPT_ANNOTATIONS } from '../lib/analysis-core.mjs';
const TEST_MODEL_ID = 'gpt-live-transcribe';

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
const executableAppSource = appSource.replace(/^import .*;\r?$/gm, '');
const appHtml = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const htmlIds = [...appHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const meterMarkup = appHtml.match(/id="input-level"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/)?.[1] || '';
const meterBarCount = [...meterMarkup.matchAll(/<span\b/g)].length;
const listenerStart = executableAppSource.indexOf("$('settings-open').addEventListener");
assert.ok(listenerStart > 0, 'browser app must expose its declarations before wiring DOM events');
const declarations = executableAppSource.slice(0, listenerStart);

class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.children = []; this.options = [];
    this.style = { setProperty(name, value) { this[name] = value; } }; this.dataset = {}; this.attributes = new Map(); this.listeners = new Map();
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
  set innerHTML(_) { throw new Error('Unsafe HTML sink'); }
  set outerHTML(_) { throw new Error('Unsafe HTML sink'); }
  insertAdjacentHTML() { throw new Error('Unsafe HTML insertion'); }
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
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== handler)); }
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
  scrollIntoView() { this.scrollCalls = (this.scrollCalls || 0) + 1; }
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

function harness(requestImpl = async () => { throw new Error('Unexpected rehearsal service request'); }, { startup = false, hosted = false, initialHash = '', extractRubric = async () => { throw new Error('Unexpected document extraction'); }, prepareRubricPreview, mediaDevices = {}, permissions, recordings = {}, decodeAudioData, validateUploadHeader = async () => {}, audioMetadata = audio => (audio.listeners.get('loadedmetadata') || []).forEach(handler => handler()) } = {}) {
  const elements = new Map();
  const missingIds = [];
  let ownerDocument;
  const get = id => {
    if (!elements.has(id)) {
      const element = Object.assign(new Element(), { ownerDocument });
      if (id === 'input-level') element.append(...Array.from({ length: meterBarCount }, () => new Element()));
      if (id === 'saved-recordings-details') element.append(Object.assign(new Element(), { tagName: 'SUMMARY', ownerDocument }));
      if (id === 'history-page') element.hidden = true;
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
    createProcessingProgress, validateAudioUploadHeader: validateUploadHeader, MAX_TRANSCRIPT_ANNOTATIONS,
    document: {
      getElementById: id => {
        if (startup && !htmlIds.includes(id)) { missingIds.push(id); return null; }
        return get(id);
      },
      createElement: tag => {
        const element = Object.assign(new Element(), { tagName: tag.toUpperCase(), ownerDocument });
        if (tag === 'audio') element.load = () => { if (element.src) audioMetadata(element); };
        createdElements.push(element); return element;
      },
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
      rehearsalService: { hosted, request: requestImpl, setProgressHandler(handler) { progressHandler = handler; } },
      location: { pathname: '/practice/', search: '', hash: initialHash },
      rehearsalDocuments: { extractRubric, prepareRubricPreview },
      rehearsalRecordings: recordingStore,
    },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    Blob, Uint8Array, Float32Array, ArrayBuffer, DataView, Math, Date, AbortController, AbortSignal, DOMException,
    renderDiscussableTranscript, selectedTranscriptQuote, createAnnotationPopover, annotationAssessment, annotationCategory, createRehearsalChat,
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
  vm.runInContext(`${startup ? executableAppSource : declarations}
globalThis.audioTest = {
  state, updateConfig, openSettings, enableMic, enumerateInputs, openInputSelector, cleanupMic, initializeInputDetection, meterLoop, resetMeter,
  startRecording, stopRecording, captureRecordingSamples, toggleRecordingPause, uploadAudio, cancelLiveSession, openCancelRestart, confirmCancelRestart, closeCancelRestart,
  wordIndexAtTime, seekPlayback, ensureTranscript, setAudio, discardAudio, renderFollowTranscript, renderSummaryDraft, attachTranscriptSelection, getChatContext,
  runAnalysis, renderReport, annotationSegments, buildAnnotatedDocument, renderAnnotatedTranscript,
  analysisInput, updateTargetHint, setTargetView, loadPromptPreview, importRubric, removeRubric, openRubricPreview, showRubricPage, importAssignment, removeAssignment, preparationDocuments, setBusy,
  autosaveRecording, refreshSavedRecordings, renderSavedRecordings, openSavedRecording, deleteSavedRecording,
  downloadCurrentAudio, downloadSavedRecording, warnBeforeLeaving, showPage, startNewRehearsal, captureViewGeneration, isViewGenerationCurrent
};`, context);
  const emit = async (target, type, event = {}) => Promise.all((target.listeners.get(type) || []).map(handler => handler({ type, ...event })));
  return { ...context.audioTest, get, revoked, missingIds, document: context.document, navigator: context.navigator, window: context.window,
    objectUrls, createdElements, storageCalls, savedRecords, recordingStore, flushTimers: () => { while (timers.length) timers.shift()(); },
    emitMediaEvent: (type, event) => emit(mediaEvents, type, event),
    emitWindowEvent: (type, event) => emit(windowEvents, type, event),
    emitDocumentEvent: (type, event) => emit(documentEvents, type, event),
    emitElementEvent: (id, type, event) => emit(get(id), type, event),
    emitProgress: message => progressHandler(message) };
}

function microphone(label) {
  const track = { label, readyState: 'live', stopped: 0, onended: null, stop() { this.stopped++; this.readyState = 'ended'; } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}

test('summary keeps its empty placeholder and fills with draft text without running analysis', () => {
  const h = harness();
  h.renderSummaryDraft();
  assert.match(h.get('annotated-transcript').textContent, /words will appear/);
  assert.equal(h.get('download-transcript').disabled, true);
  h.renderSummaryDraft('My first point. My next point.', true);
  assert.equal(elementText(h.get('annotated-transcript')), 'My first point. My next point.');
  assert.equal(h.state.report, null);
  assert.equal(h.get('speech-analysis-content').hidden, true);
  assert.equal(h.get('annotation-legend').hidden, true);
});

test('clicking a sentence attaches it without a request or replacing the composed question', () => {
  const h = harness();
  h.renderSummaryDraft('A clear claim. Another point.');
  const sentence = h.get('annotated-transcript').children[0], quotes = [];
  h.get('chat-input').value = 'Can you make this clearer?';
  h.state.chat = { selectQuote: quote => quotes.push(quote) };
  h.attachTranscriptSelection({ type: 'click', target: { closest: selector => selector === '.transcript-sentence' ? sentence : null } });
  assert.deepEqual(quotes, ['A clear claim.']);
  assert.equal(h.get('chat-input').value, 'Can you make this clearer?');
  assert.equal(h.state.report, null);
});

test('paragraph selection survives the click after pointerup and excludes annotation reference text', () => {
  const h = harness(), quote = 'A clear claim. Another point.', quotes = [];
  h.renderSummaryDraft(quote);
  const sentence = h.get('annotated-transcript').children[0];
  let referencesRemoved = false;
  const fragment = { textContent: quote + '[1]', querySelectorAll: () => [{ remove() { referencesRemoved = true; fragment.textContent = quote; } }] };
  h.window.getSelection = () => ({ isCollapsed: false, rangeCount: 1, anchorNode: sentence, focusNode: sentence,
    getRangeAt: () => ({ cloneContents: () => fragment }) });
  h.state.chat = { selectQuote(value) { quotes.push(value); h.window.getSelection = () => ({ isCollapsed: true }); } };
  const target = { closest: selector => selector === '.transcript-sentence' ? sentence : null };
  h.attachTranscriptSelection({ type: 'pointerup', target });
  h.attachTranscriptSelection({ type: 'click', target });
  assert.equal(referencesRemoved, true);
  assert.deepEqual(quotes, [quote], 'the follow-up click must not replace a selected paragraph with one sentence');
});

test('highlight and star activation opens coaching once while plain sentences and dragged selections still attach to chat', async () => {
  const h = harness(), text = 'A clear claim. Another point.';
  h.renderAnnotatedTranscript({ transcript: text, analysis: { method: 'ai', annotations: [annotation(text, 'A clear claim.', 'great')] } });
  const mark = h.createdElements.find(node => node.tagName === 'MARK');
  const reference = h.createdElements.find(node => node.className === 'annotation-ref');
  const firstSentence = h.get('annotated-transcript').children[0];
  const lastSentence = h.get('annotated-transcript').children.at(-1);
  const openings = [], quotes = [];
  h.state.annotationPopover.open = (number, trigger) => openings.push({ number, trigger });
  h.state.chat = { selectQuote: quote => quotes.push(quote) };
  const targetFor = trigger => ({ closest: selector => selector === '[data-annotation-number]' ? trigger : selector === '.transcript-sentence' ? firstSentence : null });
  let prevented = 0;
  await h.emitElementEvent('annotated-transcript', 'click', { target: targetFor(mark), preventDefault() { prevented++; } });
  await h.emitElementEvent('annotated-transcript', 'click', { target: targetFor(reference), preventDefault() { prevented++; } });
  assert.equal(openings.length, 2); assert.deepEqual(quotes, []);
  for (const key of ['Enter', ' ']) {
    const target = targetFor(reference);
    await h.emitElementEvent('annotated-transcript', 'keydown', { key, target, preventDefault() { prevented++; } });
    await h.emitElementEvent('annotated-transcript', 'keyup', { key, target, preventDefault() { prevented++; } });
  }
  assert.equal(openings.length, 4, 'keyup must not reopen or toggle the bubble after keydown');
  assert.ok(prevented >= 6, 'keyboard activation suppresses native link clicks and scrolling');
  await h.emitElementEvent('annotated-transcript', 'click', { target: { closest: selector => selector === '.transcript-sentence' ? lastSentence : null } });
  assert.deepEqual(quotes, ['Another point.']);
  const fragment = { textContent: text, querySelectorAll: () => [] };
  h.window.getSelection = () => ({ isCollapsed: false, rangeCount: 1, anchorNode: firstSentence, focusNode: lastSentence, getRangeAt: () => ({ cloneContents: () => fragment }) });
  await h.emitElementEvent('annotated-transcript', 'pointerup', { target: targetFor(mark) });
  h.window.getSelection = () => ({ isCollapsed: true });
  await h.emitElementEvent('annotated-transcript', 'click', { target: targetFor(mark), preventDefault() {} });
  assert.equal(openings.length, 4, 'a click following a text selection must not open coaching');
  assert.deepEqual(quotes, ['Another point.', text]);
});
const inputDevice = (deviceId, label = '') => ({ kind: 'audioinput', deviceId, label });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const hostedConfig = { hosted: true, localSpeech: false, liveTranscription: false, transcriptionModel: TEST_MODEL_ID, analysisProvider: 'hosted', providers: [], auth: { signedIn: true }, analysisConfigured: true };
const elementText = element => String(element.textContent || '') + element.children.map(elementText).join('');
const settleAudioSaves = async h => { await Promise.all([...h.state.pendingAudioSaves]); await nextTurn(); };
const savedTake = (id, caption = id) => ({ id, blob: new Blob([`audio-${id}`], { type: 'audio/wav' }), duration: 4, caption, createdAt: 1_760_000_000_000 });
const clickedDownloads = h => h.createdElements.filter(element => element.tagName === 'A' && element.clicked);
const libraryAction = (h, caption, action) => h.get('saved-recordings-list').querySelectorAll('button').find(button => button.getAttribute('aria-label')?.startsWith(`${action} ${caption},`));
function cloudLiveSpeech(h, { onAudio = () => 'Um, practice helps.', onFinish, complete = true } = {}) {
  const calls = [], uploads = [];
  const transport = createRealtimeSocketFixture({ onAudio, onFinish });
  const id = '12345678-1234-4123-8123-123456789012';
  let session;
  h.window.rehearsalLiveSpeech = { startSession(options) {
    session = createHostedLiveSession({ ...options, recordingId: id, requestId: 'request', validateStart() {},
      WebSocketImpl: transport.WebSocketImpl,
      async getConnection() { return { url: 'wss://example.test/live-stream', token: 'test-token' }; },
      async request(path, settings) {
        calls.push({ path, ...settings });
        if (path === '/live-sessions') return { recordingId: id };
        if (path.endsWith('/cancel')) return { recordingId: id, cancelled: true };
        assert.ok(path.endsWith('/finish'));
        return { recordingId: id, complete, text: transport.transcript, durationSeconds: settings.body.durationSeconds };
      },
      async saveAudio(blob) { uploads.push(blob); return { durationSeconds: (blob.size - 44) / 32000, sizeBytes: blob.size }; },
    });
    return session;
  } };
  return { calls, uploads, id, sockets: transport.sockets, get session() { return session; } };
}

test('hosted recording and replay never run local inference, upload audio, or save anonymous browser copies', async () => {
  const requests = [];
  const h = harness(async path => { requests.push(path); if (path === '/api/config') return hostedConfig; throw new Error('Unexpected cloud upload'); }, { startup: true });
  await nextTurn();
  let liveStarts = 0;
  h.window.rehearsalLiveSpeech = { startSession() { liveStarts++; throw new Error('Local inference must not run'); } };
  await h.enableMic(); await h.startRecording(); h.captureRecordingSamples(new Float32Array(16000), 16000); h.stopRecording();
  assert.equal(liveStarts, 0); assert.equal(h.storageCalls.save.length, 0);
  for (const callback of h.get('playback').listeners.get('play')) callback();
  await nextTurn();
  assert.deepEqual(requests, ['/api/config']);
  assert.match(h.get('audio-save-status').textContent, /This take is in this tab/);
  assert.equal(h.get('saved-recordings-details').hidden, true);
  assert.equal(h.get('cloud-recordings-details').hidden, false);
});

test('hosted live recording shows words immediately, excludes pauses, and saves the exact complete WAV before coaching', async () => {
  const h = harness(); h.updateConfig({ ...hostedConfig, liveTranscription: true });
  const pending = deferred();
  const cloud = cloudLiveSpeech(h, { onFinish: () => pending.promise });
  let historyRefreshes = 0;
  h.window.rehearsalAccount = { track() {}, refreshHistory() { historyRefreshes++; } };
  await h.enableMic(); h.state.context.sampleRate = 48000;
  await h.startRecording();
  h.captureRecordingSamples(new Float32Array(4800).fill(0.25), 48000);
  await nextTurn();
  assert.equal(cloud.sockets[0].frames.length, 1, 'The first 100 ms is streamed without waiting for ten seconds');
  assert.equal(h.get('follow-transcript').textContent, 'Um, practice helps.');
  assert.equal(elementText(h.get('annotated-transcript')), 'Um, practice helps.');
  assert.equal(h.get('speech-analysis-content').hidden, true, 'live text does not invent analysis');
  assert.equal(h.get('annotation-legend').hidden, true);
  assert.equal(h.get('transcript-details').hidden, true, 'draft text is not editable mid-take');
  assert.equal(h.getChatContext().context.text, 'Um, practice helps.');
  assert.equal(h.state.transcriptText, '', 'draft segments cannot be used for coaching');
  assert.match(h.get('follow-transcript-status').textContent, /Live transcript/);
  assert.doesNotMatch(h.get('follow-transcript-status').textContent, /transcribed| of |%/, 'Audio acknowledgements are not transcript completion');
  h.toggleRecordingPause(); h.captureRecordingSamples(new Float32Array(48000).fill(0.9), 48000);
  assert.equal(cloud.sockets[0].frames.length, 1, 'Paused audio never reaches the live stream');
  h.toggleRecordingPause();
  h.captureRecordingSamples(new Float32Array(48000 * 9.9).fill(0.25), 48000); await nextTurn();
  h.captureRecordingSamples(new Float32Array(4800).fill(-0.25), 48000);
  h.stopRecording(); const finishing = h.state.livePromise;
  await nextTurn();
  assert.equal(h.window.rehearsalHostedActions.canReplaceAudio(), false);
  assert.equal(h.get('analyze-button').disabled, true);
  assert.equal(cloud.uploads.length, 0, 'the complete WAV waits for the final transcript segment');
  assert.ok(cloud.sockets[0].frames.every(frame => frame.byteLength <= 9600), 'Every PCM frame is at most 200 ms');
  assert.equal(cloud.sockets[0].samples, 242400, 'All 10.1 seconds are sent exactly once at 24 kHz');
  assert.ok(!cloud.calls.some(call => call.path.includes('/chunks/') || call.path.endsWith('/prepare')));
  pending.resolve('Um, practice helps. Next point.');
  assert.equal(await finishing, 'Um, practice helps. Next point.');
  assert.deepEqual(cloud.uploads, [h.state.audioBlob]);
  assert.equal(inspectWav(Buffer.from(await cloud.uploads[0].arrayBuffer())).durationSeconds, 10.1);
  assert.equal(h.storageCalls.save.length, 0, 'cloud recording does not create an anonymous browser copy');
  assert.equal(h.state.cloudRecordingId, cloud.id);
  assert.equal(h.analysisInput(h.state.transcriptText).recordingId, cloud.id);
  assert.equal(await h.ensureTranscript(), 'Um, practice helps. Next point.');
  assert.equal(cloud.uploads.length, 1); assert.equal(historyRefreshes, 1);
  assert.equal(h.window.rehearsalHostedActions.canReplaceAudio(), true);
});

test('failed cloud segments keep capturing and save complete audio on Stop without caching the partial preview', async () => {
  const h = harness(); h.updateConfig({ ...hostedConfig, liveTranscription: true });
  let samples = 0;
  const cloud = cloudLiveSpeech(h, { complete: false, onAudio: frame => {
    samples += frame.byteLength / 2;
    if (samples > 240000) throw new Error('Cloud connection interrupted');
    return 'Partial preview.';
  } });
  await h.startRecording(); h.captureRecordingSamples(new Float32Array(16000 * 10), 16000); await nextTurn();
  h.captureRecordingSamples(new Float32Array(16000 * 10), 16000); await nextTurn();
  assert.equal(h.state.recording, true); assert.ok(h.state.liveTake?.failed);
  h.captureRecordingSamples(new Float32Array(16000), 16000);
  h.stopRecording(); const finishing = h.state.livePromise;
  await assert.rejects(finishing, /Cloud connection interrupted/);
  assert.equal(cloud.uploads.length, 1); assert.equal(cloud.uploads[0], h.state.audioBlob);
  assert.equal(inspectWav(Buffer.from(await cloud.uploads[0].arrayBuffer())).durationSeconds, 21);
  assert.equal(h.state.cloudRecordingId, cloud.id);
  assert.equal(h.state.transcriptText, ''); assert.equal(h.get('transcript').value, '');
  assert.equal(h.state.liveTake, null); assert.equal(h.get('follow-transcript-connect').hidden, false);
  assert.match(h.get('follow-transcript-note').textContent, /incomplete preview/);
  assert.match(h.get('audio-save-status').textContent, /Saved privately/);
});

test('silent microphone input never stops a hosted recording or starts coaching', async () => {
  const h = harness(() => { throw new Error('Silence must not trigger coaching'); });
  h.updateConfig({ ...hostedConfig, liveTranscription: true });
  const cloud = cloudLiveSpeech(h, { onAudio: () => '' });
  await h.startRecording();
  h.captureRecordingSamples(new Float32Array(16000 * 20), 16000); await nextTurn();
  assert.equal(h.state.recording, true); assert.equal(h.state.audioBlob, null);
  assert.equal(cloud.uploads.length, 0); assert.ok(!cloud.calls.some(call => call.path.endsWith('/finish')));
  h.stopRecording(); await h.state.livePromise;
  assert.equal(cloud.uploads.length, 1);
});

test('a failed cloud save leaves an explicit download/retry path and releases analysis controls', async () => {
  const h = harness(); h.updateConfig({ ...hostedConfig, liveTranscription: true });
  h.window.rehearsalLiveSpeech = { startSession: () => ({ push() {}, cancel() {}, async finish(blob) {
    assert.equal(blob, h.state.audioBlob); throw new Error('Upload unavailable');
  } }) };
  await h.startRecording(); h.captureRecordingSamples(new Float32Array(16000), 16000); h.stopRecording();
  await assert.rejects(h.state.livePromise, /Upload unavailable/);
  assert.ok(h.state.audioBlob); assert.equal(h.state.liveTake, null); assert.equal(h.state.transcriptText, '');
  assert.equal(h.get('analyze-button').disabled, false); assert.equal(h.get('follow-transcript-connect').hidden, false);
  assert.match(h.get('audio-save-status').textContent, /Download it or retry transcription/);
});

test('hosted live recording requires sign-in and account changes cancel before Stop can upload private audio', async () => {
  const h = harness(); h.updateConfig({ ...hostedConfig, liveTranscription: true, auth: { signedIn: false } });
  const cloud = cloudLiveSpeech(h);
  await h.startRecording(); h.captureRecordingSamples(new Float32Array(16000), 16000); h.stopRecording();
  assert.equal(cloud.session, undefined); assert.equal(cloud.calls.length, 0);
  h.window.rehearsalHostedActions.accountChanged('first-user');
  await h.startRecording(); h.captureRecordingSamples(new Float32Array(16000), 16000); await nextTurn();
  assert.ok(cloud.session);
  h.window.rehearsalHostedActions.accountChanged('second-user'); await nextTurn();
  assert.equal(cloud.session.getState().cancelled, true);
  assert.equal(cloud.sockets[0].readyState, 3, 'Changing accounts closes the old authenticated stream');
  assert.equal(cloud.uploads.length, 0); assert.equal(cloud.calls.some(call => call.path.endsWith('/finish')), false);
  assert.equal(h.state.recording, false); assert.equal(h.state.audioBlob, null); assert.equal(h.state.liveTake, null);
});

test('opening a private cloud take enables downloading its exact audio without another upload', async () => {
  const h = harness();
  h.updateConfig(hostedConfig); h.discardAudio();
  assert.equal(h.get('download-audio').disabled, true);
  const blob = new Blob(['saved cloud WAV']);
  h.window.rehearsalHostedActions.restoreRecording({ id: 'cloud-take', title: 'Private rehearsal', durationSeconds: 2, blob, transcript: 'Um, practice helps.' });
  assert.equal(h.get('download-audio').disabled, false);
  assert.equal(h.get('transcript').value, 'Um, practice helps.');
  assert.equal(h.state.cloudRecordingId, 'cloud-take');
  assert.equal(h.storageCalls.save.length, 0);
  await h.downloadCurrentAudio();
  const [download] = clickedDownloads(h);
  assert.equal(h.objectUrls.get(download.href), blob);
});

test('hosted explicit transcription remembers the cloud recording ID for coaching', async () => {
  const requests = [];
  const id = '12345678-1234-4123-8123-123456789012';
  const h = harness(async (path, options) => { requests.push({ path, options }); return { text: 'Um, practice helps.', durationSeconds: 1, recordingId: id }; });
  h.updateConfig(hostedConfig); h.setAudio(new Blob(['prepared WAV']), 1, 'Private take');
  await h.ensureTranscript();
  assert.equal(requests.length, 1); assert.equal(requests[0].path, '/api/transcribe');
  assert.equal(h.state.cloudRecordingId, id); assert.equal(h.analysisInput('Um, practice helps.').recordingId, id);
  assert.match(h.get('audio-save-status').textContent, /Saved privately/);
});

test('hosted signed-out users can keep audio locally but cannot send it for transcription', async () => {
  const h = harness(); let opened = 0;
  h.window.rehearsalAccount = { open() { opened++; } };
  h.updateConfig({ ...hostedConfig, auth: { signedIn: false }, analysisConfigured: false });
  h.setAudio(new Blob(['prepared WAV']), 1, 'Private take');
  await assert.rejects(h.ensureTranscript(), /Sign in/);
  assert.equal(opened, 1); assert.ok(h.state.audioBlob);
});

test('switching hosted accounts clears current private preparation, transcript, report, and playback', () => {
  const h = harness(); h.updateConfig(hostedConfig);
  h.window.rehearsalHostedActions.accountChanged('first-user');
  h.setAudio(new Blob(['private WAV']), 1, 'Private take');
  h.state.cloudRecordingId = 'saved-id'; h.state.transcriptText = 'Private speech';
  h.get('target-script').value = 'Private script'; h.get('instructor-rubric').value = 'Private rubric';
  h.state.report = { private: true };
  h.window.rehearsalHostedActions.accountChanged('second-user');
  assert.equal(h.state.audioBlob, null); assert.equal(h.state.transcriptText, ''); assert.equal(h.state.report, null);
  assert.equal(h.get('target-script').value, ''); assert.equal(h.get('instructor-rubric').value, '');
  assert.equal(h.state.cloudRecordingId, '');
});

test('switching hosted accounts during analysis releases busy controls and rejects late feedback', async () => {
  const pending = deferred();
  const h = harness(async path => path === '/api/transcribe' ? { text: 'Private speech.', durationSeconds: 1, recordingId: '12345678-1234-4123-8123-123456789012' } : pending.promise);
  h.updateConfig(hostedConfig); h.window.rehearsalHostedActions.accountChanged('first-user');
  h.setAudio(new Blob(['audio']), 1, 'Private take');
  const analysis = h.runAnalysis(); await nextTurn();
  assert.equal(h.state.busy, true);
  h.window.rehearsalHostedActions.accountChanged('second-user');
  assert.equal(h.state.busy, false); assert.equal(h.get('record-button').disabled, false);
  pending.resolve({ analysis: { method: 'ai' } }); await analysis;
  assert.equal(h.state.report, null); assert.equal(h.state.busy, false);
});

test('late audio decoding cannot cross accounts or unlock a newer account decode', async () => {
  const old = deferred(), current = deferred(); let decode = 0;
  const h = harness(undefined, { decodeAudioData: () => (++decode === 1 ? old.promise : current.promise) });
  h.updateConfig(hostedConfig); h.window.rehearsalHostedActions.accountChanged('first-user');
  const first = h.uploadAudio(Object.assign(new Blob(['file']), { name: 'private-old.wav' })); await nextTurn();
  h.window.rehearsalHostedActions.accountChanged('second-user');
  const second = h.uploadAudio(Object.assign(new Blob(['file']), { name: 'new-account.wav' })); await nextTurn();
  const decoded = { duration: 1, length: 16000, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(16000) };
  old.resolve(decoded); await first;
  assert.equal(h.state.audioBlob, null); assert.equal(h.state.busy, true); assert.equal(h.state.preparingAudio, true);
  current.resolve(decoded); await second;
  assert.match(h.get('recording-caption').textContent, /new-account/);
  assert.equal(h.state.busy, false);
});

test('switching hosted accounts invalidates pending rubric extraction', async () => {
  const extraction = deferred();
  const h = harness(undefined, { extractRubric: () => extraction.promise });
  h.updateConfig(hostedConfig); h.window.rehearsalHostedActions.accountChanged('first-user');
  const importing = h.importRubric({ name: 'private-rubric.docx', size: 10 });
  assert.equal(h.state.rubricLoading, true);
  h.window.rehearsalHostedActions.accountChanged('second-user');
  extraction.resolve({ text: 'Private old rubric', name: 'private-rubric.docx' }); await importing;
  assert.equal(h.get('instructor-rubric').value, ''); assert.equal(h.state.rubricFileName, ''); assert.equal(h.state.rubricLoading, false);
});

test('completed takes autosave only audio metadata once, and short takes are not saved', async () => {
  const h = harness();
  await h.enableMic(); await h.startRecording();
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

test('cloud audio upload sends only newly encoded 16 kHz mono PCM, never the selected file or its metadata', async () => {
  const metadata = 'ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000private artist and embedded artwork <script>doNotSend()</script>';
  const original = new File([metadata], 'original.mp3', { type: 'audio/mpeg' });
  let sent;
  const h = harness(async (path, options) => {
    assert.equal(path, '/api/transcribe'); sent = options.body;
    assert.equal(options.headers['Content-Type'], 'audio/wav');
    return { text: 'Practice helps.', durationSeconds: 1, recordingId: 'owned' };
  }, { validateUploadHeader: validateAudioUploadHeader, decodeAudioData: async bytes => {
    assert.equal(new TextDecoder().decode(bytes), metadata);
    return { duration: 1, sampleRate: 48000, length: 48000, numberOfChannels: 2, getChannelData: channel => new Float32Array(48000).fill(channel ? 0.5 : 0.25) };
  } });
  h.updateConfig(hostedConfig); await h.uploadAudio(original); await h.ensureTranscript();
  assert.notEqual(sent, original); assert.equal(sent, h.state.audioBlob); assert.equal(sent.type, 'audio/wav');
  const bytes = Buffer.from(await sent.arrayBuffer());
  assert.equal(inspectWav(bytes).durationSeconds, 1); assert.equal(bytes.length, 32044);
  assert.equal(bytes.readInt16LE(44), Math.trunc(0.375 * 32767));
  assert.ok(!bytes.includes(Buffer.from(metadata)), 'encoded source metadata cannot pass through to the cloud');
});

test('audio metadata rejects a known overlong file before reading or native decoding and releases its resources', async () => {
  let reads = 0, decodes = 0;
  const h = harness(undefined, {
    audioMetadata: audio => { audio.duration = 601; audio.listeners.get('loadedmetadata')[0](); },
    decodeAudioData: async () => { decodes++; throw new Error('Must not decode'); },
  });
  const original = new Blob(['previous recording']); h.setAudio(original, 2, 'Previous');
  await h.uploadAudio({ name: 'long.mp3', size: 100, arrayBuffer() { reads++; throw new Error('Must not read'); } });
  assert.equal(reads, 0); assert.equal(decodes, 0);
  assert.equal(h.state.audioBlob, original);
  assert.match(h.get('app-status').textContent, /longer than 10 minutes/);
  const media = h.createdElements.find(node => node.tagName === 'AUDIO');
  assert.equal(media.src, ''); assert.equal(media.paused, true);
  assert.equal(media.listeners.get('loadedmetadata').length, 0); assert.equal(media.listeners.get('error').length, 0);
  assert.equal(h.revoked.filter(url => h.objectUrls.get(url)?.name === 'long.mp3').length, 1);
  assert.equal(h.state.audioMetadataCancel, null); assert.equal(h.state.busy, false);
  h.flushTimers(); assert.equal(h.state.audioBlob, original);
});

test('unknown, unavailable or timed-out metadata preserves valid uploads and the decoded duration limit', async () => {
  for (const metadata of ['infinite', 'missing', 'error', 'timeout', 'understated']) {
    let decodes = 0;
    const h = harness(undefined, {
      audioMetadata: audio => {
        if (metadata === 'timeout') return;
        audio.duration = metadata === 'infinite' ? Infinity : metadata === 'understated' ? 1 : NaN;
        audio.listeners.get(metadata === 'error' ? 'error' : 'loadedmetadata')[0]();
      },
      decodeAudioData: async () => { decodes++; return { duration: metadata === 'understated' ? 601 : 1, sampleRate: 16000, length: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(16000) }; },
    });
    const opening = h.uploadAudio(new File(['valid audio'], 'recording.webm'));
    if (metadata === 'timeout') { await nextTurn(); h.flushTimers(); }
    await opening;
    assert.equal(decodes, 1, metadata);
    if (metadata === 'understated') {
      assert.equal(h.state.audioBlob, null); assert.match(h.get('app-status').textContent, /longer than 10 minutes/);
    } else assert.equal(h.state.audioBlob.type, 'audio/wav', metadata);
    assert.equal(h.state.audioMetadataCancel, null);
    assert.equal(h.revoked.filter(url => h.objectUrls.get(url)?.name === 'recording.webm').length, 1);
  }
});

test('changing accounts cancels metadata work before file read and ignores its late events', async () => {
  let reads = 0, lateMetadata;
  const h = harness(undefined, { audioMetadata: audio => { lateMetadata = audio.listeners.get('loadedmetadata')[0]; } });
  h.updateConfig(hostedConfig); h.window.rehearsalHostedActions.accountChanged('first-user');
  const opening = h.uploadAudio({ name: 'private.wav', size: 10, arrayBuffer() { reads++; throw new Error('Must not read'); } });
  await nextTurn();
  h.window.rehearsalHostedActions.accountChanged('second-user');
  await opening; lateMetadata(); h.flushTimers();
  assert.equal(reads, 0); assert.equal(h.state.audioBlob, null); assert.equal(h.state.busy, false);
  assert.equal(h.state.audioMetadataCancel, null);
  assert.equal(h.revoked.length, 1);
});

test('oversized audio is rejected before metadata loading or file reads', async () => {
  const h = harness();
  await h.uploadAudio({ name: 'oversized.mp3', size: 60 * 1024 * 1024 + 1, arrayBuffer() { throw new Error('Must not read'); } });
  assert.equal(h.createdElements.filter(node => node.tagName === 'AUDIO').length, 0);
  assert.equal(h.objectUrls.size, 0); assert.equal(h.state.busy, false);
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
  h.showPage('history');
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
  h.showPage('history');
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
  h.showPage('history');
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

test('recording and exact microphone selection always request audio only with no camera access', async () => {
  const constraints = [], stream = microphone('Audio only'); stream.track.kind = 'audio';
  const h = harness(undefined, { mediaDevices: { async getUserMedia(options) { constraints.push(options); return stream; } } });
  await h.enableMic('usb-audio'); await h.startRecording();
  h.captureRecordingSamples(new Float32Array(16000), 16000); h.stopRecording();
  assert.equal(constraints.length, 1); assert.equal(constraints[0].video, false);
  assert.equal(constraints[0].audio.channelCount, 1); assert.equal(constraints[0].audio.deviceId.exact, 'usb-audio');
  assert.equal(h.state.audioBlob.type, 'audio/wav');
  assert.equal(inspectWav(Buffer.from(await h.state.audioBlob.arrayBuffer())).durationSeconds, 1);
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

test('concurrent transcription requests share one service operation and cache the transcript', async () => {
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

test('changing the transcription service rebuilds the transcript while preserving audio and its browser save', async () => {
  let recognitions = 0;
  const h = harness(async path => {
    assert.equal(path, '/api/transcribe');
    return { text: ++recognitions === 1 ? 'Previously recognized words.' : 'Current service recognized different words.', durationSeconds: 4 };
  });
  h.state.config.transcriptionModel = 'legacy-speech-model';
  const audio = new Blob(['recording'], { type: 'audio/wav' });
  h.setAudio(audio, 4, 'Original'); await settleAudioSaves(h);
  const saved = h.state.audioSave, url = h.state.audioURL;
  await h.ensureTranscript();
  h.state.report = { transcript: h.state.transcriptText };
  h.seekPlayback(2);
  h.updateConfig({ transcriptionModel: TEST_MODEL_ID });
  assert.equal(h.state.audioBlob, audio);
  assert.equal(h.state.audioURL, url);
  assert.equal(h.state.audioSave, saved);
  assert.equal(h.get('playback').currentTime, 2);
  assert.equal(h.state.transcriptText, '');
  assert.equal(h.get('transcript').value, '');
  assert.equal(h.state.report, null);
  assert.equal(h.get('follow-transcript-connect').hidden, false);
  assert.equal(await h.ensureTranscript(), 'Current service recognized different words.');
  assert.equal(recognitions, 2);
  h.updateConfig({ analysisProvider: 'google', analysisConfigured: true });
  assert.equal(await h.ensureTranscript(), 'Current service recognized different words.');
  assert.equal(recognitions, 2, 'changing the coach must preserve the same speech-model transcript');
  assert.equal(h.storageCalls.save.length, 1, 'a model change must not create another saved recording');
  assert.ok(!h.revoked.includes(url));
});

test('changing a speech model aborts old recognition and ignores its late result', async () => {
  const requests = [];
  const h = harness((url, init) => {
    const pending = deferred(); requests.push({ url, init, pending }); return pending.promise;
  });
  h.state.config.transcriptionModel = 'legacy-speech-model';
  const audio = new Blob(['recording'], { type: 'audio/wav' });
  h.setAudio(audio, 4, 'Original');
  const old = h.ensureTranscript();
  const rejected = assert.rejects(old, { name: 'AbortError' });
  h.updateConfig({ transcriptionModel: TEST_MODEL_ID });
  assert.equal(requests[0].init.signal.aborted, true);
  const current = h.ensureTranscript();
  requests[0].pending.resolve({ text: 'Stale recognition result.', durationSeconds: 999 });
  await rejected;
  assert.equal(h.state.transcriptText, '');
  assert.equal(h.state.audioDuration, 4);
  assert.ok(h.state.transcriptPromise, 'the old result cannot clear the new model request');
  requests[1].pending.resolve({ text: 'Current service result.', durationSeconds: 4 });
  assert.equal(await current, 'Current service result.');
  assert.equal(h.state.transcriptModel, TEST_MODEL_ID);
});

test('changing a speech model aborts dependent coaching and restores controls without accepting its late report', async () => {
  const coaching = deferred(); let coachingSignal;
  const h = harness(async (path, options) => {
    if (path === '/api/transcribe') return { text: 'My name is Jordan. Practice helps.', durationSeconds: 4 };
    assert.equal(path, '/api/analyze-text'); coachingSignal = options.signal; return coaching.promise;
  });
  h.state.config.transcriptionModel = 'legacy-speech-model';
  h.setAudio(new Blob(['audio'], { type: 'audio/wav' }), 4, 'Original');
  await h.ensureTranscript();
  const analyzing = h.runAnalysis(); await nextTurn();
  assert.equal(h.state.busy, true);
  h.updateConfig({ transcriptionModel: TEST_MODEL_ID });
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
  h.state.config.transcriptionModel = 'legacy-speech-model';
  const previous = new Blob(['previous'], { type: 'audio/wav' });
  h.setAudio(previous, 4, 'Previous');
  const upload = h.uploadAudio({ name: 'replacement.wav', size: 12, arrayBuffer: async () => new ArrayBuffer(12) });
  await nextTurn();
  assert.equal(h.state.preparingAudio, true);
  assert.equal(h.state.busy, true);
  assert.equal(h.get('cancel-analysis').hidden, true, 'the app must not offer a cancel action that cannot stop decoding');
  h.updateConfig({ transcriptionModel: TEST_MODEL_ID });
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

test('analysis and corrected feedback reuse the replay transcript without repeating recognition', async () => {
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

function exportedTranscript(html) {
  const transcript = parseHTML(html).document.querySelector('.transcript');
  assert.ok(transcript, 'download must contain the transcript');
  transcript.querySelectorAll('.annotation-ref').forEach(reference => reference.remove());
  return transcript.textContent;
}

test('hostile report fields, rubric names and saved captions never reach HTML sinks', async () => {
  const h = harness();
  const hostile = '<img src=x onerror="alert(1)"><svg/onload=alert(1)></style><script>alert(1)</script>';
  const transcript = `Hello. ${hostile} Thank you.`;
  const report = analyzeSpeech({ text: transcript, durationSeconds: 20, targetTalkingPoints: hostile, aiFeedback: {
    thesis: { summary: hostile, clarity: hostile, evidence: [transcript] },
    strengths: [{ text: hostile, evidence: [transcript] }], improvements: [hostile],
    rhetoric: [{ text: hostile, evidence: [transcript] }],
    annotations: [{ quote: hostile, category: 'clarity', comment: hostile }],
    rubric: [{ criterion: 'claim', score: 3, reason: hostile, evidence: [transcript] }],
  } });
  h.window.rehearsalHostedActions.restoreRecording({ ...savedTake('safe-id'), durationSeconds: 4, title: hostile,
    transcript, report: { ...report, transcript, warnings: [hostile], meta: { analysisProviderLabel: hostile }, input: { instructorRubric: hostile, rubricFileName: hostile } } });
  assert.ok(elementText(h.get('annotated-transcript')).includes(hostile));
  assert.ok(elementText(h.get('annotations-notes')).includes(hostile));
  assert.ok(elementText(h.get('report-warnings')).includes(hostile));
  assert.equal(h.get('rubric-file-name').textContent, hostile);
  const record = savedTake('safe-id', '../../' + hostile + '\\evil.html');
  h.state.savedRecordings = [record];
  h.renderSavedRecordings();
  assert.ok(elementText(h.get('saved-recordings-list')).includes(record.caption));
  h.state.audioBlob = record.blob; h.state.audioSave = record;
  await h.downloadCurrentAudio();
  const [link] = clickedDownloads(h);
  assert.match(link.href, /^blob:/); assert.match(link.download, /\.wav$/);
  assert.doesNotMatch(link.download, /[<>:"/\\|?*\u0000-\u001f]/);
  assert.ok(h.createdElements.every(node => !['SCRIPT', 'IMG', 'IFRAME', 'SVG', 'OBJECT', 'EMBED', 'LINK', 'BASE'].includes(node.tagName)));
  for (const node of h.createdElements) assert.ok([...node.attributes.keys()].every(key => !/^on/i.test(key)));
});

test('prototype-shaped provider data cannot alter normalized feedback or browser settings', () => {
  const hostile = JSON.parse('{"__proto__":{"auditPolluted":true},"constructor":{"prototype":{"auditPolluted":true}},"thesis":{"summary":"Meaning","evidence":["My speech."]},"annotations":[{"quote":"My speech.","category":"__proto__","comment":"Danger"}]}');
  const clean = sanitizeAiFeedback(hostile, { text: 'My speech.' });
  assert.equal(clean.thesis.summary, 'Meaning'); assert.equal(clean.annotations.length, 0);
  assert.equal(Object.hasOwn(clean, '__proto__'), false);
  const h = harness(); h.updateConfig(hostile);
  assert.equal(h.state.config.auditPolluted, undefined);
  assert.equal(Object.prototype.auditPolluted, undefined);
});

test('SQL quotes, comments and commands in every text input remain exact strings in coaching data and rendered transcript', async () => {
  const sql = "Robert'); DROP TABLE recordings; -- /* test */ ' OR 1=1; SELECT pg_sleep(10);";
  const fields = [['transcript', 'text'], ['target-script', 'targetScript'], ['target-talking-points', 'targetTalkingPoints'], ['planned-introduction', 'plannedIntroduction'], ['planned-transitions', 'plannedTransitions'], ['instructor-rubric', 'instructorRubric']];
  const sent = [];
  const h = harness(async (path, options) => {
    const input = JSON.parse(options.body); sent.push(input);
    assert.ok(['/api/analyze-text', '/api/prompt-preview'].includes(path));
    return path === '/api/prompt-preview' ? { prompt: JSON.stringify(input) } : analyzeSpeech(input);
  });
  h.updateConfig(hostedConfig);
  for (const [field] of fields) h.get(field).value = sql;
  h.state.rubricFileName = sql;
  await h.loadPromptPreview(); await h.runAnalysis({ corrected: true });
  assert.equal(sent.length, 2);
  for (const input of sent) {
    for (const [, key] of fields) assert.equal(input[key], sql, key);
    assert.equal(input.rubricFileName, sql);
  }
  assert.equal(h.state.report.transcript, sql);
  assert.equal(elementText(h.get('annotated-transcript')), sql);
});

test('1,000 concurrent Analyze and transcript actions share one transcription and one coaching request', async () => {
  const transcription = deferred(), coaching = deferred(), calls = [];
  const h = harness(async path => { calls.push(path); return path === '/api/transcribe' ? transcription.promise : coaching.promise; });
  h.updateConfig(hostedConfig); h.setAudio(new Blob(['audio']), 1, 'Spam test');
  const actions = Array.from({ length: 1000 }, () => h.runAnalysis());
  const transcripts = Array.from({ length: 1000 }, () => h.ensureTranscript());
  assert.deepEqual(calls, ['/api/transcribe']);
  transcription.resolve({ text: 'Um, practice helps.', durationSeconds: 1, recordingId: 'saved' });
  await nextTurn();
  const corrections = Array.from({ length: 1000 }, () => h.runAnalysis({ corrected: true }));
  assert.deepEqual(calls, ['/api/transcribe', '/api/analyze-text']);
  coaching.resolve(analyzeSpeech({ text: 'Um, practice helps.', durationSeconds: 1 }));
  await Promise.all([...actions, ...transcripts, ...corrections]);
  assert.equal(h.state.busy, false);
  await Promise.all(Array.from({ length: 1000 }, () => h.ensureTranscript()));
  assert.equal(calls.length, 2, 'cached transcript actions must not send another request');
});

test('1,000 repeated Record and Stop actions admit one live session, one final upload and one finish', async () => {
  const h = harness(); h.updateConfig({ ...hostedConfig, liveTranscription: true });
  const live = cloudLiveSpeech(h);
  await Promise.all(Array.from({ length: 1000 }, () => h.startRecording()));
  h.captureRecordingSamples(new Float32Array(16000), 16000);
  for (let index = 0; index < 1000; index++) h.stopRecording();
  await h.state.livePromise;
  assert.equal(live.calls.filter(call => call.path === '/live-sessions').length, 1);
  assert.equal(live.sockets.length, 1);
  assert.equal(live.sockets[0].messages.filter(message => message.type === 'start').length, 1);
  assert.equal(live.sockets[0].messages.filter(message => message.type === 'finish').length, 1);
  assert.equal(live.calls.filter(call => call.path.endsWith('/finish')).length, 1);
  assert.equal(live.uploads.length, 1);
});

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

test('selective annotations render through the ending beyond the former twelve-note and hundred-candidate limits', () => {
  const h = harness(), quote = 'Practice makes ideas clearer.';
  const paragraphs = Array.from({ length: 121 }, (_, index) => `${quote} Unmarked context for point ${index + 1}.\n`);
  const text = paragraphs.join('');
  let start = 0;
  const annotations = paragraphs.map((paragraph, index) => {
    const item = { quote, start, end: start + quote.length, category: index === paragraphs.length - 1 ? 'great' : 'thesis', comment: `Point ${index + 1} connects to the central idea.` };
    start += paragraph.length;
    return item;
  });
  const report = { transcript: text, analysis: { method: 'ai', annotations } };
  h.renderAnnotatedTranscript(report);
  assert.equal(h.get('annotations-notes').children.length, paragraphs.length);
  const marks = h.createdElements.filter(node => node.tagName === 'MARK');
  assert.equal(marks.length, paragraphs.length);
  assert.equal(marks.at(-1).id, 'annotation-quote-121');
  assert.equal(marks.at(-1).className, 'annotation-great');
  const segments = h.annotationSegments(text, annotations);
  assert.equal(segments.map(segment => segment.text).join(''), text);
  assert.equal(segments.filter(segment => !segment.annotation).map(segment => segment.text).join(''), paragraphs.map(paragraph => paragraph.slice(quote.length)).join(''));
  const html = h.buildAnnotatedDocument(report), exported = parseHTML(html).document;
  assert.equal(exported.querySelectorAll('.transcript mark').length, paragraphs.length);
  assert.equal(exported.querySelector('.transcript mark:last-of-type').className, 'annotation-great');
  assert.equal(exportedTranscript(html), text);
});

test('legacy impact passages merge into great sentences while needs-work markers stay distinct in the page and export', () => {
  const h = harness();
  const sentences = ['A strong example.', 'A great sentence.', 'One room can change a semester.', 'It is sort of useful.', 'An observed claim.', 'A legacy suggestion.'];
  const text = sentences.join(' ');
  const categories = ['evidence', 'great', 'impact', 'clarity', 'thesis', 'structure'];
  const annotations = sentences.map((sentence, index) => annotation(text, sentence, categories[index]));
  Object.assign(annotations[0], { assessment: 'strength', suggestion: 'Keep this example.' });
  Object.assign(annotations[1], { assessment: 'needs_work' });
  Object.assign(annotations[2], { assessment: 'needs_work' });
  Object.assign(annotations[3], { assessment: 'needs_work', suggestion: 'It gives students a reliable place to study.' });
  Object.assign(annotations[4], { assessment: 'observation' });
  Object.assign(annotations[5], { suggestion: 'A concrete opening.' });
  const expected = ['strength', 'strength', 'strength', 'needs_work', 'observation', 'needs_work'];
  const report = { transcript: text, analysis: { method: 'ai', annotations } };
  h.renderAnnotatedTranscript(report);
  const marks = h.createdElements.filter(node => node.tagName === 'MARK');
  assert.deepEqual(marks.map(node => node.dataset.assessment), expected);
  assert.equal(marks[2].className, 'annotation-great');
  assert.equal(h.createdElements.filter(node => node.className === 'annotation-star').length, 2);
  const html = h.buildAnnotatedDocument(report), exported = parseHTML(html).document;
  assert.deepEqual([...exported.querySelectorAll('.transcript mark')].map(mark => mark.dataset.assessment), expected);
  assert.match(exported.querySelector('style').textContent, /mark\[data-assessment="needs_work"\][^{]*\{background:transparent;text-decoration-line:underline/);
  assert.match(exported.querySelector('style').textContent, /mark\.annotation-great\{[^}]*box-shadow:[^}]*animation:annotation-great-sweep 8s ease-in-out infinite/);
  assert.equal(exported.querySelectorAll('.transcript .annotation-great').length, 2);
  assert.equal(exported.querySelectorAll('.transcript .annotation-star').length, 2);
  assert.doesNotMatch(html, /annotation-impact|Impact sentence/);
  assert.doesNotMatch(appHtml, /annotation-impact|Impact sentence/);
  assert.match(exported.querySelector('style').textContent, /prefers-reduced-motion:reduce/);
  assert.equal(exported.querySelector('.legend-needs-work').textContent, 'Needs work');
  assert.equal(exportedTranscript(html), text);
});

test('great sentences show an accessible star and explanatory note without adding icon text to selected quotes', () => {
  const h = harness(), text = '  Our claim deserves evidence.\n\nCafé volunteers turn small donations into meals.  ';
  const quote = 'Café volunteers turn small donations into meals.';
  const comment = 'This concrete image makes the benefit easy to understand.';
  const annotations = [annotation(text, quote, 'great', comment)];
  const report = { transcript: text, analysis: { method: 'ai', annotations } };
  h.renderAnnotatedTranscript(report);
  assert.equal(h.get('annotation-legend').hidden, false);
  assert.equal(elementText(h.get('annotations-notes').children[0]), `Great sentence: ${comment}`);
  const { document } = parseHTML('<html><body><div id="transcript"></div></body></html>');
  const container = document.getElementById('transcript');
  renderDiscussableTranscript({ document, container, text, segments: h.annotationSegments(text, annotations) });
  const reference = container.querySelector('.annotation-ref'), star = reference.querySelector('.annotation-star');
  assert.equal(star.textContent, '★');
  assert.equal(star.getAttribute('aria-hidden'), 'true');
  assert.equal(reference.getAttribute('aria-label'), 'Read great sentence annotation 1');
  assert.equal(reference.getAttribute('href'), '#annotation-note-1');
  assert.equal(container.querySelector('mark').getAttribute('aria-describedby'), 'annotation-note-1');
  assert.equal(container.querySelector('mark').parentElement.dataset.quote, quote);
  assert.equal(selectedTranscriptQuote(container, { isCollapsed: false, rangeCount: 1, anchorNode: container.firstChild, focusNode: container.lastChild,
    getRangeAt: () => ({ cloneContents: () => container.cloneNode(true) }) }), text.trim());
  const html = h.buildAnnotatedDocument(report), exported = parseHTML(html).document;
  assert.equal(exported.querySelector('.transcript .annotation-star').textContent, '★');
  assert.equal(exported.querySelector('.transcript .annotation-ref').getAttribute('aria-label'), 'Read great sentence annotation 1');
  assert.equal(exported.querySelector('#note-1').textContent, `Great sentence: ${comment}`);
  assert.equal(exportedTranscript(html), text);
  assert.equal(parseHTML(appHtml).document.querySelector('#annotation-legend .annotation-star').parentElement.textContent, '★Great sentence');
});

test('great sentence annotations keep hostile quote and encouragement content inert in the page and download', () => {
  const h = harness(), text = '<img src=x onerror="alert(1)"> Makes a vivid point.';
  const comment = '</li><script>alert("praise")</script> & keep this example.';
  const report = { transcript: text, analysis: { method: 'ai', annotations: [annotation(text, text, 'great', comment)] } };
  h.renderAnnotatedTranscript(report);
  assert.equal(elementText(h.get('annotations-notes').children[0]), `Great sentence: ${comment}`);
  assert.ok(h.createdElements.every(node => !['SCRIPT', 'IMG'].includes(node.tagName)));
  const html = h.buildAnnotatedDocument(report), exported = parseHTML(html).document;
  assert.equal(exported.querySelectorAll('script,img').length, 0);
  assert.equal(exported.querySelector('#note-1').textContent, `Great sentence: ${comment}`);
  assert.equal(exportedTranscript(html), text);
});

function annotationBubbleFixture() {
  const h = harness(), { document, window: domWindow } = parseHTML(appHtml);
  const container = document.getElementById('annotated-transcript'), bubble = document.getElementById('annotation-bubble');
  const text = 'Our plan is sort of useful. It might help students. Volunteers turn donations into meals. One shared room can change a semester.';
  const suggestion = 'Our plan gives students a reliable place to study. <script>example</script>';
  const annotations = [
    { ...annotation(text, 'Our plan is sort of useful. It might help students.', 'clarity', 'The hedging hides the benefit. Name the useful result.'), suggestion },
    annotation(text, 'Volunteers turn donations into meals.', 'great', 'A concrete image connects the action to its benefit.'),
    annotation(text, 'One shared room can change a semester.', 'impact', 'The compact contrast makes your central takeaway memorable.'),
  ];
  const segments = h.annotationSegments(text, annotations);
  renderDiscussableTranscript({ document, container, text, segments });
  let activeElement = document.body;
  Object.defineProperty(document, 'activeElement', { get: () => activeElement });
  for (const element of [bubble, ...container.querySelectorAll('[data-annotation-number]')]) element.focus = () => { activeElement = element; };
  const marks = [...container.querySelectorAll('mark')], references = [...container.querySelectorAll('.annotation-ref')];
  for (const control of [...marks, ...references]) control.getBoundingClientRect = () => ({ left: 350, top: 350, right: 380, bottom: 370, width: 30, height: 20 });
  bubble.getBoundingClientRect = () => ({ width: 340, height: 180 });
  const events = new Map(), discussed = [];
  const window = { innerWidth: 390, innerHeight: 400,
    addEventListener(type, listener) { events.set(type, listener); }, removeEventListener(type) { events.delete(type); } };
  const get = id => document.getElementById(id);
  const controller = createAnnotationPopover({ document, window, container, bubble,
    title: get('annotation-bubble-title'), explanation: get('annotation-bubble-explanation'), suggestion: get('annotation-bubble-suggestion'),
    suggestionSection: get('annotation-bubble-revision'), closeButton: get('annotation-bubble-close'), discussButton: get('annotation-bubble-discuss'), onDiscuss: quote => discussed.push(quote),
    categoryLabel: category => ({ clarity: 'Clarity', great: 'Great sentence' })[category] });
  controller.setAnnotations(segments.filter(segment => segment.annotation).map(segment => segment.annotation));
  const fire = (target, type, props = {}) => {
    const event = new domWindow.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, props); target.dispatchEvent(event); return event;
  };
  return { controller, document, container, bubble, marks, references, get, fire, window, events, discussed, text, suggestion };
}

test('annotation bubble explains and suggests wording, selects every fragment, stays within viewport and returns focus on dismissal', () => {
  const f = annotationBubbleFixture();
  assert.equal(f.controller.open(1, f.marks[0]), true);
  assert.equal(f.bubble.hidden, false);
  assert.equal(f.document.activeElement, f.bubble);
  assert.equal(f.get('annotation-bubble-title').textContent, 'Clarity · Note 1');
  assert.match(f.get('annotation-bubble-explanation').textContent, /hedging hides the benefit/);
  assert.equal(f.get('annotation-bubble-suggestion').textContent, f.suggestion);
  assert.equal(f.get('annotation-bubble-revision').hidden, false);
  assert.equal(f.bubble.querySelector('script'), null, 'suggested wording is inert text');
  assert.equal(f.container.querySelectorAll('mark.is-selected').length, 2, 'both sentence fragments of one annotation are selected');
  assert.equal(f.container.querySelectorAll('[role="button"] [role="button"]').length, 0);
  for (const control of f.container.querySelectorAll('[data-annotation-number="1"]')) assert.equal(control.getAttribute('aria-expanded'), 'true');
  assert.equal(f.bubble.dataset.placement, 'above');
  assert.ok(parseFloat(f.bubble.style.left) >= 12 && parseFloat(f.bubble.style.left) + 340 <= f.window.innerWidth - 12);
  assert.ok(parseFloat(f.bubble.style.top) >= 12 && parseFloat(f.bubble.style.top) + 180 <= f.window.innerHeight - 12);
  const escape = f.fire(f.bubble, 'keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true); assert.equal(f.bubble.hidden, true);
  assert.equal(f.document.activeElement, f.marks[0]);
  assert.equal(f.container.querySelectorAll('.is-selected').length, 0);
  assert.equal(f.marks[0].getAttribute('aria-expanded'), 'false');
  f.controller.open(2, f.references[1]);
  assert.equal(f.get('annotation-bubble-title').textContent, 'Great sentence');
  assert.equal(f.get('annotation-bubble-revision').hidden, true, 'positive or legacy notes do not invent a correction');
  f.fire(f.get('annotation-bubble-close'), 'click');
  assert.equal(f.bubble.hidden, true); assert.equal(f.document.activeElement, f.references[1]);
  f.controller.open(1, f.marks[1]);
  f.fire(f.get('annotation-bubble-discuss'), 'click');
  assert.deepEqual(f.discussed, ['It might help students.']);
  assert.equal(f.bubble.hidden, true);
  f.controller.open(3, f.references[2]);
  assert.equal(f.get('annotation-bubble-title').textContent, 'Great sentence');
  assert.equal(f.get('annotation-bubble-revision').hidden, true);
});

test('multiline annotation bubbles anchor to the final visible line instead of the empty union of line boxes', () => {
  const f = annotationBubbleFixture();
  f.marks[0].getClientRects = () => [
    { left: 230, top: 70, right: 370, bottom: 90, width: 140, height: 20 },
    { left: 40, top: 90, right: 150, bottom: 110, width: 110, height: 20 },
  ];
  f.controller.open(1, f.marks[0]);
  assert.equal(f.bubble.dataset.placement, 'below');
  assert.equal(f.bubble.style.top, '122px');
  assert.equal(f.bubble.style.left, '12px');
  assert.equal(f.bubble.style.getPropertyValue('--annotation-tail-left'), '83px');
});

test('annotation bubble clears on outside interaction, scroll, resize and transcript replacement without affecting original quotes', () => {
  const f = annotationBubbleFixture();
  for (const type of ['pointerdown', 'focusin']) {
    f.controller.open(1, f.marks[0]); f.fire(f.document.body, type);
    assert.equal(f.bubble.hidden, true); assert.equal(f.container.querySelectorAll('.is-selected').length, 0);
  }
  f.controller.open(1, f.marks[0]);
  f.events.get('scroll')({ target: f.get('annotation-bubble-explanation') });
  assert.equal(f.bubble.hidden, false, 'scrolling within the explanation keeps it open');
  f.events.get('scroll')({ target: f.container });
  assert.equal(f.bubble.hidden, true); assert.equal(f.document.activeElement, f.marks[0]);
  f.controller.open(1, f.marks[0]); f.events.get('resize')(); assert.equal(f.bubble.hidden, true);
  f.controller.open(1, f.marks[0]);
  assert.equal(selectedTranscriptQuote(f.container, { isCollapsed: false, rangeCount: 1, anchorNode: f.container.firstChild, focusNode: f.container.lastChild,
    getRangeAt: () => ({ cloneContents: () => f.container.cloneNode(true) }) }), f.text);
  f.controller.setAnnotations([]);
  assert.equal(f.bubble.hidden, true); assert.equal(f.get('annotation-bubble-explanation').textContent, '');
  assert.equal(f.get('annotation-bubble-suggestion').textContent, ''); assert.equal(f.controller.open(1, f.marks[0]), false);
  f.controller.dispose(); assert.equal(f.events.size, 0);
});

test('suggested wording stays separate and safely escaped in notes and downloads without changing analyzed text', () => {
  const h = harness(), text = 'The plan is sort of useful.';
  const suggestion = '<img src=x onerror="alert(1)"> Our plan gives students a reliable place to study.';
  const report = { transcript: text, analysis: { method: 'ai', annotations: [{ ...annotation(text, text, 'clarity', 'Name the useful result.'), suggestion }] } };
  h.renderAnnotatedTranscript(report);
  assert.ok(elementText(h.get('annotations-notes')).includes(`Suggested wording: ${suggestion}`));
  const html = h.buildAnnotatedDocument(report), exported = parseHTML(html).document;
  assert.equal(exportedTranscript(html), text);
  assert.equal(exported.querySelector('.annotation-note-suggestion').textContent, `Suggested wording: ${suggestion}`);
  assert.equal(exported.querySelectorAll('script,img').length, 0);
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
  const marks = h.createdElements.filter(child => child.tagName === 'MARK');
  assert.equal(marks.map(mark => mark.textContent).join(''), quote);
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
    assert.equal(elementText(h.get('annotated-transcript')), text);
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
    return response({ configured: false, speechConfigured: true, analysisConfigured: false, transcriptionModel: TEST_MODEL_ID });
  }, { startup: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.missingIds, []);
  assert.deepEqual(calls, ['/api/config']);
  for (const [id, event] of [
    ['record-button', 'click'], ['pause-recording', 'click'], ['playback-toggle', 'click'],
    ['playback-scrub', 'input'], ['playback-scrub', 'keydown'], ['playback', 'timeupdate'],
    ['transcript', 'input'], ['download-transcript', 'click'], ['analyze-button', 'click'], ['refresh-annotations', 'click'],
  ]) assert.ok(h.get(id).listeners.get(event)?.length, `${id} must bind its ${event} action`);
  assert.notEqual(h.get('app-status').className, 'app-status error', 'initial settings must render successfully');
});

test('header Update feedback refreshes a saved result using current edits and shares busy and empty-transcript guards', async () => {
  const requests = [], pending = deferred();
  const h = harness(async (path, options) => {
    if (path === '/api/config') return hostedConfig;
    requests.push({ path, input: JSON.parse(options.body) });
    assert.equal(path, '/api/analyze-text', 'refreshing feedback must reuse the transcript without transcribing audio');
    return pending.promise;
  }, { startup: true });
  await nextTurn();
  for (const id of ['reanalyze-button', 'refresh-annotations']) assert.equal(h.get(id).disabled, true);
  const original = 'A saved rehearsal with an earlier review.';
  const report = { ...analyzeSpeech({ text: original, durationSeconds: 15, aiFeedback: { annotations: [{ quote: original, category: 'clarity', comment: 'Make your purpose specific.' }] } }), transcript: original };
  h.window.rehearsalHostedActions.restoreRecording({ ...savedTake('saved-review'), durationSeconds: 15, transcript: original, report });
  assert.equal(h.get('transcript').value, original);
  for (const id of ['reanalyze-button', 'refresh-annotations']) assert.equal(h.get(id).disabled, false, 'saved transcripts can be reviewed again');
  assert.match(h.get('annotation-status').textContent, /Update feedback for a fresh AI review/);
  const corrected = 'Our study group gives students a reliable place to practice.';
  h.get('transcript').value = corrected;
  await h.emitElementEvent('transcript', 'input');
  const updating = h.get('refresh-annotations').click();
  assert.equal(requests.length, 1); assert.equal(requests[0].input.text, corrected);
  for (const id of ['reanalyze-button', 'refresh-annotations']) assert.equal(h.get(id).disabled, true);
  pending.resolve(analyzeSpeech({ text: corrected, durationSeconds: 15 }));
  await updating;
  assert.equal(h.state.report.transcript, corrected);
  for (const id of ['reanalyze-button', 'refresh-annotations']) assert.equal(h.get(id).disabled, false);
  h.state.rubricLoading = true; h.setBusy(false);
  for (const id of ['reanalyze-button', 'refresh-annotations']) assert.equal(h.get(id).disabled, true);
  h.state.rubricLoading = false;
  h.get('transcript').value = '   ';
  await h.emitElementEvent('transcript', 'input');
  for (const id of ['reanalyze-button', 'refresh-annotations']) assert.equal(h.get(id).disabled, true);
});

test('transcription progress and cancellation reach the recording service', async () => {
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
  h.emitProgress('Preparing the saved recording…');
  assert.equal(h.get('follow-transcript-status').textContent, 'Preparing the saved recording…');
  assert.equal(h.get('cancel-analysis').hidden, false);
  h.get('cancel-analysis').listeners.get('click')[0]();
  assert.equal(transcriptionSignal.aborted, false, 'the first click only opens confirmation');
  await h.confirmCancelRestart();
  assert.equal(transcriptionSignal.aborted, true);
  pending.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(h.get('cancel-analysis').hidden, true);
  assert.equal(h.state.audioBlob, null);
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

test('static entrypoint is subdirectory-safe and uses live transcription without model downloads', () => {
  assert.match(appHtml, /<script type="module" src="\.\/bootstrap\.js"><\/script>/);
  assert.match(appHtml, /href="\.\/styles\.css"/);
  assert.match(appHtml, /href="\.\/" aria-label="Neeley Dress Rehearsal home"/);
  assert.doesNotMatch(appHtml, /Bark|Hugging Face|703 MB|settings-dialog|analysis-api-key|transcription-model/);
  assert.match(appHtml, /Your words appear here as you speak/);
  assert.doesNotMatch(appHtml, /whisper/i);
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
  for (const id of ['personal-details', 'transitions-details', 'rubric-details', 'assignment-details']) {
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
  const assignment = `  Assignment directions:\n${'Explain the proposal and audience. '.repeat(1100)}\nFINAL REQUIREMENT  `;
  h.get('assignment-instructions').value = assignment;
  h.state.assignmentFileName = 'Presentation assignment.docx';
  h.get('personal-details').open = false;
  h.get('transitions-details').open = false;
  h.get('rubric-details').open = false;
  h.get('assignment-details').open = false;
  assert.equal(await h.loadPromptPreview(), 'Context included');
  assert.equal(payload.plannedIntroduction, introduction);
  assert.ok(!Object.hasOwn(payload, 'speakerName'));
  assert.equal(payload.plannedTransitions, transitions);
  assert.equal(payload.instructorRubric, rubric);
  assert.equal(payload.rubricFileName, 'Course rubric.pdf');
  assert.equal(payload.assignmentInstructions, assignment);
  assert.equal(payload.assignmentFileName, 'Presentation assignment.docx');
  assert.equal(h.getChatContext().context.assignmentInstructions, assignment);
  assert.equal(h.getChatContext().context.assignmentFileName, 'Presentation assignment.docx');
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

function previewFixture(pages = 2) {
  return {
    kind: 'pdf', name: 'rubric.pdf', pageCount: pages, warnings: [], renders: [], disposed: 0,
    async render(index, container, width) { this.renders.push({ index, container, width }); container.textContent = `Actual page ${index + 1}`; },
    dispose() { this.disposed++; },
  };
}

test('rubric visual preview and page navigation work locally without a coaching request', async () => {
  let requests = 0;
  const preview = previewFixture(3);
  const h = harness(async () => { requests++; }, {
    extractRubric: async () => ({ text: 'Criterion\tExcellent\tNeeds work', name: 'rubric.pdf' }),
    prepareRubricPreview: async () => preview,
  });
  await h.importRubric({ name: 'rubric.pdf', size: 120 });
  assert.equal(h.get('rubric-preview-card').hidden, false);
  assert.equal(h.get('rubric-thumbnail').textContent, 'Actual page 1');
  assert.equal(h.get('rubric-text-details').open, false, 'extracted text is secondary to the page preview');
  await h.openRubricPreview();
  assert.equal(h.get('rubric-preview-dialog').open, true);
  assert.equal(h.get('rubric-page-previous').disabled, true);
  await h.showRubricPage(99);
  assert.equal(h.get('rubric-page-label').textContent, 'Page 3 of 3');
  assert.equal(h.get('rubric-page-next').disabled, true);
  assert.equal(h.get('rubric-document-page').textContent, 'Actual page 3');
  assert.equal(h.get('rubric-thumbnail').textContent, 'Actual page 1');
  assert.equal(requests, 0);
  h.removeRubric();
  assert.equal(preview.disposed, 1);
  assert.equal(h.get('rubric-preview-dialog').open, false);
  assert.equal(h.get('rubric-preview-card').hidden, true);
  assert.equal(h.get('rubric-thumbnail').textContent, '');
});

test('scanned rubric remains visible when text extraction cannot read it', async () => {
  const preview = previewFixture(1);
  const h = harness(undefined, {
    extractRubric: async () => { throw new Error('This scanned page needs pasted rubric text.'); },
    prepareRubricPreview: async () => preview,
  });
  await h.importRubric({ name: 'scan.pdf', size: 100 });
  assert.equal(h.state.rubricFileName, 'scan.pdf');
  assert.equal(h.get('rubric-preview-card').hidden, false);
  assert.equal(h.get('rubric-text-details').open, true);
  assert.match(h.get('rubric-status').textContent, /preview is ready.*pasted rubric text/);
  assert.equal(h.get('instructor-rubric').value, '');
  assert.equal(h.state.rubricLoading, false);
});

test('replaced and removed previews dispose late results without changing the current document', async () => {
  const pending = deferred(), old = previewFixture(), current = previewFixture(1);
  let signal;
  const h = harness(undefined, {
    extractRubric: async file => ({ name: file.name, text: file.name }),
    prepareRubricPreview: (file, options) => { if (file.name === 'old.pdf') { signal = options.signal; return pending.promise; } return current; },
  });
  const importing = h.importRubric({ name: 'old.pdf', size: 100 });
  await h.importRubric({ name: 'new.pdf', size: 100 });
  assert.equal(signal.aborted, true);
  pending.resolve(old); await importing;
  assert.equal(old.disposed, 1);
  assert.equal(old.renders.length, 0);
  assert.equal(h.state.rubricPreview, current);
  assert.equal(h.state.rubricFileName, 'new.pdf');
  assert.equal(h.get('instructor-rubric').value, 'new.pdf');
  h.removeRubric();
  assert.equal(current.disposed, 1);
});

test('account changes and leaving the page dispose private document previews', async () => {
  const preview = previewFixture();
  const h = harness(undefined, { startup: true, extractRubric: async () => ({ text: 'Private criteria' }), prepareRubricPreview: async () => preview });
  await h.importRubric({ name: 'private.pdf', size: 100 });
  h.window.rehearsalHostedActions.accountChanged('another-account');
  assert.equal(preview.disposed, 1);
  assert.equal(h.state.rubricPreview, null);
  assert.equal(h.get('rubric-thumbnail').textContent, '');
  assert.equal(h.get('instructor-rubric').value, '');
  const next = previewFixture(); h.window.rehearsalDocuments.prepareRubricPreview = async () => next;
  await h.importRubric({ name: 'next.pdf', size: 100 });
  await h.emitWindowEvent('pagehide', { persisted: true });
  assert.equal(next.disposed, 0, 'back-forward cache keeps its document');
  await h.emitWindowEvent('pagehide', { persisted: false });
  assert.equal(next.disposed, 1);
});

test('restoring saved rubric text clears the preview of a different document', async () => {
  const preview = previewFixture();
  const h = harness(undefined, { extractRubric: async () => ({ text: 'Current criteria' }), prepareRubricPreview: async () => preview });
  await h.importRubric({ name: 'current.pdf', size: 100 });
  h.window.rehearsalHostedActions.restoreRecording({ id: 'saved', blob: new Blob(['audio']), durationSeconds: 20, report: { input: { instructorRubric: 'Saved criteria', rubricFileName: 'saved.pdf' } } });
  assert.equal(preview.disposed, 1);
  assert.equal(h.get('rubric-preview-card').hidden, true);
  assert.equal(h.get('instructor-rubric').value, 'Saved criteria');
  assert.match(h.get('rubric-status').textContent, /original file/);
});

test('preparation attachments are independent optional disclosures and the idle title says Begin recording', () => {
  for (const title of ['Make it personal', 'Add transitions', 'Add rubric', 'Attach assignment instructions']) {
    assert.ok(appHtml.includes(`<summary>${title} <span class="optional-inline">(optional)</span>`));
  }
  assert.ok(appHtml.indexOf('id="assignment-details"') > appHtml.indexOf('id="rubric-details"'));
  assert.match(appHtml, /id="assignment-instructions" maxlength="40000"/);
  assert.match(appHtml, /id="record-title">Begin recording<\/h2>/);
  assert.doesNotMatch(appSource + appHtml, /The floor is yours/);
  const h = harness(); h.discardAudio();
  assert.equal(h.get('record-title').textContent, 'Begin recording');
  assert.equal(h.analysisInput('Speech').assignmentInstructions, '');
  assert.equal(h.analysisInput('Speech').assignmentFileName, '');
});

test('simultaneous rubric and assignment imports keep independent previews and share only the loading gate', async () => {
  const rubric = deferred(), assignment = deferred(), previews = { 'rubric.pdf': previewFixture(2), 'assignment.docx': previewFixture(3) };
  let calls = 0;
  const h = harness(async () => { calls++; throw new Error('Incomplete context must not be sent'); }, {
    extractRubric: file => file.name === 'rubric.pdf' ? rubric.promise : assignment.promise,
    prepareRubricPreview: async file => previews[file.name],
  });
  h.get('transcript').value = 'My completed speech.';
  const importingRubric = h.importRubric({ name: 'rubric.pdf', size: 100 });
  const importingAssignment = h.importAssignment({ name: 'assignment.docx', size: 100 });
  rubric.resolve({ text: 'Use specific evidence', name: 'rubric.pdf' }); await importingRubric;
  assert.equal(h.get('instructor-rubric').value, 'Use specific evidence');
  assert.equal(h.state.rubricLoading, false); assert.equal(h.state.assignmentLoading, true);
  assert.equal(h.get('analyze-button').disabled, true);
  await h.runAnalysis({ corrected: true }); assert.equal(await h.loadPromptPreview(), '');
  assert.throws(() => h.getChatContext(), { code: 'DOCUMENTS_LOADING' }); assert.equal(calls, 0);
  assignment.resolve({ text: '  Propose a feasible solution.\nFive minute limit.  ', name: 'assignment.docx' }); await importingAssignment;
  assert.equal(h.get('analyze-button').disabled, false);
  assert.equal(h.get('assignment-instructions').value, '  Propose a feasible solution.\nFive minute limit.  ');
  assert.equal(h.get('instructor-rubric').value, 'Use specific evidence');
  await h.preparationDocuments.assignment.openPreview(); await h.preparationDocuments.assignment.showPage(2);
  assert.equal(h.get('assignment-page-label').textContent, 'Page 3 of 3');
  assert.equal(h.get('assignment-document-page').textContent, 'Actual page 3');
  assert.equal(h.get('rubric-thumbnail').textContent, 'Actual page 1');
  h.removeAssignment();
  assert.equal(previews['assignment.docx'].disposed, 1); assert.equal(previews['rubric.pdf'].disposed, 0);
  assert.equal(h.get('instructor-rubric').value, 'Use specific evidence');
  assert.equal(h.state.rubricFileName, 'rubric.pdf');
  assert.equal(h.getChatContext().context.assignmentInstructions, '');
  assert.equal(h.getChatContext().context.assignmentFileName, '');
  assert.equal(calls, 0);
});

test('scanned assignment keeps its preview and supports an editable text fallback without rubric labels', async () => {
  const preview = previewFixture(1);
  const h = harness(undefined, { startup: true,
    extractRubric: async () => { throw Object.assign(new Error('Rubric text is unavailable.'), { code: 'RUBRIC_NO_TEXT' }); },
    prepareRubricPreview: async () => preview,
  });
  h.get('instructor-rubric').value = 'Existing criteria'; h.state.rubricFileName = 'rubric.txt';
  await h.importAssignment({ name: 'scanned-assignment.pdf', size: 100 });
  assert.equal(h.get('assignment-preview-card').hidden, false);
  assert.equal(h.get('assignment-text-details').open, true);
  assert.match(h.get('assignment-status').textContent, /preview is ready.*assignment instructions/);
  assert.doesNotMatch(h.get('assignment-status').textContent, /rubric/i);
  h.get('assignment-instructions').value = 'Use three sources and recommend one solution.';
  await h.emitElementEvent('assignment-instructions', 'input');
  assert.equal(h.analysisInput('Speech').assignmentInstructions, 'Use three sources and recommend one solution.');
  assert.equal(h.getChatContext().context.assignmentFileName, 'scanned-assignment.pdf');
  assert.equal(h.get('instructor-rubric').value, 'Existing criteria');
  assert.equal(preview.disposed, 0, 'editing extracted text retains the original visual');
  h.get('assignment-instructions').value = ''; await h.emitElementEvent('assignment-instructions', 'input');
  assert.equal(h.getChatContext().context.assignmentFileName, '');
  assert.equal(h.analysisInput('Speech').assignmentFileName, '');
  await h.importAssignment({ name: 'invalid.doc', size: 100 });
  assert.match(h.get('assignment-status').textContent, /PDF, DOCX, or TXT/);
  assert.doesNotMatch(h.get('assignment-status').textContent, /rubric/i);
  assert.equal(h.get('instructor-rubric').value, 'Existing criteria');
});

test('late assignment extraction and preview cannot restore removed or replaced instructions', async () => {
  const oldText = deferred(), oldPreview = deferred(), old = previewFixture(), current = previewFixture();
  let oldSignal;
  const h = harness(undefined, {
    extractRubric: file => file.name === 'old.pdf' ? oldText.promise : Promise.resolve({ text: 'Current instructions', name: file.name }),
    prepareRubricPreview: (file, options) => { if (file.name === 'old.pdf') { oldSignal = options.signal; return oldPreview.promise; } return Promise.resolve(current); },
  });
  const pending = h.importAssignment({ name: 'old.pdf', size: 100 });
  await h.importAssignment({ name: 'current.docx', size: 100 });
  assert.equal(oldSignal.aborted, true);
  oldText.resolve({ text: 'Old instructions', name: 'old.pdf' }); oldPreview.resolve(old); await pending;
  assert.equal(h.get('assignment-instructions').value, 'Current instructions');
  assert.equal(h.state.assignmentPreview, current); assert.equal(old.disposed, 1); assert.equal(old.renders.length, 0);
  h.removeAssignment(); assert.equal(current.disposed, 1);
  assert.equal(h.state.assignmentFileName, ''); assert.equal(h.state.assignmentLoading, false);
});

test('account changes and page exit clear assignment text and cancel stale private attachment work', async () => {
  const pending = deferred(), preview = previewFixture(), late = previewFixture();
  let signal;
  const h = harness(undefined, { startup: true,
    extractRubric: file => file.name === 'pending.pdf' ? pending.promise : Promise.resolve({ text: 'Private assignment', name: file.name }),
    prepareRubricPreview: async (file, options) => { signal = options.signal; return file.name === 'pending.pdf' ? late : preview; },
  });
  await h.importAssignment({ name: 'private.pdf', size: 100 });
  h.window.rehearsalHostedActions.accountChanged('next-user');
  assert.equal(signal.aborted, true); assert.equal(preview.disposed, 1);
  assert.equal(h.get('assignment-instructions').value, ''); assert.equal(h.state.assignmentFileName, '');
  assert.equal(h.getChatContext().context.assignmentInstructions, '');
  const importing = h.importAssignment({ name: 'pending.pdf', size: 100 });
  await Promise.resolve(); h.window.rehearsalHostedActions.accountChanged('third-user');
  pending.resolve({ text: 'Late private instructions', name: 'pending.pdf' }); await importing;
  assert.equal(signal.aborted, true); assert.equal(h.get('assignment-instructions').value, '');
  const after = previewFixture(); h.window.rehearsalDocuments.prepareRubricPreview = async () => after;
  await h.importAssignment({ name: 'after.pdf', size: 100 });
  await h.emitWindowEvent('pagehide', { persisted: false }); assert.equal(after.disposed, 1);
});

test('300 attachment replacements, removals, and account changes abort both parsers and never restore stale private content', async () => {
  let active = 0, peak = 0, canceled = 0, calls = 0;
  const signals = [], previews = [], pending = [];
  const h = harness(async () => { calls++; }, {
    extractRubric(_file, { signal }) {
      signals.push(signal); peak = Math.max(peak, ++active);
      return new Promise((_resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); active--; canceled++; reject(new DOMException('Canceled', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true });
      });
    },
    async prepareRubricPreview() { const preview = previewFixture(); previews.push(preview); return preview; },
  });
  for (let index = 0; index < 300; index++) {
    pending.push((index % 2 ? h.importAssignment : h.importRubric)({ name: `private-${index}.pdf`, size: 100 }));
    if (index % 7 === 0) h.removeAssignment();
    if (index % 11 === 0) h.removeRubric();
    if (index % 19 === 0) h.window.rehearsalHostedActions.accountChanged(`account-${index}`);
    if (index % 5 === 0) await Promise.resolve();
  }
  h.removeRubric(); h.removeAssignment(); await Promise.all(pending);
  assert.equal(canceled, 300); assert.equal(active, 0); assert.ok(peak <= 2, 'at most the two current attachments may be read');
  assert.ok(signals.every(signal => signal.aborted)); assert.ok(previews.every(preview => preview.disposed >= 1));
  assert.equal(h.get('instructor-rubric').value, ''); assert.equal(h.get('assignment-instructions').value, '');
  assert.equal(h.get('rubric-thumbnail').textContent, ''); assert.equal(h.get('assignment-thumbnail').textContent, '');
  assert.equal(h.state.rubricPreview, null); assert.equal(h.state.assignmentPreview, null); assert.equal(calls, 0);
});

test('saved feedback restores its assignment snapshot and older feedback clears a different assignment', async () => {
  const preview = previewFixture();
  const h = harness(undefined, { extractRubric: async () => ({ text: 'New instructions' }), prepareRubricPreview: async () => preview });
  await h.importAssignment({ name: 'new.pdf', size: 100 });
  const saved = { id: 'saved', blob: new Blob(['audio']), durationSeconds: 20, report: { input: { instructorRubric: 'Saved criteria', rubricFileName: 'saved-rubric.pdf', assignmentInstructions: 'Saved assignment requirements', assignmentFileName: 'saved-assignment.docx' } } };
  h.window.rehearsalHostedActions.restoreRecording(saved);
  assert.equal(preview.disposed, 1); assert.equal(h.get('assignment-preview-card').hidden, true);
  assert.equal(h.get('assignment-instructions').value, 'Saved assignment requirements');
  assert.equal(h.state.assignmentFileName, 'saved-assignment.docx');
  assert.equal(h.getChatContext().context.assignmentInstructions, 'Saved assignment requirements');
  assert.equal(h.get('instructor-rubric').value, 'Saved criteria');
  assert.match(h.get('assignment-status').textContent, /original file/);
  h.window.rehearsalHostedActions.restoreRecording({ ...saved, report: { input: { instructorRubric: 'Older criteria' } } });
  assert.equal(h.get('assignment-instructions').value, ''); assert.equal(h.state.assignmentFileName, '');
  assert.equal(h.get('instructor-rubric').value, 'Older criteria');
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
  h.get('assignment-instructions').value = 'Present a feasible recommendation in five minutes.';
  h.state.assignmentFileName = 'assignment.docx';
  const analyzing = h.runAnalysis({ corrected: true });
  h.get('planned-introduction').value = ''; h.get('planned-transitions').value = ''; h.removeRubric(); h.removeAssignment();
  pending.resolve({ transcript: submitted.text, wordStats: {}, blunders: {}, analysis: {} });
  await analyzing;
  assert.equal(h.state.report.input.instructorRubric, 'Provide clear evidence.');
  assert.equal(h.state.report.input.plannedIntroduction, 'Picture your first day on campus.');
  assert.equal(h.state.report.input.plannedTransitions, 'Next, consider the evidence.');
  assert.equal(h.state.report.input.rubricFileName, 'instructor.txt');
  assert.equal(h.state.report.input.assignmentInstructions, 'Present a feasible recommendation in five minutes.');
  assert.equal(h.state.report.input.assignmentFileName, 'assignment.docx');
  assert.equal(h.get('report-rubric-badge').hidden, false);
  assert.equal(h.get('report-assignment-badge').hidden, false);
  assert.equal(h.get('report-transitions-badge').hidden, false);
  assert.equal(h.analysisInput('Next rehearsal.').instructorRubric, '');
  assert.equal(h.analysisInput('Next rehearsal.').assignmentInstructions, '');
  assert.equal(h.getChatContext().context.assignmentInstructions, '');
});

test('account setup never sends transcript data and enabling coaching reuses corrected text', async () => {
  const requests = []; let connected = false, accountOpened = 0;
  const h = harness(async (path, options) => {
    if (path === '/api/config') return { ...hostedConfig, analysisConfigured: false };
    requests.push(path);
    if (path === '/api/transcribe') return { text: 'Practice improves clarity.', durationSeconds: 4, recordingId: 'saved-id' };
    assert.equal(path, '/api/analyze-text');
    const input = JSON.parse(options.body);
    return { transcript: input.text, meta: { coachingStatus: connected ? 'complete' : 'not_connected' },
      analysis: connected ? { method: 'ai', overallRating: 82, annotations: [annotation(input.text, input.text)] } : { method: 'rules' } };
  }, { startup: true });
  h.window.rehearsalAccount = { open() { accountOpened++; }, track() {}, refreshHistory() {} };
  await nextTurn();
  h.setAudio(new Blob(['audio']), 4, 'Existing take'); await h.runAnalysis();
  assert.equal(h.get('speech-analysis-content').hidden, true);
  const before = requests.length; await h.get('coaching-action').click();
  assert.equal(accountOpened, 1); assert.equal(requests.length, before);
  connected = true; h.updateConfig({ analysisConfigured: true });
  h.get('transcript').value = 'Corrected words about rehearsal.';
  await h.get('coaching-action').click();
  assert.equal(requests.filter(path => path === '/api/transcribe').length, 1);
  assert.equal(h.state.report.transcript, 'Corrected words about rehearsal.');
  assert.equal(h.get('speech-analysis-content').hidden, false);
  assert.equal(elementText(h.get('overall-rating')), '82 / 100');
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
    assert.equal(h.get('coaching-settings').hidden, true);
    assert.match(elementText(h.get('report-warnings')), /Provider quota exhausted/);
    assert.equal(h.get('speech-analysis-content').hidden, true);
    assert.match(h.get('annotation-status').textContent, /did not finish/);
  }
});

test('Codex coaching explains the conversation connection without provider-key controls', () => {
  const h = harness(() => { throw new Error('Opening connection help must not send data'); });
  h.updateConfig({ coachingViaHost: true, analysisConfigured: true, analysisProvider: 'codex', transcriptionModel: TEST_MODEL_ID });
  assert.equal(h.get('connection-label').textContent, 'Codex coaching');
  h.openSettings();
  assert.match(h.get('app-status').textContent, /this Codex conversation/);
  assert.doesNotMatch(appHtml, /analysis-api-key|settings-dialog/);
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
  h.state.config.transcriptionModel = 'legacy-speech-model';
  h.get('transcript').value = 'Manually pasted rehearsal.';
  h.state.transcriptText = 'Manually pasted rehearsal.';
  const report = { transcript: h.state.transcriptText, analysis: { method: 'ai' } };
  h.state.report = report;
  h.updateConfig({ coachingViaHost: true, analysisConfigured: true, analysisProvider: 'codex', transcriptionModel: TEST_MODEL_ID });
  assert.equal(h.get('transcript').value, 'Manually pasted rehearsal.');
  assert.equal(h.state.transcriptText, 'Manually pasted rehearsal.');
  assert.equal(h.state.report, report);
  assert.equal(h.state.config.transcriptionModel, TEST_MODEL_ID);
});

const timelineStates = h => h.get('processing-steps').children.map(step => step.dataset.state);
test('cloud progress follows real request events and keeps transcription completion separate from coaching', async () => {
  const transcript = deferred(), coaching = deferred(), callbacks = {};
  const h = harness((path, options) => { callbacks[path] = options.onProgress; return path === '/api/transcribe' ? transcript.promise : coaching.promise; });
  Object.assign(h.state.config, hostedConfig); h.setAudio(new Blob(['audio']), 4, 'Progress fixture');
  const processing = h.runAnalysis();
  assert.deepEqual(timelineStates(h), ['current', 'waiting', 'waiting', 'waiting', 'waiting']);
  const speech = callbacks['/api/transcribe'];
  speech({ type: 'progress', stage: 'speech_requested' });
  assert.deepEqual(timelineStates(h), ['complete', 'current', 'waiting', 'waiting', 'waiting']);
  speech({ type: 'progress', stage: 'saved' });
  assert.deepEqual(timelineStates(h), ['complete', 'complete', 'waiting', 'waiting', 'waiting']);
  transcript.resolve({ text: 'Practice improves clarity.', durationSeconds: 4, recordingId: 'owned' }); await nextTurn();
  const coach = callbacks['/api/analyze-text'];
  coach({ type: 'progress', stage: 'accepted' });
  assert.equal(timelineStates(h)[0], 'complete', 'second request cannot reset confirmed transcript progress');
  coach({ type: 'progress', stage: 'coach_requested' });
  assert.equal(timelineStates(h)[2], 'current');
  coach({ type: 'progress', stage: 'feedback_received' });
  assert.equal(timelineStates(h)[3], 'current');
  coach({ type: 'progress', stage: 'feedback_validated' }); coach({ type: 'progress', stage: 'saved' });
  assert.equal(timelineStates(h)[4], 'waiting', 'Ready waits for the actual validated result');
  coaching.resolve({ transcript: 'Practice improves clarity.', analysis: { method: 'ai', overallRating: 80 } }); await processing;
  assert.equal(h.get('processing-progress').dataset.state, 'complete');
  assert.deepEqual(timelineStates(h), Array(5).fill('complete'));
});

test('transcript-only progress has no coaching stages and rejects unknown events', async () => {
  const pending = deferred(); let callback;
  const h = harness((_path, options) => { callback = options.onProgress; return pending.promise; });
  Object.assign(h.state.config, hostedConfig); h.setAudio(new Blob(['audio']), 4, 'Transcript fixture');
  const processing = h.ensureTranscript();
  assert.equal(h.get('processing-steps').children.length, 3);
  const before = h.get('processing-status').textContent;
  callback({ type: 'progress', stage: 'model_thinking', text: '<img src=x onerror=alert(1)>' });
  assert.equal(h.get('processing-status').textContent, before);
  pending.resolve({ text: 'A complete transcript.', durationSeconds: 4, recordingId: 'owned' }); await processing;
  assert.equal(h.get('processing-status').textContent, 'Your transcript is ready.');
  assert.deepEqual(timelineStates(h), ['complete', 'complete', 'complete']);
});

test('existing transcript skips speech stages and partial feedback cannot show all checks complete', async () => {
  const pending = deferred(); let callback;
  const h = harness((path, options) => { assert.equal(path, '/api/analyze-text'); callback = options.onProgress; return pending.promise; });
  Object.assign(h.state.config, hostedConfig); h.get('transcript').value = 'A corrected transcript.';
  const processing = h.runAnalysis({ corrected: true });
  assert.equal(h.get('processing-steps').children.length, 4);
  callback({ type: 'progress', stage: 'cached_result' });
  pending.resolve({ transcript: 'A corrected transcript.', analysis: { method: 'ai', overallRating: null } }); await processing;
  assert.equal(h.get('processing-progress').dataset.state, 'partial');
  assert.equal(timelineStates(h)[2], 'incomplete');
  assert.match(elementText(h.get('processing-steps')), /Feedback ready/);
  assert.match(h.get('processing-status').textContent, /limitations/);
});

test('failure and abort stop timeline activity and ignore late events without claiming server cancellation', async () => {
  for (const abort of [false, true]) {
    const pending = deferred(); let callback;
    const h = harness((_path, options) => { callback = options.onProgress; return pending.promise; });
    Object.assign(h.state.config, hostedConfig); h.setAudio(new Blob(['audio']), 4, 'Cancelled fixture');
    const processing = h.ensureTranscript().catch(error => error);
    callback({ type: 'progress', stage: 'speech_requested' });
    if (abort) h.state.transcriptController.abort();
    pending.reject(Object.assign(new Error(abort ? 'Stopped waiting' : 'Cloud unavailable'), { name: abort ? 'AbortError' : 'Error' })); await processing;
    assert.equal(h.get('processing-progress').dataset.state, abort ? 'cancelled' : 'error');
    assert.ok(!timelineStates(h).includes('current'));
    if (abort) assert.match(h.get('processing-status').textContent, /may still finish/);
    const before = h.get('processing-status').textContent; callback({ type: 'progress', stage: 'saved' });
    assert.equal(h.get('processing-status').textContent, before);
  }
});

test('account changes and new audio hide old progress and ignore late updates', async () => {
  for (const replace of ['account', 'audio']) {
    const pending = deferred(); let callback;
    const h = harness((_path, options) => { callback = options.onProgress; return pending.promise; });
    Object.assign(h.state.config, hostedConfig); h.setAudio(new Blob(['audio']), 4, 'Private fixture');
    const processing = h.ensureTranscript().catch(error => error);
    if (replace === 'account') h.window.rehearsalHostedActions.accountChanged('another-user');
    else h.setAudio(new Blob(['new audio']), 4, 'Replacement');
    assert.equal(h.get('processing-progress').hidden, true);
    callback({ type: 'progress', stage: 'saved' }); pending.resolve({ text: 'Stale private words.', durationSeconds: 4 }); await processing;
    assert.equal(h.get('processing-progress').hidden, true);
    assert.equal(h.state.transcriptText, '');
  }
});

test('elapsed time never fabricates milestones and timers release after completion', () => {
  const h = harness(); let time = 1000, callback, cleared = 0;
  const progress = createProcessingProgress({ container: h.get('processing-progress'), list: h.get('processing-steps'), status: h.get('processing-status'), elapsed: h.get('processing-elapsed'),
    hosted: false, analysis: true, needsTranscript: false, now: () => time, setTimer: value => { callback = value; return 42; }, clearTimer: id => { assert.equal(id, 42); cleared++; } });
  time += 25000; callback();
  assert.equal(h.get('processing-elapsed').textContent, '0:25 elapsed');
  assert.deepEqual(timelineStates(h), ['current', 'waiting']);
  progress.event({ type: 'progress', stage: 'feedback_validated' }, 'coach');
  assert.deepEqual(timelineStates(h), ['current', 'waiting'], 'local mode cannot imply server-confirmed stages');
  progress.finish(); assert.equal(cleared, 1);
  time += 5000; callback(); assert.equal(h.get('processing-elapsed').textContent, '0:25 elapsed');
  assert.match(appHtml, /id="processing-elapsed"[^>]*aria-live="off"/);
});

test('stopping coaching ignores late progress and a late successful payload from a service that ignores abort', async () => {
  const pending = deferred(); let callback;
  const h = harness((_path, options) => { callback = options.onProgress; return pending.promise; });
  Object.assign(h.state.config, hostedConfig); h.get('transcript').value = 'An existing transcript.';
  const processing = h.runAnalysis({ corrected: true });
  callback({ type: 'progress', stage: 'coach_requested' }); h.state.requestController.abort();
  callback({ type: 'progress', stage: 'feedback_validated' });
  pending.resolve({ transcript: 'An existing transcript.', analysis: { method: 'ai', overallRating: 90 } }); await processing;
  assert.equal(h.state.report, null);
  assert.equal(h.get('processing-progress').dataset.state, 'cancelled');
  assert.ok(!timelineStates(h).includes('current'));
  assert.equal(h.state.busy, false);
});

test('refresh recovery locks new work, restores saved transcript, and then releases controls', async () => {
  const h = harness(); h.updateConfig(hostedConfig);
  const pending = deferred(), marker = { recordingId: 'recover-id', kind: 'transcribe' };
  h.window.rehearsalService.getPendingRequest = async () => marker;
  h.window.rehearsalService.recoverPending = async (_marker, options) => { options.onProgress('Still transcribing…'); return pending.promise; };
  h.window.rehearsalHostedActions.accountChanged('first-user');
  const recovery = h.window.rehearsalHostedActions.recoverPending(); await nextTurn();
  assert.equal(h.get('record-button').disabled, true);
  assert.equal(h.window.rehearsalHostedActions.canReplaceAudio(), false);
  assert.equal(h.get('cloud-recovery-message').textContent, 'Still transcribing…');
  pending.resolve({ record: { id: 'recover-id', blob: new Blob(['saved audio']), durationSeconds: 1, transcript: 'Recovered words.' }, message: 'Transcript restored.' });
  await recovery;
  assert.equal(h.state.transcriptText, 'Recovered words.'); assert.equal(h.state.cloudRecordingId, 'recover-id');
  assert.equal(h.get('record-button').disabled, false); assert.equal(h.state.recoveryController, null);
  assert.equal(h.get('cloud-recovery-message').textContent, 'Transcript restored.');
});

test('configuration failure releases the startup lock and its visible retry reconnects before checking pending work', async () => {
  const h = harness(async () => hostedConfig, { startup: true }); await nextTurn();
  let checked = 0, reconnected = 0; const pending = deferred();
  h.window.rehearsalService.getPendingRequest = async () => { checked++; return null; };
  h.window.rehearsalHostedActions.accountChanged('first-user');
  assert.equal(h.get('record-button').disabled, true);
  h.window.rehearsalHostedActions.configurationFailed('Offline');
  assert.equal(h.get('record-button').disabled, false); assert.equal(h.state.recoveryPending, false);
  assert.equal(h.get('cloud-recovery').hidden, false); assert.equal(h.get('cloud-recovery-retry').hidden, false);
  assert.match(h.get('cloud-recovery-message').textContent, /Offline/);
  h.window.rehearsalAccount = { async refresh() {
    reconnected++; await pending.promise;
    h.window.rehearsalHostedActions.configurationReady();
    await h.window.rehearsalHostedActions.recoverPending();
  } };
  const retry = h.get('cloud-recovery-retry').click();
  assert.equal(reconnected, 1); assert.equal(checked, 0); assert.equal(h.get('record-button').disabled, true);
  await h.get('cloud-recovery-retry').click(); assert.equal(reconnected, 1);
  pending.resolve(); await retry;
  assert.equal(checked, 1); assert.equal(h.state.recoveryNeedsConfig, false);
  assert.equal(h.get('cloud-recovery').hidden, true); assert.equal(h.get('record-button').disabled, false);
  assert.equal(h.get('cloud-recovery-retry').disabled, false);
});

test('an old account recovery can never restore private audio, text, report, or preparation after account switch', async () => {
  const h = harness(); h.updateConfig(hostedConfig); const pending = deferred();
  h.window.rehearsalService.getPendingRequest = async () => ({ recordingId: 'private-a', kind: 'coach' });
  let recoverySignal;
  h.window.rehearsalService.recoverPending = async (_marker, { signal }) => { recoverySignal = signal; return pending.promise; };
  h.window.rehearsalHostedActions.accountChanged('first-user');
  const recovery = h.window.rehearsalHostedActions.recoverPending(); await nextTurn();
  h.window.rehearsalHostedActions.accountChanged('second-user');
  assert.equal(recoverySignal.aborted, true);
  pending.resolve({ record: { id: 'private-a', blob: new Blob(['private audio']), durationSeconds: 1, transcript: 'Private words.', report: { private: true, meta: { targetScript: 'Private preparation' } } }, message: 'Private result' });
  await recovery;
  assert.equal(h.state.audioBlob, null); assert.equal(h.state.transcriptText, ''); assert.equal(h.state.report, null);
  assert.equal(h.get('target-script').value, ''); assert.equal(h.get('cloud-recovery').hidden, true);
  assert.notEqual(h.get('cloud-recovery-message').textContent, 'Private result');
});

test('recovery errors show a retry and late results cannot overwrite newer local work', async () => {
  const h = harness(); h.updateConfig(hostedConfig);
  h.window.rehearsalService.getPendingRequest = async () => ({ recordingId: 'recover-id', kind: 'transcribe' });
  h.window.rehearsalService.recoverPending = async () => { throw new Error('Connection unavailable. Retry recovery.'); };
  h.window.rehearsalHostedActions.accountChanged('first-user');
  await h.window.rehearsalHostedActions.recoverPending();
  assert.equal(h.get('cloud-recovery-retry').hidden, false); assert.equal(h.state.busy, false);
  const pending = deferred(); h.window.rehearsalService.recoverPending = () => pending.promise;
  const recovery = h.window.rehearsalHostedActions.recoverPending(); await nextTurn();
  const newer = new Blob(['new take']); h.setAudio(newer, 1, 'New take');
  pending.resolve({ record: { id: 'recover-id', blob: new Blob(['old']), durationSeconds: 1, transcript: 'Old words' }, message: 'Old result' });
  await recovery;
  assert.equal(h.state.audioBlob, newer); assert.equal(h.state.transcriptText, '');
  assert.notEqual(h.get('cloud-recovery-message').textContent, 'Old result');
});

test('history is a separate page that retains preparation and refuses to hide active capture', () => {
  const h = harness();
  h.get('target-script').value = 'Keep this script';
  const chat = { update() {} }; h.state.chat = chat;
  assert.equal(h.showPage('history'), true);
  assert.equal(h.get('rehearse-page').hidden, true);
  assert.equal(h.get('history-page').hidden, false);
  assert.equal(h.get('history-tab').getAttribute('aria-current'), 'page');
  assert.equal(h.document.activeElement, h.get('history-heading'));
  h.showPage('rehearse');
  for (const field of ['recording', 'startingRecording', 'requestingMic', 'preparingAudio', 'recoveryPending', 'cancelRestartPending']) {
    h.state[field] = true;
    assert.equal(h.showPage('history'), false, field);
    assert.equal(h.get('rehearse-page').hidden, false);
    assert.equal(h.state[field], true, 'navigation must not cancel work');
    h.state[field] = false;
  }
  assert.equal(h.get('target-script').value, 'Keep this script');
  assert.equal(h.state.chat, chat);
});

test('new rehearsal preserves the take until confirmed and only navigates after acknowledged cancellation', async () => {
  const h = harness(); h.updateConfig(hostedConfig);
  const blob = new Blob(['current']); h.setAudio(blob, 4, 'Current');
  const saved = savedTake('older'); h.savedRecords.set(saved.id, saved);
  h.get('target-script').value = 'Keep preparation'; h.showPage('history');
  h.startNewRehearsal(); h.closeCancelRestart();
  assert.equal(h.state.audioBlob, blob); assert.equal(h.state.currentPage, 'history');
  h.window.rehearsalService.cancelCurrentRequest = async () => { throw new Error('Offline'); };
  h.startNewRehearsal(); await h.confirmCancelRestart();
  assert.equal(h.state.audioBlob, blob); assert.equal(h.state.currentPage, 'history');
  assert.equal(h.get('cancel-restart-dialog').open, true);
  h.window.rehearsalService.cancelCurrentRequest = async () => ({ cancelled: true });
  await h.confirmCancelRestart();
  assert.equal(h.state.audioBlob, null); assert.equal(h.state.currentPage, 'rehearse');
  assert.equal(h.get('target-script').value, 'Keep preparation');
  assert.equal(h.savedRecords.get(saved.id), saved); assert.equal(h.storageCalls.remove.length, 0);
  assert.equal(h.document.activeElement, h.get('record-button'));
});

test('background feedback and recovery do not navigate or scroll away from history', async () => {
  const pending = deferred(); const h = harness(() => pending.promise);
  h.updateConfig(hostedConfig); h.get('transcript').value = 'A corrected transcript.';
  const analysis = h.runAnalysis({ corrected: true }); await nextTurn();
  h.showPage('history');
  pending.resolve({ transcript: 'A corrected transcript.', analysis: { method: 'ai', overallRating: 80 } });
  await analysis;
  assert.equal(h.state.currentPage, 'history');
  assert.equal(h.get('summary-workspace').scrollCalls || 0, 0);
  const record = { id: 'recovered', blob: new Blob(['saved']), durationSeconds: 4, transcript: 'Recovered words.' };
  h.window.rehearsalHostedActions.restoreRecording(record);
  assert.equal(h.state.currentPage, 'history');
  assert.equal(h.document.activeElement, h.get('history-heading'));
  h.window.rehearsalHostedActions.restoreRecording(record, { showRehearse: true, viewGeneration: h.captureViewGeneration() });
  assert.equal(h.state.currentPage, 'rehearse');
});

test('late history opens cannot replace or navigate after a new rehearsal or tab selection', async () => {
  for (const action of ['new', 'tab']) {
    const pending = deferred(); const h = harness(undefined, { recordings: { get: () => pending.promise } });
    h.showPage('history');
    const token = h.captureViewGeneration();
    const opening = h.openSavedRecording('old');
    if (action === 'new') h.startNewRehearsal(); else h.showPage('rehearse');
    assert.equal(h.isViewGenerationCurrent(token), false);
    pending.resolve(savedTake('old')); await opening;
    assert.equal(h.state.audioBlob, null); assert.equal(h.state.currentPage, 'rehearse');
    assert.equal(h.document.activeElement, h.get(action === 'new' ? 'record-button' : 'rehearse-tab'));
    h.window.rehearsalHostedActions.restoreRecording({ blob: new Blob(['late']), durationSeconds: 4 }, { showRehearse: true, viewGeneration: token });
    assert.equal(h.state.audioBlob, null);
  }
});

test('hash navigation uses the recording guard and preserves query parameters', async () => {
  const h = harness(async () => response({ analysisConfigured: false }), { startup: true }); await nextTurn();
  h.window.location = { pathname: '/practice/', search: '?code=keep', hash: '#history' };
  const urls = []; h.window.history = { replaceState: (_state, _title, url) => urls.push(url) };
  h.state.recording = true; await h.emitWindowEvent('hashchange');
  assert.equal(h.state.currentPage, 'rehearse'); assert.equal(urls.at(-1), '/practice/?code=keep#rehearse');
  h.state.recording = false; await h.emitWindowEvent('hashchange');
  assert.equal(h.state.currentPage, 'history'); assert.equal(urls.at(-1), '/practice/?code=keep#history');
});

test('opening a hosted history link preserves that page while startup recovery runs', async () => {
  const h = harness(async () => response(hostedConfig), { startup: true, hosted: true, initialHash: '#history' });
  assert.equal(h.state.recoveryPending, true);
  assert.equal(h.state.currentPage, 'history');
  assert.equal(h.get('history-page').hidden, false);
  assert.equal(h.get('rehearse-page').hidden, true);
  await nextTurn();
  assert.equal(h.state.currentPage, 'history');
});

test('opening local history cannot cancel a transcript that is still finishing', async () => {
  const h = harness(); const live = { marker: 'finishing' };
  h.state.liveTake = live; h.state.livePromise = Promise.resolve(); h.showPage('history');
  await h.openSavedRecording('old');
  assert.equal(h.storageCalls.get.length, 0); assert.equal(h.state.liveTake, live);
  assert.equal(h.state.currentPage, 'history');
  const pending = deferred(); const late = harness(undefined, { recordings: { get: () => pending.promise } });
  late.showPage('history'); const opening = late.openSavedRecording('old');
  late.state.transcriptPromise = Promise.resolve();
  pending.resolve(savedTake('old')); await opening;
  assert.equal(late.state.audioBlob, null); assert.equal(late.state.currentPage, 'history');
});

test('local history actions unlock when independent transcription settles', async () => {
  const pending = deferred(); const h = harness(() => pending.promise);
  h.setAudio(new Blob(['audio']), 4, 'Current'); await settleAudioSaves(h);
  h.showPage('history');
  const transcript = h.ensureTranscript();
  assert.ok(h.get('saved-recordings-list').querySelectorAll('button').every(button => button.disabled));
  pending.resolve({ text: 'Complete words.' }); await transcript;
  assert.ok(h.get('saved-recordings-list').querySelectorAll('button').every(button => !button.disabled));
  assert.equal(h.state.currentPage, 'history');
});

test('refreshing or deleting a hidden history row cannot move focus out of rehearsal', async () => {
  const pending = deferred(); const h = harness(undefined, { recordings: { remove: () => pending.promise } });
  h.savedRecords.set('old', savedTake('old', 'Old')); h.showPage('history');
  h.get('saved-recordings-details').open = true; await h.refreshSavedRecordings();
  libraryAction(h, 'Old', 'Delete').focus(); const deletion = h.deleteSavedRecording('old');
  h.showPage('rehearse'); pending.resolve(); await deletion; await h.refreshSavedRecordings();
  assert.equal(h.document.activeElement, h.get('rehearse-tab'));
  assert.equal(h.get('history-page').hidden, true);
});

test('cancel and start over requires a separate moved-pointer confirmation and discards capture without autosaving', async () => {
  const h = harness(); h.updateConfig(hostedConfig); let canceled = 0;
  h.window.rehearsalService.cancelCurrentRequest = async () => { canceled++; return { cancelled: true }; };
  await h.enableMic(); await h.startRecording(); h.captureRecordingSamples(new Float32Array(16000), 16000);
  assert.equal(h.get('cancel-recording').hidden, false);
  h.openCancelRestart({ clientX: 100, clientY: 150, detail: 1 });
  assert.equal(h.get('cancel-restart-dialog').open, true);
  assert.equal(h.document.activeElement, h.get('cancel-restart-keep'));
  await h.confirmCancelRestart({ detail: 1 });
  assert.equal(canceled, 0); assert.equal(h.state.recording, true);
  h.state.cancelConfirmation.moved = true;
  await h.confirmCancelRestart({ detail: 1 });
  assert.equal(canceled, 1); assert.equal(h.state.recording, false); assert.equal(h.state.samples.length, 0);
  assert.equal(h.state.audioBlob, null); assert.equal(h.storageCalls.save.length, 0); assert.equal(h.state.stream, null);
  assert.equal(h.get('cancel-restart-dialog').open, false); assert.equal(h.get('record-button').disabled, false);
  assert.equal(h.document.activeElement, h.get('record-button'));
});

test('failed cancellation keeps captured samples paused and requires an acknowledged retry before reset', async () => {
  const h = harness(); h.updateConfig(hostedConfig); let succeed = false;
  h.window.rehearsalService.cancelCurrentRequest = async () => { if (!succeed) throw new Error('Offline'); return { cancelled: true }; };
  await h.enableMic(); await h.startRecording(); h.captureRecordingSamples(new Float32Array(16000), 16000);
  h.openCancelRestart(); await h.confirmCancelRestart();
  assert.equal(h.state.sampleCount, 16000); assert.equal(h.state.recording, true); assert.equal(h.state.recordingPaused, true);
  assert.equal(h.get('cancel-restart-dialog').open, true); assert.match(h.get('cancel-restart-status').textContent, /could not be confirmed/);
  assert.equal(h.get('cancel-restart-confirm').textContent, 'Retry cancellation');
  succeed = true; await h.confirmCancelRestart();
  assert.equal(h.state.sampleCount, 0); assert.equal(h.state.recording, false); assert.equal(h.state.audioBlob, null);
});

test('canceling processing retains saved history, clears current playback, and suppresses late results', async () => {
  const pending = deferred();
  const h = harness(() => pending.promise); h.updateConfig(hostedConfig);
  h.window.rehearsalService.cancelCurrentRequest = async () => ({ cancelled: true });
  const saved = { id: 'existing-saved-take', blob: new Blob(['saved']) }; h.savedRecords.set(saved.id, saved);
  h.setAudio(saved.blob, 1, 'Saved take');
  const processing = h.ensureTranscript().catch(error => error);
  h.openCancelRestart(); await h.confirmCancelRestart();
  pending.resolve({ recordingId: saved.id, text: 'Late result.', durationSeconds: 1 }); await processing;
  assert.equal(h.state.audioBlob, null); assert.equal(h.state.transcriptText, ''); assert.equal(h.state.report, null);
  assert.equal(h.savedRecords.get(saved.id), saved); assert.equal(h.storageCalls.remove.length, 0);
});

test('validated signed-in uploads transcribe automatically without requesting coaching', async () => {
  const calls = [];
  const h = harness(async (path, options) => { calls.push(path); assert.equal(path, '/api/transcribe'); assert.equal(options.body.type, 'audio/wav'); return { text: 'Uploaded speech.', durationSeconds: 1, recordingId: 'uploaded-id' }; }, {
    validateUploadHeader: validateAudioUploadHeader,
    decodeAudioData: async () => ({ duration: 1, sampleRate: 16000, length: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(16000) }),
  });
  h.updateConfig(hostedConfig);
  await h.uploadAudio(new File([Buffer.from('RIFF0000WAVEdata0000')], 'valid.wav', { type: 'audio/wav' }));
  assert.deepEqual(calls, ['/api/transcribe']); assert.equal(h.state.transcriptText, 'Uploaded speech.');
  assert.equal(h.state.cloudRecordingId, 'uploaded-id'); assert.equal(h.state.report, null);
});

test('executable or HTML uploads never reach native decoding, metadata playback, or cloud processing', async () => {
  for (const bytes of ['MZ executable disguised as audio', '<html><script>malicious</script></html>']) {
    let decoded = 0, metadata = 0, sent = 0;
    const h = harness(async () => { sent++; }, { validateUploadHeader: validateAudioUploadHeader,
      audioMetadata: () => { metadata++; }, decodeAudioData: async () => { decoded++; } });
    h.updateConfig(hostedConfig); await h.uploadAudio(new File([bytes], 'recording.wav', { type: 'audio/wav' }));
    assert.equal(decoded, 0); assert.equal(metadata, 0); assert.equal(sent, 0); assert.equal(h.state.audioBlob, null);
    assert.match(h.get('app-status').textContent, /not a supported audio recording/);
  }
});
