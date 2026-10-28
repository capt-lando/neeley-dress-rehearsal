'use strict';

import { createProcessingProgress } from '../lib/processing-progress.mjs';
import { validateAudioUploadHeader } from '../lib/audio-upload-header.mjs';
import { createRehearsalChat } from './rehearsal-chat.js';
import { renderDiscussableTranscript, selectedTranscriptQuote, createAnnotationPopover, annotationAssessment } from '../lib/transcript-discussion.mjs';
import { MAX_TRANSCRIPT_ANNOTATIONS } from '../lib/analysis-core.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  config: { hosted: Boolean(window.rehearsalService?.hosted), configured: false, speechConfigured: false, analysisConfigured: false, analysisProvider: 'openai', providers: [], transcriptionModel: 'gpt-live-transcribe', analysisModel: '', maxDurationSeconds: 600, maxAudioBytes: 20971520 },
  stream: null, context: null, source: null, processor: null, silent: null, analyser: null,
  recording: false, recordingPaused: false, startingRecording: false, recordingSampleRate: 0, requestingMic: false, preparingAudio: false, samples: [], sampleCount: 0, timer: null, meterFrame: null,
  audioBlob: null, audioURL: null, audioDuration: 0, duration: 0, report: null, busy: false, requestController: null,
  inputDevice: '', micGeneration: 0, inputListGeneration: 0, inputsNamed: false, analysisGeneration: 0, promptGeneration: 0,
  audioGeneration: 0, transcriptText: '', transcriptGeneration: -1, transcriptModel: '', transcriptPromise: null, transcriptController: null,
  transcriptionAttempted: false, transcriptWords: [], activeWordIndex: -1, playbackFrame: null, scrubbing: false,
  liveTake: null, livePromise: null, liveFailure: '',
  waveformBars: [], waveformPhase: 0, pendingSeek: null,
  rubricLoading: false, rubricGeneration: 0, rubricFileName: '', rubricPendingName: '', targetView: 'points',
  rubricPreview: null, rubricPreviewController: null, rubricPage: 0, rubricPageGeneration: 0,
  assignmentLoading: false, assignmentGeneration: 0, assignmentFileName: '', assignmentPendingName: '',
  assignmentPreview: null, assignmentPreviewController: null, assignmentPage: 0, assignmentPageGeneration: 0,
  audioSave: null, pendingAudioSaves: new Set(), unsavedRecordings: new Map(), savedRecordings: [], libraryGeneration: 0, libraryOpenGeneration: 0, libraryBusy: false, libraryFocus: null,
  cloudRecordingId: '', accountId: '', recoveryController: null, recoveryPending: Boolean(window.rehearsalService?.hosted), recoveryNeedsConfig: false,
  audioPreparationGeneration: 0, audioMetadataCancel: null, processing: null,
  cancelRestartPending: false, cancelConfirmation: null,
  currentPage: 'rehearse', viewGeneration: 0,
  chat: null, chatContextKey: 0, summaryTranscript: '', transcriptSelectionAttached: false, annotationPopover: null,
};

function getChatContext() {
  if (state.rubricLoading || state.assignmentLoading) throw Object.assign(new Error('Documents are still loading.'), { code: 'DOCUMENTS_LOADING' });
  return {
    ...(state.cloudRecordingId ? { recordingId: state.cloudRecordingId } : {}),
    context: {
      text: state.summaryTranscript,
      targetScript: $('target-script').value, targetTalkingPoints: $('target-talking-points').value,
      plannedIntroduction: $('planned-introduction').value, plannedTransitions: $('planned-transitions').value,
      instructorRubric: $('instructor-rubric').value,
      assignmentInstructions: $('assignment-instructions').value,
      assignmentFileName: $('assignment-instructions').value.trim() ? state.assignmentFileName : '',
      phase: state.recording || state.liveTake ? 'recording' : state.summaryTranscript ? 'review' : 'prepare',
    },
  };
}
function syncChat() {
  state.chat?.update({ available: Boolean(state.config.hosted && state.config.chatConfigured !== false),
    signedIn: Boolean(state.config.auth?.signedIn), identity: state.accountId,
    contextKey: state.chatContextKey, hasTranscript: Boolean(state.summaryTranscript.trim()) });
}
function renderSummaryDraft(text = '', live = false) {
  initializeTranscriptInteractions(); state.annotationPopover.setAnnotations([]);
  state.summaryTranscript = String(text);
  const container = $('annotated-transcript');
  const hasText = Boolean(state.summaryTranscript.trim());
  container.dataset.empty = String(!hasText);
  container.setAttribute('aria-label', 'Rehearsal transcript. Select text to discuss with your coach.');
  if (hasText) renderDiscussableTranscript({ document, container, text: state.summaryTranscript,
    segments: [{ text: state.summaryTranscript, annotation: null }] });
  else container.textContent = 'Your words will appear here as you record.';
  $('annotation-title').textContent = 'Full transcript';
  $('annotation-status').textContent = live
    ? 'Draft words appear as you speak. Annotations begin when you press Analyze.'
    : hasText ? 'Click a sentence or highlight a passage to add it to chat. Press Analyze for annotations.'
      : 'Start a rehearsal to see your transcript. Press Analyze when you are ready for feedback.';
  $('annotation-legend').hidden = true; $('annotations-notes').replaceChildren();
  $('speech-analysis-content').hidden = true; $('analysis-disclaimer').hidden = true; $('coaching-notice').hidden = true;
  $('transcript-details').hidden = !hasText || live; $('prompt-details').hidden = !hasText;
  $('download-transcript').disabled = !hasText;
  syncChat();
}
function attachTranscriptSelection(event = {}) {
  if (event.type === 'click' && state.transcriptSelectionAttached) { event.preventDefault?.(); state.transcriptSelectionAttached = false; return; }
  const container = $('annotated-transcript');
  const selected = event.type === 'keydown' ? '' : selectedTranscriptQuote(container, window.getSelection?.());
  if (selected) {
    state.transcriptSelectionAttached = event.type === 'pointerup';
    state.chat?.selectQuote(selected); return;
  }
  if (event.type === 'pointerup') return;
  const annotation = event.target?.closest?.('[data-annotation-number]');
  if (annotation && container.contains(annotation)) {
    event.preventDefault?.(); state.annotationPopover?.open(annotation.dataset.annotationNumber, annotation); return;
  }
  if (event.target?.closest?.('a')) return;
  const sentence = event.target?.closest?.('.transcript-sentence');
  if (sentence && container.contains(sentence)) {
    state.chat?.selectQuote(sentence.dataset.quote.slice(0, 4000));
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sentence.classList.add('is-attached');
      sentence.addEventListener('animationend', () => sentence.classList.remove('is-attached'), { once: true });
    }
  }
}

function initializeTranscriptInteractions() {
  if (state.annotationPopover) return;
  const container = $('annotated-transcript');
  state.annotationPopover = createAnnotationPopover({ document, window, container,
    bubble: $('annotation-bubble'), title: $('annotation-bubble-title'), explanation: $('annotation-bubble-explanation'),
    suggestion: $('annotation-bubble-suggestion'), suggestionSection: $('annotation-bubble-revision'), closeButton: $('annotation-bubble-close'),
    discussButton: $('annotation-bubble-discuss'), onDiscuss: quote => state.chat?.selectQuote(quote),
    categoryLabel: category => ANNOTATION_LABELS[category] });
  container.addEventListener('pointerdown', () => { state.transcriptSelectionAttached = false; });
  for (const type of ['pointerup', 'click']) container.addEventListener(type, attachTranscriptSelection);
  container.addEventListener('keydown', event => {
    if (event.target?.closest?.('[data-annotation-number]') && ['Enter', ' '].includes(event.key)) {
      event.preventDefault(); if (!event.repeat) attachTranscriptSelection(event);
    }
  });
  container.addEventListener('keyup', event => {
    if (event.target?.closest?.('[data-annotation-number]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); return; }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); attachTranscriptSelection(event); }
    else if (event.shiftKey) attachTranscriptSelection({ type: 'pointerup' });
  });
}

function setStatus(message, type = '') {
  $('app-status').textContent = message;
  $('app-status').className = `app-status ${type}`;
  $('app-status').hidden = !message;
}
function captureViewGeneration() {
  return { view: state.viewGeneration, audio: state.audioGeneration };
}
function isViewGenerationCurrent(token) {
  return token?.view === state.viewGeneration && token?.audio === state.audioGeneration;
}
function updatePageHash() {
  if (window.history?.replaceState && window.location) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search || ''}#${state.currentPage}`);
  }
}
function showPage(page, { focus = true, updateHash = true, initial = false } = {}) {
  const next = page === 'history' ? 'history' : 'rehearse';
  if (next === 'history' && (state.recording || state.startingRecording || state.requestingMic || state.preparingAudio || state.recoveryPending && !initial || state.cancelRestartPending)) {
    setStatus('Finish your current recording or request before opening My saved rehearsals. Your take is still here.');
    updatePageHash();
    return false;
  }
  state.currentPage = next;
  state.annotationPopover?.close();
  state.viewGeneration++;
  state.libraryFocus = null;
  $('rehearse-page').hidden = next !== 'rehearse';
  $('history-page').hidden = next !== 'history';
  for (const name of ['rehearse', 'history']) {
    const tab = $(`${name}-tab`);
    if (name === next) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (updateHash) updatePageHash();
  if (focus) {
    if (next === 'history') $('history-heading').focus({ preventScroll: true });
    else $('rehearse-tab').focus({ preventScroll: true });
    $(`${next}-page`).scrollIntoView({ block: 'start' });
  }
  return true;
}
function startNewRehearsal(event = {}) {
  state.viewGeneration++;
  if (state.audioBlob || state.recording || state.startingRecording || state.requestingMic || state.busy || state.liveTake || state.livePromise || state.recoveryPending || state.cancelRestartPending) {
    openCancelRestart(event);
    if (state.cancelConfirmation) state.cancelConfirmation.showRehearse = true;
    return;
  }
  showPage('rehearse');
  $('record-button').focus({ preventScroll: true });
}
function beginProcessing({ analysis = false, needsTranscript = true, signal } = {}) {
  state.processing?.clear();
  const generation = state.audioGeneration;
  let progress;
  progress = createProcessingProgress({ container: $('processing-progress'), list: $('processing-steps'), status: $('processing-status'), elapsed: $('processing-elapsed'),
    hosted: state.config.hosted, analysis, needsTranscript, signal, setTimer: setInterval, clearTimer: clearInterval, isCurrent: () => state.processing === progress && generation === state.audioGeneration });
  state.processing = progress;
  return progress;
}
function setBusy(busy, message = '') {
  state.busy = busy;
  syncRecordingControls();
  syncCancelControls();
  syncAnalysisControls();
  syncRecordingLibraryControls();
  if (message) setStatus(message, 'busy');
}
function syncRecordingControls() {
  const pending = state.requestingMic || state.startingRecording || state.recoveryPending || state.cancelRestartPending;
  $('record-button').disabled = state.busy || pending;
  $('upload-button').disabled = state.busy || pending || state.recording;
  $('discard-audio').disabled = state.busy || pending || state.recording;
  $('enable-mic').disabled = pending || state.recording;
  $('audio-input').disabled = pending || state.recording;
}
function syncCancelControls() {
  // Audio decoding cannot be interrupted by the browser's decodeAudioData API.
  $('cancel-analysis').hidden = state.preparingAudio || !(state.requestController || state.transcriptController || state.livePromise);
  $('cancel-analysis').textContent = 'Cancel and start over';
  $('cancel-analysis').disabled = state.cancelRestartPending;
  $('cancel-recording').hidden = !(state.recording || state.startingRecording);
  $('cancel-recording').disabled = state.cancelRestartPending;
  $('cloud-recovery-cancel').disabled = state.cancelRestartPending;
}
function syncAnalysisControls() {
  const blocked = state.busy || state.recoveryPending || state.cancelRestartPending || state.rubricLoading || state.assignmentLoading || state.startingRecording || state.recording || state.requestingMic || Boolean(state.liveTake);
  $('analyze-button').disabled = blocked;
  $('reanalyze-button').disabled = blocked;
  $('coaching-action').disabled = blocked;
  $('coaching-settings').disabled = blocked;
  $('analyze-button').textContent = state.busy ? 'Working on your feedback…' : state.rubricLoading || state.assignmentLoading ? 'Reading documents…' : state.liveTake ? 'Finishing your transcript…' : 'Analyze rehearsal ↗';
}
function errorMessage(error) { return error?.message || 'Something went wrong. Please try again.'; }
function openCancelRestart(event = {}) {
  if (state.cancelRestartPending || $('cancel-restart-dialog').open) return;
  state.cancelConfirmation = { account: state.accountId, generation: state.audioGeneration,
    x: event.clientX, y: event.clientY, moved: false };
  $('cancel-restart-status').textContent = '';
  $('cancel-restart-confirm').textContent = 'Yes, cancel and start over';
  $('cancel-restart-dialog').showModal();
  $('cancel-restart-keep').focus();
}
function closeCancelRestart() {
  if (state.cancelRestartPending) return;
  state.cancelConfirmation = null; $('cancel-restart-dialog').close();
}
async function confirmCancelRestart(event = {}) {
  const confirmation = state.cancelConfirmation;
  if (!confirmation || state.cancelRestartPending) return;
  // A repeated click at the original trigger cannot confirm. Keyboard activation
  // is deliberate because the dialog initially focuses the safe Keep working action.
  if (event.detail > 0 && !confirmation.moved) return;
  if (confirmation.account !== state.accountId || confirmation.generation !== state.audioGeneration) { closeCancelRestart(); return; }
  state.cancelRestartPending = true;
  let canceled = false;
  if (state.recording && !state.recordingPaused) toggleRecordingPause();
  state.recoveryController?.abort();
  $('cancel-restart-keep').disabled = true; $('cancel-restart-confirm').disabled = true;
  $('cancel-restart-status').textContent = 'Canceling your request…';
  syncRecordingControls(); syncAnalysisControls(); syncCancelControls();
  try {
    if (state.config.hosted) {
      if (!window.rehearsalService?.cancelCurrentRequest) throw new Error('Cloud cancellation is unavailable. Please retry.');
      const result = await window.rehearsalService.cancelCurrentRequest({ signal: AbortSignal.timeout(30000) });
      if (result?.cancelled !== true) throw new Error('The server did not confirm cancellation.');
    }
    if (confirmation.account !== state.accountId || confirmation.generation !== state.audioGeneration) return;
    state.recording = false; state.recordingPaused = false; state.startingRecording = false;
    state.samples = []; state.sampleCount = 0;
    clearInterval(state.timer); state.timer = null;
    state.audioPreparationGeneration++; state.audioMetadataCancel?.(); state.preparingAudio = false;
    cleanupMic();
    discardAudio(); state.livePromise = null; state.requestController = null;
    state.recoveryController = null; state.recoveryPending = false;
    document.querySelector('.record-panel').classList.remove('recording', 'recording-paused');
    $('mic-icon').removeAttribute('hidden'); $('stop-icon').hidden = true;
    $('pause-recording').hidden = true; $('pause-recording').setAttribute('aria-pressed', 'false');
    $('cloud-recovery').hidden = true;
    setBusy(false);
    state.cancelConfirmation = null; $('cancel-restart-dialog').close();
    setStatus('Canceled. You’re ready to start a new take.');
    canceled = true;
    window.rehearsalAccount?.refreshHistory();
  } catch (error) {
    if (confirmation.account === state.accountId && confirmation.generation === state.audioGeneration) {
      $('cancel-restart-status').textContent = `Cancellation could not be confirmed. Your take is still here${state.recording ? ' and paused' : ''}. ${errorMessage(error)}`;
      $('cancel-restart-confirm').textContent = 'Retry cancellation';
    }
  } finally {
    state.cancelRestartPending = false;
    $('cancel-restart-keep').disabled = false; $('cancel-restart-confirm').disabled = false;
    syncRecordingControls(); syncAnalysisControls(); syncCancelControls(); syncRecordingLibraryControls();
    if (canceled) {
      if (confirmation.showRehearse) showPage('rehearse');
      $('record-button').focus();
    }
  }
}
async function api(path, options = {}) {
  if (!window.rehearsalService?.request) throw new Error('The browser tools have not loaded. Refresh this page and try again.');
  return window.rehearsalService.request(path, options);
}
function textItem(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(textItem).filter(Boolean).join(' · ');
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value.detail || value.text || value.reason || value.advice || value.summary || value.observation || value.description || value.title || JSON.stringify(value);
}
function addText(tag, text, className = '') { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; }
function formatTime(seconds) { const total = Math.max(0, Math.floor(seconds || 0)); return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`; }
function targetMode() {
  const hasScript = Boolean($('target-script').value.trim());
  const hasPoints = Boolean($('target-talking-points').value.trim());
  return hasScript ? (hasPoints ? 'both' : 'script') : 'points';
}
function setTargetView(view) {
  state.targetView = view === 'script' ? 'script' : 'points';
  const scriptVisible = state.targetView === 'script';
  $('full-script-field').hidden = !scriptVisible;
  $('talking-points-field').hidden = scriptVisible;
  $('target-view-script').setAttribute('aria-pressed', String(scriptVisible));
  $('target-view-points').setAttribute('aria-pressed', String(!scriptVisible));
}
function updateTargetHint() {
  const talkingPoints = $('target-talking-points').value.split(/\n/).map((x) => x.trim()).filter(Boolean);
  $('point-count').textContent = `${$('target-script').value.trim().split(/\s+/).filter(Boolean).length} words`;
  $('talking-point-count').textContent = `${talkingPoints.length} ${talkingPoints.length === 1 ? 'point' : 'points'}`;
}
function createPreparationDocument({ key, textId, label, caption }) {
  const el = suffix => $(key + '-' + suffix), textField = () => $(textId);
  const messageForDocument = message => key === 'assignment' ? String(message).replace(/\brubric\b/gi, 'assignment document') : message;
  function updateControls() {
    textField().disabled = state[key + 'Loading'];
    el('file-name').textContent = state[key + 'Loading'] ? state[key + 'PendingName'] : state[key + 'FileName'] || (textField().value.trim() ? `Pasted ${label} text` : 'No file chosen');
    $('remove-' + key).hidden = !state[key + 'Loading'] && !state[key + 'FileName'] && !textField().value;
    syncAnalysisControls();
  }
  function clearPreview() {
    state[key + 'PreviewController']?.abort(); state[key + 'PreviewController'] = null;
    state[key + 'Preview']?.dispose(); state[key + 'Preview'] = null;
    state[key + 'Page'] = 0; state[key + 'PageGeneration']++;
    el('preview-dialog').close();
    el('thumbnail').replaceChildren(); el('document-page').replaceChildren();
    el('preview-card').hidden = true;
    el('preview-meta').textContent = ''; el('preview-warning').textContent = '';
    el('page-status').textContent = '';
  }
  async function showPage(index) {
    const preview = state[key + 'Preview'];
    if (!preview) return;
    const generation = ++state[key + 'PageGeneration'];
    state[key + 'Page'] = Math.max(0, Math.min(preview.pageCount - 1, index));
    el('page-label').textContent = `Page ${state[key + 'Page'] + 1} of ${preview.pageCount}`;
    el('page-previous').disabled = state[key + 'Page'] === 0;
    el('page-next').disabled = state[key + 'Page'] === preview.pageCount - 1;
    el('page-status').textContent = 'Loading page…';
    el('page-status').classList.remove('error');
    el('document-scroll').scrollTop = 0;
    try {
      const availableWidth = el('document-scroll').clientWidth;
      await preview.render(state[key + 'Page'], el('document-page'), availableWidth > 0 ? Math.max(240, Math.min(760, availableWidth - 34)) : 760);
      if (generation === state[key + 'PageGeneration']) el('page-status').textContent = '';
    } catch (error) {
      if (generation !== state[key + 'PageGeneration']) return;
      el('page-status').textContent = `This page could not be shown. ${messageForDocument(errorMessage(error))}`;
      el('page-status').classList.add('error');
    }
  }
  async function openPreview() {
    if (!state[key + 'Preview']) return;
    el('preview-title').textContent = state[key + 'FileName'] || state[key + 'Preview'].name || 'Document preview';
    el('preview-warning').textContent = messageForDocument(state[key + 'Preview'].warnings.join(' '));
    el('preview-dialog').showModal();
    await showPage(state[key + 'Page']);
  }
  function remove() {
    state[key + 'Generation']++;
    clearPreview();
    state[key + 'Loading'] = false; state[key + 'FileName'] = ''; state[key + 'PendingName'] = '';
    textField().value = ''; el('upload').value = '';
    el('status').textContent = `${caption} removed. Upload another file or paste its text below.`;
    el('status').classList.remove('error');
    updateControls(); markPromptStale();
  }
  async function importFile(file) {
    if (!file) return;
    const generation = ++state[key + 'Generation'];
    const replaced = Boolean(state[key + 'FileName'] || textField().value.trim());
    clearPreview();
    const controller = new AbortController(); state[key + 'PreviewController'] = controller;
    state[key + 'Loading'] = true; state[key + 'FileName'] = ''; state[key + 'PendingName'] = file.name || 'Selected file';
    el('text-details').open = false;
    textField().value = '';
    el('status').textContent = `Reading ${state[key + 'PendingName']} on your device…${replaced ? ` The previous ${key} has been removed.` : ''}`;
    el('status').classList.remove('error');
    updateControls(); markPromptStale();
    try {
      if (!/\.(?:pdf|docx|txt)$/i.test(file.name || '')) throw new Error(`Choose a PDF, DOCX, or TXT file. For older DOC files, paste the ${label} text below.`);
      if (file.size > 5 * 1024 * 1024) throw new Error(`Choose a ${key} file of up to 5 MB, or paste the text below.`);
      if ((file.name || '').length > 255) throw new Error('Shorten the filename to 255 characters or fewer, then choose it again.');
      if (!window.rehearsalDocuments?.extractRubric) throw new Error(`The document reader has not loaded. Paste the ${label} text below, or refresh the page.`);
      const previewTask = (async () => {
        if (!window.rehearsalDocuments.prepareRubricPreview) throw new Error('The document preview has not loaded. Refresh the page to try again.');
        const preview = await window.rehearsalDocuments.prepareRubricPreview(file, { signal: controller.signal });
        if (generation !== state[key + 'Generation']) { preview.dispose(); return; }
        state[key + 'Preview'] = preview;
        try { await preview.render(0, el('thumbnail'), 184); }
        catch (error) { if (state[key + 'Preview'] === preview) state[key + 'Preview'] = null; preview.dispose(); throw error; }
        if (generation !== state[key + 'Generation']) { preview.dispose(); return; }
        el('preview-card').hidden = false;
        el('preview-meta').textContent = `${preview.pageCount} ${preview.pageCount === 1 ? 'page' : 'pages'}`;
      })();
      const [extracted, visual] = await Promise.allSettled([window.rehearsalDocuments.extractRubric(file, { signal: controller.signal }), previewTask]);
      if (generation !== state[key + 'Generation']) return;
      if (state[key + 'Preview']) state[key + 'FileName'] = file.name;
      if (extracted.status === 'rejected') throw extracted.reason;
      const result = extracted.value;
      if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error(`No readable ${key} text was found. Paste the text below instead.`);
      if (result.text.length > 40000) throw new Error(`This ${key} has more than 40,000 characters. Paste a shorter version below.`);
      const name = typeof result.name === 'string' ? result.name : file.name;
      if (name.length > 255) throw new Error('Shorten the filename to 255 characters or fewer, then choose it again.');
      state[key + 'FileName'] = name;
      textField().value = result.text;
      el('status').textContent = visual.status === 'fulfilled'
        ? `${caption} ready. Preview stays on your device; coaching uses the extracted text.`
        : `${caption} text is ready. Preview unavailable: ${messageForDocument(errorMessage(visual.reason))}`;
      el('status').classList.toggle('error', visual.status === 'rejected');
      markPromptStale();
    } catch (error) {
      if (generation !== state[key + 'Generation']) return;
      const message = state[key + 'Preview'] && error?.code === 'RUBRIC_NO_TEXT'
        ? `This document has scanned or blank pages. Paste its ${label} text below to include it in coaching.` : messageForDocument(errorMessage(error));
      el('status').textContent = `${state[key + 'Preview'] ? 'Your document preview is ready. ' : ''}${message}${replaced ? ` The previous ${key} is no longer included.` : ''}`;
      el('status').classList.add('error');
      el('text-details').open = true;
    } finally {
      if (generation === state[key + 'Generation']) {
        state[key + 'Loading'] = false; state[key + 'PendingName'] = '';
        el('upload').value = '';
        updateControls();
      }
    }
  }
  function listen() {
    el('upload-button').addEventListener('click', () => el('upload').click());
    el('upload').addEventListener('change', () => importFile(el('upload').files[0]));
    $('remove-' + key).addEventListener('click', () => { remove(); el('upload-button').focus(); });
    el('preview-open').addEventListener('click', openPreview);
    el('preview-close').addEventListener('click', () => el('preview-dialog').close());
    el('page-previous').addEventListener('click', () => showPage(state[key + 'Page'] - 1));
    el('page-next').addEventListener('click', () => showPage(state[key + 'Page'] + 1));
    textField().addEventListener('input', () => {
      el('status').classList.remove('error');
      el('status').textContent = textField().value.trim()
        ? 'This text will be included in coaching, even when this section is closed.'
        : 'No ' + label + ' text is included. Paste its text here or choose a file.';
      updateControls(); markPromptStale();
    });
  }
  return { updateControls, clearPreview, showPage, openPreview, remove, importFile, listen };
}
const preparationDocuments = {
  rubric: createPreparationDocument({ key: 'rubric', textId: 'instructor-rubric', label: 'rubric', caption: 'Rubric' }),
  assignment: createPreparationDocument({ key: 'assignment', textId: 'assignment-instructions', label: 'assignment instructions', caption: 'Assignment instructions' }),
};
function updateRubricControls() { preparationDocuments.rubric.updateControls(); }
function clearRubricPreview() { preparationDocuments.rubric.clearPreview(); }
function showRubricPage(index) { return preparationDocuments.rubric.showPage(index); }
function openRubricPreview() { return preparationDocuments.rubric.openPreview(); }
function removeRubric() { preparationDocuments.rubric.remove(); }
function importRubric(file) { return preparationDocuments.rubric.importFile(file); }
function removeAssignment() { preparationDocuments.assignment.remove(); }
function importAssignment(file) { return preparationDocuments.assignment.importFile(file); }

function updateConfig(config) {
  const previousSpeechModel = state.config.transcriptionModel;
  state.config = { ...state.config, ...config };
  syncChat();
  const manualPanelTranscript = state.config.coachingViaHost && !state.audioBlob && !state.recording && !state.startingRecording;
  if (state.config.transcriptionModel !== previousSpeechModel && !manualPanelTranscript) resetTranscriptForModelChange();
  $('cloud-recordings-details').hidden = !state.config.hosted;
  $('saved-recordings-details').hidden = Boolean(state.config.hosted);
  $('history-privacy').textContent = state.config.hosted ? 'Only available to your signed-in account.' : 'Saved only in this browser.';
  $('connection-label').textContent = state.config.hosted
    ? state.config.auth?.signedIn ? 'My account' : 'Sign in'
    : state.config.coachingViaHost ? 'Codex coaching' : 'Connection unavailable';
  $('settings-open').setAttribute('aria-label', state.config.hosted ? 'Account and privacy settings' : 'Coaching connection');
  $('connection-dot').classList.toggle('connected', state.config.hosted ? Boolean(state.config.auth?.signedIn) : Boolean(state.config.analysisConfigured));
  document.querySelector('.timer-limit').textContent = `/ ${formatTime(state.config.maxDurationSeconds)}`;
  if (state.report) renderCoachingState(state.report);
  if (state.audioBlob && !state.transcriptText && !state.transcriptPromise) showTranscriptReadyState();
}
function resetTranscriptForModelChange() {
  state.processing?.clear();
  const analyzing = Boolean(state.requestController);
  const wasLive = Boolean(state.liveTake);
  cancelLiveSession();
  state.audioGeneration++;
  state.analysisGeneration++;
  state.transcriptController?.abort();
  state.requestController?.abort();
  state.transcriptController = null; state.transcriptPromise = null; state.requestController = null;
  state.transcriptGeneration = -1; state.transcriptModel = ''; state.transcriptText = ''; state.transcriptionAttempted = false;
  state.report = null;
  $('transcript').value = '';
  renderFollowTranscript('');
  $('report').hidden = true;
  state.chat?.selectQuote(''); renderSummaryDraft();
  markPromptStale();
  if (wasLive) showLiveFallback('The transcription service changed. Transcribe the complete recording after you stop.');
  if (analyzing) setBusy(false);
  else syncCancelControls();
}
function providerInfo(id = state.config.analysisProvider) {
  if (id === 'codex' || state.config.coachingViaHost) return { label: 'Codex' };
  const provider = (Array.isArray(state.config.providers) ? state.config.providers : []).find(item => item.id === id);
  return { label: provider?.label || ({ openai: 'OpenAI', hosted: 'AI coach', anthropic: 'Claude', google: 'Gemini' }[id]) || 'AI coach' };
}
function openSettings() {
  if (state.config.hosted) {
    if (window.rehearsalAccount) window.rehearsalAccount.open();
    else $('account-dialog').showModal();
    return;
  }
  setStatus(state.config.coachingViaHost
    ? 'Analyze sends your transcript and preparation text to this Codex conversation.'
    : 'The rehearsal service is unavailable. Reload the published app to reconnect.', state.config.coachingViaHost ? '' : 'error');
}

async function enumerateInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const generation = ++state.inputListGeneration;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
    if (generation !== state.inputListGeneration) return;
    const selected = state.inputDevice || $('audio-input').value;
    const activeTrack = state.stream?.getAudioTracks().find((track) => track.readyState !== 'ended');
    const defaultName = devices.find((device) => device.deviceId === 'default')?.label || (!state.inputDevice ? activeTrack?.label : '');
    state.inputsNamed = devices.some((device) => Boolean(device.label)) || Boolean(activeTrack?.label);
    $('audio-input').replaceChildren();
    const defaultLabel = defaultName ? `System default · ${defaultName.replace(/^default\s*[-–—:]\s*/i, '')}` : state.inputsNamed || state.stream ? 'System default microphone' : 'Detect microphones…';
    $('audio-input').append(new Option(defaultLabel, ''));
    const seen = new Set(['default', 'communications']);
    devices.forEach((device) => {
      if (!device.deviceId || seen.has(device.deviceId)) return;
      seen.add(device.deviceId);
      $('audio-input').append(new Option(device.label || `Microphone ${$('audio-input').options.length}`, device.deviceId));
    });
    // Device lists can briefly omit an active input during a hardware change.
    if (state.inputDevice && activeTrack && !Array.from($('audio-input').options).some((option) => option.value === state.inputDevice)) {
      $('audio-input').append(new Option(activeTrack.label || 'Current microphone', state.inputDevice));
    }
    const exists = Array.from($('audio-input').options).some((option) => option.value === selected);
    $('audio-input').value = exists ? selected : '';
    if (!exists) state.inputDevice = '';
  } catch { /* Recording can still work when device enumeration is unavailable. */ }
}
async function initializeInputDetection() {
  await enumerateInputs();
  if (!navigator.permissions?.query) return;
  try {
    const permission = await navigator.permissions.query({ name: 'microphone' });
    permission.addEventListener('change', enumerateInputs);
    await enumerateInputs();
  } catch { /* Some browsers do not expose microphone permission state. */ }
}
async function openInputSelector(event) {
  if (state.recording || state.startingRecording || state.requestingMic) return;
  if (event.type === 'keydown' && !['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
  // First-use device names require microphone access from a user gesture.
  if (!state.inputsNamed && !state.stream) {
    event.preventDefault();
    await enableMic('');
  }
}
function microphoneReadyText() {
  const label = state.stream?.getAudioTracks()[0]?.label;
  return label ? `Microphone ready · ${label}` : 'Microphone ready · watching your audio level';
}
function resetMeter() {
  if (state.meterFrame) cancelAnimationFrame(state.meterFrame);
  state.meterFrame = null;
  for (const bar of $('input-level').children) bar.style.height = '3px';
  document.querySelector('.input-meter').setAttribute('aria-valuenow', '0');
}
function meterLoop() {
  if (!state.analyser) return;
  const values = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(values);
  let sum = 0;
  for (const value of values) sum += ((value - 128) / 128) ** 2;
  const level = Math.min(100, Math.round(Math.sqrt(sum / values.length) * 350));
  const bars = Array.from($('input-level').children);
  bars.forEach((bar, index) => {
    const start = Math.floor(index * values.length / bars.length);
    const end = Math.floor((index + 1) * values.length / bars.length);
    let energy = 0;
    for (let sample = start; sample < end; sample++) energy += ((values[sample] - 128) / 128) ** 2;
    const amplitude = Math.min(1, Math.sqrt(energy / Math.max(1, end - start)) * 3.5);
    bar.style.height = `${3 + amplitude * 31}px`;
  });
  document.querySelector('.input-meter').setAttribute('aria-valuenow', String(level));
  state.meterFrame = requestAnimationFrame(meterLoop);
}
function cleanupMic() {
  state.micGeneration++;
  resetMeter();
  if (state.processor) { state.processor.onaudioprocess = null; state.processor.disconnect(); }
  state.source?.disconnect();
  state.analyser?.disconnect();
  state.silent?.disconnect();
  state.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  if (state.context && state.context.state !== 'closed') state.context.close().catch(() => {});
  state.stream = null; state.context = null; state.source = null; state.processor = null; state.silent = null; state.analyser = null;
  $('enable-mic').textContent = 'Enable mic';
  $('mic-status').textContent = 'Your microphone is off';
}
async function enableMic(deviceId = $('audio-input').value) {
  if (state.requestingMic) return false;
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus(state.config.coachingViaHost ? 'This host does not provide microphone access. Upload a recording or paste a transcript for coaching.' : 'Microphone recording needs HTTPS or localhost. Open the published page in a current Chrome, Edge, or Firefox browser.', 'error');
    return false;
  }
  const permissionPolicy = document.permissionsPolicy || document.featurePolicy;
  if (state.config.coachingViaHost && permissionPolicy?.allowsFeature?.('microphone') === false) {
    setStatus('This host has blocked microphone access. Upload a recording or paste a transcript for coaching.', 'error');
    return false;
  }
  state.requestingMic = true;
  syncRecordingLibraryControls();
  const generation = ++state.micGeneration;
  $('enable-mic').disabled = true; $('audio-input').disabled = true; $('record-button').disabled = true;
  $('upload-button').disabled = true;
  $('mic-status').textContent = 'Waiting for microphone permission…';
  let stream;
  let newContext;
  let replacedMic = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (generation !== state.micGeneration) { stream.getTracks().forEach((track) => track.stop()); return false; }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('This browser cannot process audio. Please open the app in a recent Chrome, Edge, Firefox, or Safari browser.');
    const context = newContext = new AudioContextClass();
    await context.resume();
    if (generation !== state.micGeneration) { stream.getTracks().forEach((track) => track.stop()); await context.close().catch(() => {}); return false; }
    cleanupMic();
    const activeGeneration = state.micGeneration;
    replacedMic = true;
    state.stream = stream;
    state.context = context;
    state.source = context.createMediaStreamSource(stream);
    state.processor = context.createScriptProcessor(4096, 1, 1);
    state.analyser = context.createAnalyser();
    state.analyser.fftSize = 256;
    state.silent = context.createGain();
    state.silent.gain.value = 0;
    state.source.connect(state.analyser);
    state.source.connect(state.processor);
    state.processor.connect(state.silent);
    state.silent.connect(context.destination);
    state.processor.onaudioprocess = (event) => {
      captureRecordingSamples(event.inputBuffer.getChannelData(0), context.sampleRate);
    };
    stream.getAudioTracks().forEach((track) => { track.onended = () => {
      if (state.recording) stopRecording();
      cleanupMic();
      setStatus('The microphone was disconnected. Your recorded audio is still available below.', 'error');
      enumerateInputs();
    }; });
    state.inputDevice = deviceId;
    await enumerateInputs();
    if (activeGeneration !== state.micGeneration || state.stream !== stream) return false;
    $('enable-mic').textContent = 'Turn off';
    $('mic-status').textContent = microphoneReadyText();
    if (!state.busy) setStatus('');
    meterLoop();
    return true;
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    if (replacedMic) cleanupMic();
    else if (newContext && newContext.state !== 'closed') await newContext.close().catch(() => {});
    $('audio-input').value = state.inputDevice;
    const messages = {
      NotAllowedError: 'Microphone permission was blocked. Allow microphone access in your browser’s site settings, then choose Enable mic.',
      NotFoundError: 'No microphone was found. Connect a microphone or upload a recording.',
      NotReadableError: 'The microphone is unavailable. Close other apps using it, or choose a different microphone.',
      OverconstrainedError: 'That microphone is no longer available. Choose System default or another input, then enable it.',
      SecurityError: 'Your browser blocked microphone access. Open the HTTPS page and allow microphone permission.',
    };
    const hostPermissionError = state.config.coachingViaHost && ['NotAllowedError', 'SecurityError'].includes(error.name);
    setStatus(hostPermissionError ? 'Microphone access was not granted by the host or your device. You can upload a recording or paste a transcript for coaching.' : messages[error.name] || errorMessage(error), 'error');
    $('mic-status').textContent = state.stream ? microphoneReadyText() : 'Microphone unavailable';
    return false;
  } finally {
    state.requestingMic = false;
    syncRecordingLibraryControls();
    syncRecordingControls();
    syncAnalysisControls();
  }
}
async function startRecording() {
  if (state.busy || state.recoveryPending || state.cancelRestartPending || state.requestingMic || state.startingRecording || state.recording) return;
  state.startingRecording = true;
  syncRecordingControls(); syncAnalysisControls(); syncRecordingLibraryControls();
  try {
    if (!state.stream && !(await enableMic())) return;
    const context = state.context;
    const stream = state.stream;
    const generation = state.micGeneration;
    if (!context || !stream) return;
    await context.resume();
    // A disconnected or replaced microphone must not start an empty recording.
    if (context !== state.context || stream !== state.stream || generation !== state.micGeneration ||
        state.busy || state.recording || stream.getAudioTracks().every(track => track.readyState === 'ended')) return;
    discardAudio(false);
    state.samples = []; state.sampleCount = 0;
    state.recording = true; state.recordingPaused = false; state.recordingSampleRate = context.sampleRate;
    startLiveTranscription();
    $('report').hidden = true;
    $('record-button').setAttribute('aria-label', 'Stop recording');
    $('mic-icon').setAttribute('hidden', ''); $('stop-icon').hidden = false;
    document.querySelector('.record-panel').classList.add('recording');
    $('record-title').textContent = 'You’ve got the floor.';
    $('record-action-label').textContent = 'Stop recording';
    $('mic-status').textContent = 'Recording from your selected microphone';
    $('pause-recording').hidden = false; $('pause-recording').textContent = 'Pause';
    $('pause-recording').setAttribute('aria-label', 'Pause recording');
    $('pause-recording').setAttribute('aria-pressed', 'false');
    setStatus('');
    state.timer = setInterval(() => { $('timer').textContent = formatTime(state.sampleCount / state.recordingSampleRate); }, 150);
  } finally {
    state.startingRecording = false;
    syncRecordingControls(); syncAnalysisControls(); syncCancelControls(); syncRecordingLibraryControls();
  }
}
function captureRecordingSamples(samples, sampleRate) {
  if (!state.recording || state.recordingPaused) return 0;
  const remaining = Math.max(0, Math.floor(sampleRate * state.config.maxDurationSeconds) - state.sampleCount);
  const length = Math.min(samples.length, remaining);
  if (length) {
    const captured = new Float32Array(samples.subarray(0, length));
    state.samples.push(captured);
    state.sampleCount += length;
    try {
      if (state.liveTake?.failed) state.liveTake.session?.captureRemaining?.(captured);
      else state.liveTake?.session?.push(captured);
    }
    catch (error) { if (state.liveTake) failLiveTranscription(state.liveTake, error); }
  }
  if (state.sampleCount >= Math.floor(sampleRate * state.config.maxDurationSeconds)) stopRecording(true);
  return length;
}
function toggleRecordingPause() {
  if (!state.recording) return;
  state.recordingPaused = !state.recordingPaused;
  const paused = state.recordingPaused;
  document.querySelector('.record-panel').classList.toggle('recording-paused', paused);
  $('pause-recording').textContent = paused ? 'Resume' : 'Pause';
  $('pause-recording').setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording');
  $('pause-recording').setAttribute('aria-pressed', String(paused));
  $('record-title').textContent = paused ? 'Take a breath.' : 'You’ve got the floor.';
  $('mic-status').textContent = paused ? 'Paused · this time is not recorded' : 'Recording from your selected microphone';
  if (state.liveTake) renderLiveProgress(state.liveTake);
}

function startLiveTranscription() {
  if (state.config.hosted && (!state.config.liveTranscription || !state.config.auth?.signedIn)) return;
  $('follow-transcript-panel').hidden = false;
  state.transcriptionAttempted = true;
  if (!window.rehearsalLiveSpeech?.startSession) {
    showLiveFallback('Live transcription is unavailable. You can transcribe the complete recording after you stop.');
    return;
  }
  const take = { generation: state.audioGeneration, model: state.config.transcriptionModel, hosted: Boolean(state.config.hosted), session: null, snapshot: {}, progress: '', text: null, finishing: false, failed: false, error: '' };
  state.liveTake = take;
  renderLiveProgress(take);
  try {
    take.session = window.rehearsalLiveSpeech.startSession({
      model: take.model, sampleRate: state.recordingSampleRate, encodeAudio: makeWav,
      onRecoveryWarning(message) {
        if (state.liveTake === take && take.generation === state.audioGeneration) setStatus(message, 'error');
      },
      onUpdate(snapshot) {
        if (state.liveTake !== take || take.generation !== state.audioGeneration || take.failed) return;
        if (snapshot.error) { failLiveTranscription(take, snapshot.error); return; }
        if (snapshot.cancelled) { failLiveTranscription(take, new Error('Retry the complete recording when you are ready.')); return; }
        take.snapshot = snapshot;
        renderLiveProgress(take);
      },
      onProgress(message) {
        if (state.liveTake !== take || take.generation !== state.audioGeneration || take.failed || typeof message !== 'string') return;
        take.progress = message;
        renderLiveProgress(take);
      },
    });
    if (state.liveTake !== take) take.session.cancel();
  } catch (error) { failLiveTranscription(take, error); }
}
function renderLiveProgress(take) {
  if (state.liveTake !== take) return;
  if (take.failed) {
    if (take.finishing) $('follow-transcript-status').textContent = 'Saving your complete recording… You can retry transcription afterward.';
    return;
  }
  const snapshot = take.snapshot;
  const text = String(snapshot.text || '');
  const captured = Number(snapshot.audioSeconds) || 0;
  const prefix = take.finishing ? 'Saving transcript' : state.recordingPaused ? 'Paused' : snapshot.preparing ? 'Connecting live transcription' : snapshot.catchingUp ? 'Transcription is catching up' : 'Live transcript';
  const progress = snapshot.preparing && take.progress ? ` · ${take.progress}` : '';
  const message = `${prefix} · ${formatTime(captured)} recorded${progress}`;
  if (take.text === text && take.status === message) return;
  take.status = message;
  const container = $('follow-transcript');
  if (take.text !== text) {
    take.text = text;
    container.textContent = text || 'Your words will appear here as you speak.';
    container.scrollTop = container.scrollHeight;
    renderSummaryDraft(text, true);
  }
  container.classList.add('is-live');
  if ($('follow-transcript-status').textContent !== message) $('follow-transcript-status').textContent = message;
  $('follow-transcript-connect').hidden = true;
  $('live-transcription-cancel').hidden = take.finishing;
  $('follow-transcript-note').hidden = false;
  $('follow-transcript-note').textContent = 'Live draft · words may be corrected as you speak. Stop saves your recording and transcript privately.';
}
function cancelLiveSession() {
  const take = state.liveTake;
  state.liveTake = null; state.livePromise = null;
  if (take?.session?.abandon) take.session.abandon();
  else take?.session?.cancel();
  $('live-transcription-cancel').hidden = true;
  $('follow-transcript').classList.remove('is-live');
  syncAnalysisControls(); syncCancelControls(); syncRecordingLibraryControls();
}
function showLiveFallback(message) {
  state.liveFailure = message;
  $('follow-transcript-status').textContent = `${message}${state.recording ? ' Audio recording continues.' : ' Your audio is still available.'}`;
  $('follow-transcript-note').textContent = 'Any text shown is an incomplete preview. Retry transcription to use the complete recording.';
  $('follow-transcript-note').hidden = false;
  $('follow-transcript-connect').textContent = 'Transcribe complete recording';
  $('follow-transcript-connect').hidden = state.recording || !state.audioBlob || Boolean(state.liveTake);
}
function failLiveTranscription(take, error, finished = false) {
  if (state.liveTake !== take) return;
  if (take.hosted && take.session && !finished) {
    // Keep the session until Stop can save the complete audio, even if its preview failed.
    take.failed = true; take.error = errorMessage(error);
    take.session.cancel();
    $('live-transcription-cancel').hidden = true;
    $('follow-transcript').classList.remove('is-live');
  } else cancelLiveSession();
  showLiveFallback(`Live transcription stopped. ${errorMessage(error)}`);
}
function finishLiveTranscription() {
  const take = state.liveTake;
  if (!take) return;
  take.finishing = true;
  renderLiveProgress(take);
  const blob = state.audioBlob;
  const promise = Promise.resolve().then(() => take.session.finish(take.hosted ? blob : undefined)).then(result => {
    if (state.liveTake !== take || take.generation !== state.audioGeneration || take.model !== state.config.transcriptionModel) throw supersededAudioError();
    if (take.hosted) {
      state.cloudRecordingId = result.recordingId;
      $('audio-save-status').textContent = 'Saved privately to your account. Replay does not upload or reprocess this recording.';
      window.rehearsalAccount?.refreshHistory();
      if (result.complete !== true) throw new Error(take.error || 'Retry transcription to process the complete saved recording.');
    }
    if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('No speech was found. Check your microphone level or try another take.');
    state.liveTake = null; state.liveFailure = '';
    $('live-transcription-cancel').hidden = true;
    $('follow-transcript').classList.remove('is-live');
    cacheTranscript(result.text, take.generation);
    updatePlaybackUI();
    return result.text;
  }).catch(error => {
    if (state.liveTake === take) {
      failLiveTranscription(take, error, true);
      if (take.hosted && !state.cloudRecordingId) $('audio-save-status').textContent = 'This recording is still in this tab. Download it or retry transcription to save it privately.';
    }
    throw error;
  }).finally(() => {
    if (state.livePromise === promise) state.livePromise = null;
    syncAnalysisControls(); syncCancelControls(); syncRecordingLibraryControls();
  });
  state.livePromise = promise;
  syncAnalysisControls(); syncCancelControls(); syncRecordingLibraryControls();
  // A take saves even if its independent transcription queue fails.
  promise.catch(() => {});
}
function makeWav(samples, sourceRate) {
  const targetRate = 16000;
  const outputLength = Math.round(samples.length * targetRate / sourceRate);
  const buffer = new ArrayBuffer(44 + outputLength * 2);
  const view = new DataView(buffer);
  const writeText = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeText(0, 'RIFF'); view.setUint32(4, 36 + outputLength * 2, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeText(36, 'data'); view.setUint32(40, outputLength * 2, true);
  const ratio = sourceRate / targetRate;
  for (let i = 0; i < outputLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let total = 0;
    for (let j = start; j < end; j++) total += samples[j];
    const sample = Math.max(-1, Math.min(1, total / (end - start)));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
function stopRecording(limitReached = false) {
  if (!state.recording) return;
  state.recording = false; state.recordingPaused = false;
  clearInterval(state.timer);
  state.timer = null;
  const sampleRate = state.recordingSampleRate || state.context.sampleRate;
  const sampleCount = Math.min(state.sampleCount, Math.floor(sampleRate * state.config.maxDurationSeconds));
  state.duration = sampleCount / sampleRate;
  const flattened = new Float32Array(sampleCount);
  let offset = 0;
  for (const chunk of state.samples) {
    const length = Math.min(chunk.length, sampleCount - offset);
    if (length <= 0) break;
    flattened.set(chunk.subarray(0, length), offset);
    offset += length;
  }
  state.samples = []; state.sampleCount = 0;
  document.querySelector('.record-panel').classList.remove('recording');
  document.querySelector('.record-panel').classList.remove('recording-paused');
  $('mic-icon').removeAttribute('hidden'); $('stop-icon').hidden = true;
  $('record-button').setAttribute('aria-label', 'Record a new rehearsal');
  $('record-title').textContent = 'Nice. That’s a first take.';
  $('record-action-label').textContent = 'Record another take';
  syncRecordingControls(); syncAnalysisControls(); syncCancelControls();
  $('pause-recording').hidden = true; $('pause-recording').setAttribute('aria-pressed', 'false');
  $('mic-status').textContent = microphoneReadyText();
  $('timer').textContent = formatTime(state.duration);
  syncRecordingLibraryControls();
  if (state.duration < 0.5) { cancelLiveSession(); setStatus('That take was a little too short. Record at least a few seconds, then try again.', 'error'); return; }
  setAudio(makeWav(flattened, sampleRate), state.duration, 'Your rehearsal', { preserveCapture: true });
  window.rehearsalAccount?.track('recording_completed');
  finishLiveTranscription();
  if (limitReached) setStatus('Your recording reached the 10-minute limit. You can listen back now; check the save status below before closing this tab.');
}
function setAudio(blob, duration, caption, { savedRecording = null, preserveCapture = false } = {}) {
  if (!preserveCapture) discardAudio(false);
  state.audioBlob = blob; state.duration = duration; state.audioDuration = duration;
  state.audioURL = URL.createObjectURL(blob);
  $('playback').src = state.audioURL;
  $('playback').load();
  $('recording-caption').textContent = `${caption} · ${formatTime(duration)}`;
  $('audio-preview').hidden = false;
  $('follow-transcript-panel').hidden = false;
  $('timer').textContent = formatTime(duration);
  showTranscriptReadyState();
  updatePlaybackUI();
  if (state.config.hosted) {
    state.audioSave = null;
    $('audio-save-status').textContent = state.liveTake?.hosted
      ? 'Saving your complete recording privately… Keep this tab open until saving finishes.'
      : 'This take is in this tab. Create transcript or Analyze to save it privately to your account.';
    syncRecordingLibraryControls();
    return;
  }
  const id = savedRecording?.id || window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const record = { id, blob, duration, caption: String(caption || 'Your rehearsal').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 255), createdAt: savedRecording?.createdAt ?? Date.now(), status: savedRecording?.status === 'failed' ? 'failed' : savedRecording ? 'saved' : 'saving', error: savedRecording?.error || '' };
  state.audioSave = record;
  renderAudioSaveStatus();
  syncRecordingLibraryControls();
  if (!savedRecording) autosaveRecording(record);
}
function discardAudio(reset = true) {
  state.processing?.clear();
  cancelLiveSession();
  state.liveFailure = '';
  state.libraryOpenGeneration++;
  state.audioSave = null;
  state.cloudRecordingId = '';
  state.audioGeneration++;
  state.analysisGeneration++;
  state.transcriptController?.abort();
  state.requestController?.abort();
  state.transcriptController = null; state.transcriptPromise = null;
  state.transcriptGeneration = -1; state.transcriptModel = ''; state.transcriptText = ''; state.transcriptionAttempted = false;
  state.report = null; state.pendingSeek = null; state.scrubbing = false;
  state.chat?.selectQuote('');
  stopPlaybackLoop();
  $('playback').pause(); $('playback').removeAttribute('src'); $('playback').load();
  if (state.audioURL) URL.revokeObjectURL(state.audioURL);
  state.audioURL = null; state.audioBlob = null; state.duration = 0; state.audioDuration = 0;
  $('audio-preview').hidden = true;
  $('report').hidden = true;
  $('transcript').value = '';
  renderFollowTranscript('');
  $('follow-transcript-panel').hidden = true;
  $('follow-transcript-status').textContent = '';
  $('follow-transcript-connect').hidden = true;
  $('annotated-transcript').replaceChildren();
  $('annotations-notes').replaceChildren();
  $('download-transcript').disabled = true;
  renderSummaryDraft();
  markPromptStale();
  updatePlaybackUI();
  $('timer').textContent = '00:00';
  $('audio-save-status').textContent = '';
  syncRecordingLibraryControls();
  if (reset) {
    $('record-title').textContent = 'Begin recording';
    $('record-action-label').textContent = 'Start your rehearsal';
    $('record-button').setAttribute('aria-label', 'Start recording');
  }
}
function recordingStore() {
  if (!window.rehearsalRecordings) throw new Error('Browser saving is unavailable. Download your audio to keep it.');
  return window.rehearsalRecordings;
}
function canReplaceCurrentAudio() {
  return !state.recoveryPending && !state.cancelRestartPending && !state.recording && !state.startingRecording && !state.busy && !state.requestingMic && !state.preparingAudio && !state.transcriptPromise && !state.liveTake && !state.livePromise;
}
function syncRecordingLibraryControls() {
  const blocked = !canReplaceCurrentAudio() || state.libraryBusy;
  if (blocked) rememberRecordingLibraryFocus();
  for (const button of $('saved-recordings-list').querySelectorAll('button')) button.disabled = blocked;
  $('download-audio').disabled = !state.audioBlob;
  if (!blocked) restoreRecordingLibraryFocus();
}
function rememberRecordingLibraryFocus() {
  const active = document.activeElement;
  const button = Array.from($('saved-recordings-list').querySelectorAll('button')).find((item) => item === active);
  if (button) {
    state.libraryFocus = { id: button.dataset.recordingId, action: button.dataset.recordingAction, index: Number(button.dataset.recordingIndex), element: button };
  } else if (active && active !== document.body && active !== state.libraryFocus?.element) state.libraryFocus = null;
}
function restoreRecordingLibraryFocus() {
  const focus = state.libraryFocus;
  if (!focus) return;
  state.libraryFocus = null;
  if ($('history-page').hidden) return;
  const active = document.activeElement;
  if (active && active !== document.body && active !== focus.element) return;
  const list = $('saved-recordings-list');
  const buttons = Array.from(list.querySelectorAll('button'));
  const sameAction = buttons.find((button) => button.dataset.recordingId === focus.id && button.dataset.recordingAction === focus.action);
  const nearbyIndex = Math.max(0, Math.min(focus.index, list.children.length - 1));
  const nearbyOpen = buttons.find((button) => Number(button.dataset.recordingIndex) === nearbyIndex && button.dataset.recordingAction === 'Open');
  const target = $('saved-recordings-details').open && (sameAction || nearbyOpen);
  if (target && !target.disabled) target.focus({ preventScroll: true });
  else $('saved-recordings-details').querySelector('summary')?.focus({ preventScroll: true });
}
function renderRecordingLibraryStatus() {
  const status = $('saved-recordings-status');
  const unsaved = state.unsavedRecordings.size;
  status.classList.toggle('error', unsaved > 0);
  status.textContent = unsaved
    ? `${unsaved} ${unsaved === 1 ? 'recording is' : 'recordings are'} not saved in this browser. Download unsaved takes below to keep them, or open a take to try saving again.`
    : state.savedRecordings.length ? 'Saved only in this browser. Download a copy to keep outside the app.' : 'No saved recordings yet. Finished takes and uploaded audio save here automatically.';
}
function renderAudioSaveStatus() {
  const record = state.audioSave;
  const status = $('audio-save-status');
  status.classList.toggle('error', record?.status === 'failed');
  status.replaceChildren();
  if (!record) return;
  const messages = {
    saving: 'Saving in this browser…',
    saved: 'Saved in this browser. Find this take in Saved recordings.',
    removed: 'Browser copy deleted. This open take is still available to download.',
    failed: `Not saved in this browser. ${record.error || 'Download your audio to keep it.'}`,
  };
  status.append(document.createTextNode(messages[record.status]));
  if (record.status === 'failed') {
    const retry = addText('button', 'Try saving again', 'text-button');
    retry.type = 'button';
    retry.addEventListener('click', () => { if (!state.libraryBusy && state.audioSave === record && record.status === 'failed') autosaveRecording(record); });
    status.append(retry);
  }
}
function autosaveRecording(record) {
  record.status = 'saving';
  if (state.audioSave === record) renderAudioSaveStatus();
  const saving = (async () => {
    try {
      await recordingStore().save({ id: record.id, blob: record.blob, duration: record.duration, caption: record.caption, createdAt: record.createdAt });
      record.status = 'saved';
      record.error = '';
      state.unsavedRecordings.delete(record.id);
      if (state.audioSave === record) renderAudioSaveStatus();
      await refreshSavedRecordings();
    } catch (error) {
      record.status = 'failed';
      record.error = errorMessage(error);
      state.unsavedRecordings.set(record.id, record);
      if (state.audioSave === record) renderAudioSaveStatus();
      renderSavedRecordings();
    }
  })();
  state.pendingAudioSaves.add(saving);
  saving.finally(() => state.pendingAudioSaves.delete(saving));
  return saving;
}
function renderSavedRecordings() {
  const list = $('saved-recordings-list');
  rememberRecordingLibraryFocus();
  list.replaceChildren();
  const records = [...state.unsavedRecordings.values(), ...state.savedRecordings.filter((record) => !state.unsavedRecordings.has(record.id))];
  $('saved-recordings-count').textContent = state.unsavedRecordings.size ? `${state.savedRecordings.length} saved · ${state.unsavedRecordings.size} unsaved` : String(state.savedRecordings.length);
  if (!state.config.hosted) {
    $('history-count').textContent = String(records.length);
    $('history-privacy').textContent = 'Saved only in this browser.';
  }
  for (const [index, record] of records.entries()) {
    const row = addText('div', '', 'saved-recording-row');
    const meta = addText('div', '', 'saved-recording-meta');
    const date = new Date(record.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    meta.append(addText('strong', record.caption, 'saved-recording-title'), addText('span', date, 'saved-recording-info'));
    const duration = addText('span', formatTime(record.duration), 'saved-recording-duration');
    const status = addText('span', record.status === 'failed' ? 'Not saved; download to keep' : 'Saved in this browser', 'saved-recording-state');
    const actions = addText('div', '', 'saved-recording-actions');
    for (const [label, action] of [['Open', () => openSavedRecording(record.id)], ['Download', () => downloadSavedRecording(record.id)], ['Delete', () => deleteSavedRecording(record.id)]]) {
      const button = addText('button', label, `text-button${label === 'Delete' ? ' saved-recording-delete' : ''}`);
      button.type = 'button';
      button.dataset.recordingId = record.id;
      button.dataset.recordingAction = label;
      button.dataset.recordingIndex = String(index);
      button.setAttribute('aria-label', `${label} ${record.caption}, ${date}`);
      button.addEventListener('click', action);
      actions.append(button);
    }
    row.append(meta, duration, status, actions);
    list.append(row);
  }
  renderRecordingLibraryStatus();
  syncRecordingLibraryControls();
}
async function refreshSavedRecordings() {
  if (state.config.hosted) return;
  const generation = ++state.libraryGeneration;
  try {
    const records = await recordingStore().list();
    if (generation !== state.libraryGeneration) return;
    state.savedRecordings = records;
    renderSavedRecordings();
  } catch (error) {
    if (generation === state.libraryGeneration) {
      $('saved-recordings-status').classList.add('error');
      $('saved-recordings-status').textContent = `${errorMessage(error)}${state.unsavedRecordings.size ? ' Unsaved takes are still only in this tab; download them below to keep a copy.' : ''}`;
    }
  }
}
async function openSavedRecording(id) {
  if (!canReplaceCurrentAudio() || state.libraryBusy) return;
  const generation = ++state.libraryOpenGeneration;
  const audioGeneration = state.audioGeneration;
  const viewGeneration = state.viewGeneration;
  state.libraryBusy = true;
  syncRecordingLibraryControls();
  try {
    const record = state.unsavedRecordings.get(id) || await recordingStore().get(id);
    if (generation !== state.libraryOpenGeneration || audioGeneration !== state.audioGeneration || viewGeneration !== state.viewGeneration || !canReplaceCurrentAudio()) return;
    if (!record) throw new Error('This recording is no longer saved in this browser.');
    setAudio(record.blob, record.duration, record.caption, { savedRecording: record });
    $('record-title').textContent = 'Live Transcript';
    setStatus(record.status === 'failed' ? 'This take is only in this tab. Download it or try saving again.' : 'Saved recording opened. Replay creates its transcript on this device.');
    showPage('rehearse');
  } catch (error) { $('saved-recordings-status').textContent = errorMessage(error); }
  finally { state.libraryBusy = false; syncRecordingLibraryControls(); }
}
async function downloadBlob(blob, name) {
  if (window.rehearsalDownloads?.download) return window.rehearsalDownloads.download(blob, name);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function downloadAudioBlob(blob, caption) {
  const name = String(caption || 'dress-rehearsal').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 180);
  return downloadBlob(blob, `${name || 'dress-rehearsal'}.wav`);
}
async function downloadCurrentAudio() {
  try { if (state.audioBlob) await downloadAudioBlob(state.audioBlob, state.audioSave?.caption); }
  catch (error) { setStatus(errorMessage(error), 'error'); }
}
async function downloadSavedRecording(id) {
  try {
    const record = state.unsavedRecordings.get(id) || await recordingStore().get(id);
    if (!record) throw new Error('This recording is no longer saved.');
    await downloadAudioBlob(record.blob, record.caption);
  } catch (error) { $('saved-recordings-status').textContent = errorMessage(error); }
}
async function deleteSavedRecording(id) {
  if (state.libraryBusy || !canReplaceCurrentAudio()) return;
  state.libraryBusy = true;
  syncRecordingLibraryControls();
  try {
    await Promise.all([...state.pendingAudioSaves]);
    if (state.unsavedRecordings.has(id)) state.unsavedRecordings.delete(id);
    else await recordingStore().remove(id);
    if (state.audioSave?.id === id) { state.audioSave.status = 'removed'; renderAudioSaveStatus(); }
    await refreshSavedRecordings();
  } catch (error) { $('saved-recordings-status').textContent = errorMessage(error); }
  finally { state.libraryBusy = false; syncRecordingLibraryControls(); }
}
function warnBeforeLeaving(event) {
  if (state.recording || state.livePromise || state.pendingAudioSaves.size || state.unsavedRecordings.size || state.config.hosted && state.audioBlob && !state.cloudRecordingId) {
    event.preventDefault();
    event.returnValue = '';
  }
}
function playbackDuration() {
  return Number.isFinite(state.audioDuration) && state.audioDuration > 0 ? state.audioDuration : 0;
}
function wordIndexAtTime(time, duration, count) {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0 || !Number.isInteger(count) || count < 1) return -1;
  return Math.min(count - 1, Math.max(0, Math.floor(Math.max(0, time) / duration * count)));
}
function renderFollowTranscript(text) {
  const container = $('follow-transcript');
  state.transcriptWords = [];
  state.activeWordIndex = -1;
  container.replaceChildren();
  const parts = String(text || '').match(/\S+|\s+/g) || [];
  for (const part of parts) {
    if (/^\s+$/.test(part)) container.append(document.createTextNode(part));
    else {
      const span = addText('span', part);
      state.transcriptWords.push(span);
      container.append(span);
    }
  }
  container.scrollTop = 0;
  $('follow-transcript-note').hidden = !state.transcriptWords.length;
  $('follow-transcript-note').textContent = 'Word highlighting uses approximate timing, not word-level timestamps.';
  highlightTranscript($('playback').currentTime || 0);
}
function highlightTranscript(time) {
  if (state.liveTake || state.recording) return;
  const next = wordIndexAtTime(time, playbackDuration(), state.transcriptWords.length);
  const previous = state.activeWordIndex;
  if (next === previous) return;
  if (previous >= 0) state.transcriptWords[previous]?.classList.remove('current');
  for (let index = Math.max(0, Math.min(previous, next)); index <= Math.max(previous, next); index++) {
    state.transcriptWords[index]?.classList.toggle('spoken', next >= 0 && index < next);
  }
  const active = state.transcriptWords[next];
  if (active) {
    active.classList.remove('spoken'); active.classList.add('current');
    const container = $('follow-transcript');
    const wordRect = active.getBoundingClientRect();
    const panelRect = container.getBoundingClientRect();
    if (wordRect.top < panelRect.top + 15 || wordRect.bottom > panelRect.bottom - 15) {
      container.scrollTop += wordRect.top - panelRect.top - container.clientHeight / 2 + wordRect.height / 2;
    }
  }
  state.activeWordIndex = next;
}
function initializeWaveform() {
  if (state.waveformBars.length) return;
  const bars = Array.from({ length: 72 }, (_, index) => {
    const bar = addText('span', '');
    bar.style.height = `${18 + Math.abs(Math.sin(index * 1.71) * Math.cos(index * 0.39)) * 72}%`;
    return bar;
  });
  $('playback-bars').replaceChildren(...bars);
  state.waveformBars = bars;
}
function updatePlaybackUI() {
  const audio = $('playback');
  const duration = playbackDuration();
  const time = Math.max(0, Math.min(Number.isFinite(audio.currentTime) ? audio.currentTime : 0, duration));
  const playing = Boolean(state.audioBlob && !audio.paused && !audio.ended);
  const progress = duration ? time / duration : 0;
  $('playback-toggle').disabled = !state.audioBlob;
  $('playback-toggle').setAttribute('aria-label', playing ? 'Pause rehearsal playback' : audio.ended || time >= duration && duration ? 'Replay rehearsal' : 'Play rehearsal');
  $('playback-toggle').setAttribute('aria-pressed', String(playing));
  $('playback-icon').textContent = playing ? 'Ⅱ' : '▶';
  $('playback-label').textContent = playing ? 'Pause' : 'Replay';
  $('playback-current').textContent = formatTime(time);
  $('playback-duration').textContent = formatTime(duration);
  const scrub = $('playback-scrub');
  scrub.disabled = !duration;
  scrub.max = String(duration || 1); scrub.step = '0.01';
  if (!state.scrubbing) scrub.value = String(time);
  scrub.setAttribute('aria-valuetext', `${formatTime(time)} of ${formatTime(duration)}`);
  initializeWaveform();
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const phase = reduceMotion ? 0 : time * 3.6 + state.waveformPhase;
  state.waveformBars.forEach((bar, index) => {
    const height = 16 + Math.abs(Math.sin(index * 1.71 + phase) * Math.cos(index * 0.39 - phase * 0.47)) * 75;
    bar.style.height = `${height}%`;
    bar.classList.toggle('played', (index + 0.5) / state.waveformBars.length <= progress);
  });
  highlightTranscript(time);
}
function stopPlaybackLoop() {
  if (state.playbackFrame !== null) cancelAnimationFrame(state.playbackFrame);
  state.playbackFrame = null;
}
function playbackLoop() {
  state.playbackFrame = null;
  updatePlaybackUI();
  if (state.audioBlob && !$('playback').paused && !$('playback').ended) state.playbackFrame = requestAnimationFrame(playbackLoop);
}
function seekPlayback(seconds) {
  const duration = playbackDuration();
  if (!duration) return 0;
  const time = Math.max(0, Math.min(Number.isFinite(seconds) ? seconds : 0, duration));
  try { $('playback').currentTime = time; state.pendingSeek = null; }
  catch { state.pendingSeek = time; }
  state.waveformPhase += 0.2;
  $('playback-scrub').value = String(time);
  updatePlaybackUI();
  highlightTranscript(time);
  return time;
}
async function togglePlayback() {
  if (!state.audioBlob || state.recording || state.startingRecording) return;
  const audio = $('playback');
  if (!audio.paused) { audio.pause(); return; }
  if (audio.ended || audio.currentTime >= playbackDuration()) seekPlayback(0);
  try {
    await audio.play();
    updatePlaybackUI();
    stopPlaybackLoop(); playbackLoop();
    maybeTranscribeForPlayback();
  } catch { setStatus('Playback could not start. Try Replay again, or reload the recording.', 'error'); }
}
function showTranscriptReadyState() {
  if (!state.audioBlob || state.transcriptText || state.transcriptPromise || state.liveTake) return;
  if (state.liveFailure) { showLiveFallback(state.liveFailure); return; }
  $('follow-transcript-status').textContent = 'Create transcript saves and transcribes this recording privately. Replay does not process it again.';
  $('follow-transcript-connect').textContent = 'Create transcript';
  $('follow-transcript-connect').hidden = false;
}
function cacheTranscript(text, generation = state.audioGeneration) {
  if (generation !== state.audioGeneration) return false;
  state.transcriptText = String(text);
  state.liveFailure = '';
  state.transcriptGeneration = generation;
  state.transcriptModel = state.config.transcriptionModel;
  $('transcript').value = state.transcriptText;
  renderFollowTranscript(state.transcriptText);
  if (!state.report) renderSummaryDraft(state.transcriptText);
  $('follow-transcript-status').textContent = state.transcriptText.trim() ? 'Your recorded words · edit the transcript below after analysis if recognition missed something.' : 'Your transcript is empty. Add the words you actually spoke before updating feedback.';
  $('follow-transcript-connect').hidden = Boolean(state.transcriptText.trim());
  markPromptStale();
  return true;
}
function supersededAudioError() {
  return Object.assign(new Error('This recording was replaced.'), { name: 'AbortError' });
}
function ensureTranscript(progress = null) {
  const generation = state.audioGeneration;
  const model = state.config.transcriptionModel;
  if (!state.audioBlob) return Promise.reject(new Error('Record or upload a rehearsal first.'));
  if (state.config.hosted && !state.config.auth?.signedIn) { openSettings(); return Promise.reject(new Error('Sign in to save and transcribe your rehearsal.')); }
  if (state.livePromise) return state.livePromise;
  if (state.transcriptGeneration === generation && state.transcriptModel === model && state.transcriptText.trim()) return Promise.resolve(state.transcriptText);
  if (state.transcriptPromise) return state.transcriptPromise;
  const audio = state.audioBlob;
  const controller = new AbortController();
  const ownProgress = !progress;
  progress ||= beginProcessing({ signal: controller.signal });
  state.transcriptController = controller;
  state.transcriptionAttempted = true;
  $('follow-transcript-status').textContent = 'Preparing your transcript… You can keep listening.';
  if (state.config.hosted) $('audio-save-status').textContent = state.cloudRecordingId ? 'Saved privately to your account. Preparing your transcript…' : 'Saving this recording privately to your account…';
  $('follow-transcript-connect').hidden = true;
  syncCancelControls();
  let promise;
  promise = (async () => {
    try {
      const result = await api('/api/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal: controller.signal, onProgress: event => progress.event(event, 'transcribe'),
      });
      if (controller.signal.aborted || state.cancelRestartPending || generation !== state.audioGeneration || audio !== state.audioBlob || model !== state.config.transcriptionModel) throw supersededAudioError();
      const text = typeof result.text === 'string' ? result.text : '';
      if (!text.trim()) throw new Error('No speech was found. Check your microphone level or try another take.');
      if (Number.isFinite(result.durationSeconds) && result.durationSeconds > 0) {
        state.audioDuration = result.durationSeconds; state.duration = result.durationSeconds;
      }
      if (state.config.hosted) {
        state.cloudRecordingId = result.recordingId;
        $('audio-save-status').textContent = 'Saved privately to your account. Find this take in My saved rehearsals.';
        window.rehearsalAccount?.refreshHistory();
      }
      cacheTranscript(text, generation);
      updatePlaybackUI();
      progress.transcriptReady();
      if (ownProgress) progress.finish();
      return text;
    } catch (error) {
      progress.finish(error.name === 'AbortError' ? 'cancelled' : 'error', error.name === 'AbortError' ? '' : errorMessage(error));
      if (generation === state.audioGeneration && error.name !== 'AbortError') {
        $('follow-transcript-status').textContent = `${errorMessage(error)} Your audio is still available to replay.`;
        $('follow-transcript-connect').textContent = 'Retry transcript';
        $('follow-transcript-connect').hidden = false;
      } else if (generation === state.audioGeneration && error.name === 'AbortError') {
        state.transcriptionAttempted = false;
        $('follow-transcript-status').textContent = state.config.hosted ? 'Stopped waiting. Your audio is still here; processing may finish in saved rehearsals.' : 'Transcription stopped. Your audio is still available to replay.';
        $('follow-transcript-connect').textContent = 'Create transcript';
        $('follow-transcript-connect').hidden = false;
      }
      throw error;
    } finally {
      if (state.transcriptPromise === promise) {
        state.transcriptPromise = null; state.transcriptController = null;
        syncCancelControls(); syncRecordingLibraryControls();
      }
    }
  })();
  state.transcriptPromise = promise;
  syncRecordingLibraryControls();
  return promise;
}
function maybeTranscribeForPlayback() {
  if (state.config.hosted) return;
  if (!state.transcriptionAttempted || state.transcriptPromise || state.transcriptText) {
    ensureTranscript().catch(() => {});
  }
}
function readAudioDuration(file) {
  return new Promise(resolve => {
    const audio = document.createElement('audio');
    let url, timer, settled = false;
    const finish = duration => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeEventListener('loadedmetadata', loaded);
      audio.removeEventListener('error', cancel);
      try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {}
      if (url) URL.revokeObjectURL(url);
      if (state.audioMetadataCancel === cancel) state.audioMetadataCancel = null;
      resolve(duration);
    };
    const loaded = () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : NaN);
    const cancel = () => finish(NaN);
    state.audioMetadataCancel = cancel;
    audio.addEventListener('loadedmetadata', loaded);
    audio.addEventListener('error', cancel);
    timer = setTimeout(cancel, 1500);
    try { audio.preload = 'metadata'; url = URL.createObjectURL(file); audio.src = url; audio.load(); }
    catch { cancel(); }
  });
}
async function uploadAudio(file) {
  if (!file || state.busy || state.recoveryPending || state.cancelRestartPending || state.recording || state.startingRecording || state.requestingMic) return;
  if (file.size > 60 * 1024 * 1024) { setStatus('Please choose an audio file smaller than 60 MB and no longer than 10 minutes.', 'error'); return; }
  if (state.liveTake) { cancelLiveSession(); showLiveFallback('Live transcription stopped while opening another recording. Retry the complete recording if needed.'); }
  const generation = ++state.audioPreparationGeneration;
  state.preparingAudio = true;
  setBusy(true, 'Opening your recording and preparing its audio…');
  let decodeContext, transcribeAfterUpload = false;
  try {
    await validateAudioUploadHeader(file);
    if (generation !== state.audioPreparationGeneration) return;
    const duration = await readAudioDuration(file);
    if (generation !== state.audioPreparationGeneration) return;
    if (duration > state.config.maxDurationSeconds) throw new Error('This recording is longer than 10 minutes. Trim it to a shorter rehearsal and upload it again.');
    // Missing/untrusted metadata still needs the decoder check below. Native decoding
    // has no cancellation or allocation limit; this preflight is not a memory sandbox.
    decodeContext = new (window.AudioContext || window.webkitAudioContext)();
    const bytes = await file.arrayBuffer();
    if (generation !== state.audioPreparationGeneration) return;
    const audioBuffer = await decodeContext.decodeAudioData(bytes);
    if (generation !== state.audioPreparationGeneration) return;
    if (audioBuffer.duration > state.config.maxDurationSeconds) throw new Error('This recording is longer than 10 minutes. Trim it to a shorter rehearsal and upload it again.');
    if (audioBuffer.duration < 0.5) throw new Error('This recording is too short to analyze. Please choose a longer recording.');
    const mono = new Float32Array(audioBuffer.length);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
      const channel = audioBuffer.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / audioBuffer.numberOfChannels;
    }
    const wav = makeWav(mono, audioBuffer.sampleRate);
    if (wav.size > state.config.maxAudioBytes) throw new Error('The prepared recording is too large. Please upload a shorter rehearsal.');
    setAudio(wav, audioBuffer.duration, file.name);
    $('report').hidden = true;
    $('record-title').textContent = 'Live Transcript';
    transcribeAfterUpload = Boolean(state.config.hosted && state.config.auth?.signedIn);
    setStatus(transcribeAfterUpload ? 'Recording validated. Saving it privately and preparing your transcript…' : state.config.hosted ? 'Sign in to save and transcribe this recording.' : 'Recording loaded. Replay to hear it and see your transcript; Analyze adds coaching.');
  } catch (error) { if (generation === state.audioPreparationGeneration) setStatus(error.name === 'EncodingError' ? 'This browser could not read that audio format. Try a WAV, MP3, or M4A recording.' : errorMessage(error), 'error'); }
  finally {
    if (decodeContext) await decodeContext.close().catch(() => {});
    if (generation === state.audioPreparationGeneration) { state.preparingAudio = false; setBusy(false); $('audio-upload').value = ''; }
  }
  if (transcribeAfterUpload && generation === state.audioPreparationGeneration && !state.cancelRestartPending) {
    await ensureTranscript().catch(error => { if (generation === state.audioPreparationGeneration && error.name !== 'AbortError') setStatus(errorMessage(error), 'error'); });
  }
}
function analysisInput(text, useAI = true) {
  const mode = targetMode();
  const instructorRubric = $('instructor-rubric').value;
  const assignmentInstructions = $('assignment-instructions').value;
  const rehearsalContext = state.chat?.getRehearsalContext() || '';
  return { text, targetScript: $('target-script').value, targetTalkingPoints: $('target-talking-points').value, targetMode: mode, plannedIntroduction: $('planned-introduction').value, plannedTransitions: $('planned-transitions').value, instructorRubric, rubricFileName: instructorRubric.trim() ? state.rubricFileName : '', assignmentInstructions, assignmentFileName: assignmentInstructions.trim() ? state.assignmentFileName : '', rehearsalContext, durationSeconds: state.duration, useAI, ...(state.config.hosted ? { recordingId: state.cloudRecordingId } : {}) };
}
function markPromptStale() {
  state.promptGeneration++;
  $('coaching-prompt').value = '';
  if ($('prompt-details').open) $('prompt-status').textContent = 'Your text changed. Refresh the preview or choose Copy prompt to prepare the latest version.';
}
async function loadPromptPreview() {
  if (state.rubricLoading || state.assignmentLoading) { $('prompt-status').textContent = 'Wait for your documents to finish loading, or remove them before preparing a prompt.'; return ''; }
  const text = $('transcript').value;
  if (!text.trim()) { $('prompt-status').textContent = 'Replay or analyze your rehearsal first to create a transcript.'; $('coaching-prompt').value = ''; return ''; }
  const generation = ++state.promptGeneration;
  $('prompt-status').textContent = 'Preparing your coaching prompt…';
  $('refresh-prompt').disabled = true;
  try {
    const { useAI, ...input } = analysisInput(text, false);
    input.durationSeconds = state.report?.wordStats?.durationSeconds || state.duration;
    const result = await api('/api/prompt-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    if (generation !== state.promptGeneration) return '';
    if (typeof result.prompt !== 'string') throw new Error('The prompt preview was unavailable. Please try again.');
    $('coaching-prompt').value = result.prompt;
    $('prompt-status').textContent = state.config.coachingViaHost ? 'Ready. This preview contains the coaching policy, your transcript, and your preparation text.' : 'Ready. This preview contains your transcript and practice notes.';
    return result.prompt;
  } catch (error) { $('prompt-status').textContent = errorMessage(error); return ''; }
  finally { $('refresh-prompt').disabled = false; }
}
async function copyPrompt() {
  $('copy-prompt').disabled = true;
  try {
    const prompt = await loadPromptPreview();
    if (!prompt) return;
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(prompt);
      $('prompt-status').textContent = 'Coaching prompt copied.';
    } else {
      $('coaching-prompt').focus(); $('coaching-prompt').select();
      $('prompt-status').textContent = 'The prompt is selected. Press Ctrl+C (or ⌘C) to copy it.';
    }
  } catch {
    $('coaching-prompt').focus(); $('coaching-prompt').select();
    $('prompt-status').textContent = 'Your browser blocked clipboard access. Press Ctrl+C (or ⌘C) to copy the selected prompt.';
  } finally { $('copy-prompt').disabled = false; }
}
async function runAnalysis({ corrected = false } = {}) {
  if (state.rubricLoading || state.assignmentLoading) { setStatus('Wait for your documents to finish loading, or remove them before analyzing.'); return; }
  if (state.busy || state.recoveryPending || state.cancelRestartPending || state.recording || state.startingRecording || state.requestingMic || state.liveTake) return;
  if (!corrected && !state.audioBlob) return;
  if (corrected && !$('transcript').value.trim()) { setStatus('Add your transcript before updating the feedback.', 'error'); return; }
  if (state.config.hosted && !state.config.auth?.signedIn) { openSettings(); return; }
  window.rehearsalAccount?.track('analysis_requested');
  state.requestController = new AbortController();
  const signal = state.requestController.signal;
  const generation = ++state.analysisGeneration;
  const audioGeneration = state.audioGeneration;
  const viewGeneration = state.viewGeneration;
  const progress = beginProcessing({ analysis: true, needsTranscript: !corrected && !(state.transcriptGeneration === audioGeneration && state.transcriptText.trim()), signal });
  setBusy(true, state.transcriptText.trim() || corrected ? 'Reviewing your transcript and preparing coaching…' : 'Transcribing your rehearsal. You can keep listening while your words are prepared…');
  try {
    let text;
    if (corrected) {
      text = $('transcript').value;
      cacheTranscript(text, audioGeneration);
    } else text = await ensureTranscript(progress);
    if (generation !== state.analysisGeneration || audioGeneration !== state.audioGeneration || signal.aborted || state.cancelRestartPending) throw supersededAudioError();
    if (state.rubricLoading || state.assignmentLoading) throw new Error('A document is still loading. When it is ready, choose Analyze again to include its text.');
    state.duration = state.audioDuration || state.duration;
    const input = analysisInput(text, true);
    progress.transcriptReady(); progress.coachingRequested();
    setStatus(state.config.coachingViaHost ? 'Coaching requested in this Codex conversation. Waiting for your annotated report…' : 'Your transcript is ready. Reviewing word habits, speaking points, and the bigger picture…', 'busy');
    const report = await api('/api/analyze-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal, onProgress: event => progress.event(event, 'coach') });
    if (generation !== state.analysisGeneration || audioGeneration !== state.audioGeneration || signal.aborted || state.cancelRestartPending) return;
    state.report = { ...report, transcript: report.transcript || text, input: { targetScript: input.targetScript, targetTalkingPoints: input.targetTalkingPoints, targetMode: input.targetMode, plannedIntroduction: input.plannedIntroduction, plannedTransitions: input.plannedTransitions, instructorRubric: input.instructorRubric, rubricFileName: input.rubricFileName, assignmentInstructions: input.assignmentInstructions, assignmentFileName: input.assignmentFileName } };
    renderReport();
    progress.finish(report.analysis?.method === 'ai' && Number.isFinite(report.analysis.overallRating) ? 'complete' : 'partial', report.analysis?.method === 'ai' && Number.isFinite(report.analysis.overallRating) ? '' : 'Feedback is ready with limitations. Review the notice in your report.');
    window.rehearsalAccount?.track(report.analysis?.method === 'ai' ? 'analysis_completed' : 'analysis_failed');
    window.rehearsalAccount?.refreshHistory();
    setStatus(state.transcriptText !== text ? 'The transcript changed while feedback was being prepared. Update feedback to analyze your latest corrections.' : '');
    if (state.currentPage === 'rehearse' && viewGeneration === state.viewGeneration) $('summary-workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    progress.finish(error.name === 'AbortError' ? 'cancelled' : 'error', error.name === 'AbortError' ? '' : errorMessage(error));
    if (error.name !== 'AbortError') window.rehearsalAccount?.track('analysis_failed');
    if (generation === state.analysisGeneration) {
      if (error.name === 'AbortError') setStatus(state.config.hosted ? 'Stopped waiting. Your recording is safe; processing may still finish in saved rehearsals.' : 'Analysis stopped. Your recording is still here when you’re ready.');
      else setStatus(errorMessage(error), 'error');
    }
  } finally {
    if (generation === state.analysisGeneration) { state.requestController = null; setBusy(false); }
  }
}

function stat(label, value, caption) {
  const node = addText('div', '', 'stat');
  node.append(addText('div', label, 'stat-label'), addText('div', value, 'stat-value'), addText('div', caption, 'stat-caption'));
  return node;
}
function fillList(id, values, fallback) {
  $(id).replaceChildren();
  const list = Array.isArray(values) && values.length ? values : [fallback];
  list.forEach((value) => $(id).append(addText('li', textItem(value))));
}
function observation(title, label, type, detail, evidence) {
  const box = addText('div', '', 'observation');
  const heading = addText('div', '', 'observation-heading');
  heading.append(addText('h4', title), addText('span', label, `pill ${type}`));
  box.append(heading, addText('p', detail));
  const quotes = Array.isArray(evidence) ? evidence.map(textItem).filter(Boolean).join(' · ') : textItem(evidence);
  if (quotes) box.append(addText('p', `“${quotes}”`, 'evidence'));
  return box;
}
function renderCoachingState(report) {
  const complete = report.analysis?.method === 'ai';
  const ready = state.config.analysisConfigured;
  const failed = ['failed', 'invalid_response'].includes(report.meta?.coachingStatus);
  $('coaching-notice').hidden = complete;
  $('speech-analysis-content').hidden = !complete;
  $('analysis-disclaimer').hidden = !complete;
  $('coaching-title').textContent = failed ? 'AI coaching could not finish.' : ready ? 'Ready for your AI coach.' : 'Sign in for coaching.';
  $('coaching-description').textContent = state.config.coachingViaHost
    ? 'Analyze sends your current transcript and preparation text to this Codex conversation for feedback and annotations.'
    : 'Analyze reviews your transcript and preparation text. Your recordings, transcripts, and feedback are saved privately to your account.';
  $('coaching-action').textContent = ready ? (failed ? 'Retry AI coaching' : 'Analyze with AI') : 'Sign in';
  $('coaching-settings').hidden = true;
}
function renderReport() {
  const report = state.report;
  const words = report.wordStats || {};
  const blunders = report.blunders || {};
  const analysis = report.analysis || {};
  const fillers = words.fillers || {};
  $('report').hidden = false;
  const reportProvider = report.meta?.analysisProviderLabel || providerInfo(report.meta?.analysisProvider || report.analysisProvider || state.config.analysisProvider).label;
  $('report-source').textContent = analysis.method === 'ai' ? `${reportProvider.toUpperCase()} ANALYSIS` : 'LOCAL TEXT CHECK';
  $('report-subtitle').textContent = 'Your rehearsal, broken down into things you can act on.';
  $('report-rubric-badge').hidden = !report.input?.instructorRubric?.trim();
  $('report-assignment-badge').hidden = !report.input?.assignmentInstructions?.trim();
  $('report-transitions-badge').hidden = !report.input?.plannedTransitions?.trim();
  const warnings = [...(Array.isArray(report.warnings) ? report.warnings.map(textItem) : [])];
  if (analysis.method !== 'ai') warnings.unshift('Your transcript and word stats are ready. AI coaching is still needed for a speech rating and color annotations.');
  $('report-warnings').replaceChildren(...warnings.map((warning) => addText('p', warning)));
  $('report-warnings').hidden = !warnings.length;
  const pace = Number.isFinite(words.wordsPerMinute) ? Math.round(words.wordsPerMinute) : '—';
  const mostUsed = words.mostUsedWord;
  $('word-stats').replaceChildren(
    stat('Words spoken', String(words.totalWords ?? 0), `${formatTime(words.durationSeconds || state.duration)} rehearsal`),
    stat('Speaking pace', String(pace), 'words per minute · includes pauses'),
    stat('Most used word', mostUsed?.word ? `“${mostUsed.word}”` : '—', mostUsed ? `${mostUsed.count} ${mostUsed.count === 1 ? 'mention' : 'mentions'} · all words` : 'No words found'),
    stat('Potential fillers', String(fillers.total ?? 0), 'Transcript-based estimate'),
  );
  const repeats = Array.isArray(words.repetitions) ? words.repetitions : [];
  const repeatCount = repeats.reduce((sum, item) => sum + (Array.isArray(item.occurrences) ? item.occurrences.length : Number(item.count) || 1), 0);
  const pillData = [['um', fillers.um || 0], ['uh / er', (fillers.uh || 0) + (fillers.er || 0)], ['like · potential filler', fillers.likePotential || 0], ['like · other uses', fillers.likeLexical || 0], ['you know', fillers.youKnow || 0], ['I mean', fillers.iMean || 0], ['repeated phrases', repeatCount]];
  $('filler-stats').replaceChildren(...pillData.map(([label, count]) => { const node = addText('div', '', 'filler-pill'); node.append(addText('span', label), addText('strong', String(count))); return node; }));
  $('word-disclaimer').textContent = words.disclaimer || 'Counts reflect the transcript. Speech recognition may omit fillers. Repeated words are not a diagnosis of stuttering.';
  const top = Array.isArray(words.topWords) ? words.topWords.slice(0, 8) : [];
  $('top-words').replaceChildren(...top.map((item) => { const node = addText('div', item.word, 'word-pill'); node.append(addText('span', String(item.count))); return node; }));
  if (!top.length) $('top-words').append(addText('p', 'No repeated content words yet.', 'empty-note'));
  $('repetition-list').replaceChildren(...repeats.slice(0, 5).map((item) => addText('p', `Repeated: “${item.phrase}”${item.count ? ` (${item.count}×)` : ''}`)));
  const intro = blunders.introduction || {};
  const lost = blunders.lostPlace || {};
  $('blunder-list').replaceChildren(
    observation('Your introduction', intro.status === 'detected' ? 'Found' : intro.status === 'review' ? 'Opening to review' : 'Worth checking', intro.status === 'detected' ? 'good' : intro.status === 'review' ? 'neutral' : 'warning', intro.advice || (intro.status === 'detected' ? 'An introduction appeared in your transcript.' : 'Review your opening in the transcript. Your planned introduction may be paraphrased.'), intro.evidence),
    observation('Losing your place', lost.status === 'detected' ? 'Possible cue' : 'No explicit cue', lost.status === 'detected' ? 'warning' : 'neutral', lost.status === 'detected' ? 'The transcript contains a phrase that may suggest losing your place. Review the quote in context.' : 'No explicit lost-place phrases were found. Silence or a forgotten script cannot be reliably inferred from text.', lost.evidence),
  );
  const coverage = Array.isArray(blunders.targetCoverage) ? blunders.targetCoverage : [];
  const covered = coverage.filter((item) => item.status === 'covered').length;
  const lexical = coverage.some((item) => item.confidence === 'lexical');
  $('coverage-summary').textContent = coverage.length ? `${covered} of ${coverage.length} ${lexical ? 'word matches' : 'detected'}` : 'No targets provided';
  $('coverage-list').replaceChildren();
  if (!coverage.length) $('coverage-list').append(addText('p', 'Add your target script or speaking points, then update the feedback to check coverage.', 'empty-note'));
  coverage.forEach((item) => {
    const isCovered = item.status === 'covered';
    const partial = item.status === 'partial';
    const row = addText('div', '', `coverage-row ${isCovered ? 'covered' : ''}`);
    const content = addText('div', '');
    content.append(addText('p', item.text || item.point || 'Speaking point'));
    const evidence = Array.isArray(item.evidence) ? item.evidence.map(textItem).join(' · ') : textItem(item.evidence);
    if (evidence) content.append(addText('p', `“${evidence}”`, 'evidence'));
    if (item.note) content.append(addText('p', textItem(item.note), 'small-note'));
    row.append(addText('span', isCovered ? '✓' : partial ? '◐' : '○', 'coverage-symbol'), content, addText('span', isCovered ? (item.confidence === 'lexical' ? 'Word match' : 'Detected') : partial ? 'Partial' : 'Not detected', `pill ${isCovered ? 'good' : partial ? 'warning' : 'neutral'}`));
    $('coverage-list').append(row);
  });
  $('blunder-disclaimer').textContent = blunders.disclaimer || 'Coverage is an estimate from the transcript. Missing words can affect results; review the evidence before drawing conclusions.';
  const thesis = analysis.thesis || {};
  $('thesis-summary').textContent = textItem(thesis.summary) || 'A clear central idea needs more context.';
  $('thesis-clarity').textContent = textItem(thesis.clarity);
  $('thesis-evidence').textContent = textItem(thesis.evidence);
  $('thesis-evidence').hidden = !thesis.evidence;
  fillList('strengths', analysis.strengths, 'Review the transcript for the moments you want to keep.');
  fillList('improvements', analysis.improvements, 'State your main idea clearly and close with one specific next step.');
  fillList('rhetoric', analysis.rhetoric, 'A connected model analysis can help examine your argument, evidence, and rhetorical choices.');
  const rated = typeof analysis.overallRating === 'number' && Number.isFinite(analysis.overallRating);
  $('overall-rating').replaceChildren(addText('span', rated ? String(Math.round(analysis.overallRating)) : '—'));
  if (rated) $('overall-rating').append(addText('small', ' / 100'));
  $('rating-label').textContent = analysis.overallLabel || (rated ? 'A coaching estimate for this rehearsal' : 'Available with connected AI analysis');
  const rubric = Array.isArray(analysis.rubric) ? analysis.rubric : [];
  $('rubric').replaceChildren(...rubric.map((item) => {
    const row = addText('div', '', 'rubric-item');
    const line = addText('div', '', 'rubric-line');
    line.append(addText('span', item.criterion || 'Speech quality'), addText('span', Number.isFinite(item.score) ? `${item.score} / 5` : '—', 'rubric-score'));
    row.append(line, addText('p', textItem(item.reason)));
    return row;
  }));
  $('analysis-disclaimer').textContent = `${analysis.disclaimer || 'Ratings are coaching feedback, not an academic grade.'} Audio-only review does not assess slides, eye contact, posture, or audience response.`;
  renderCoachingState(report);
  if (!state.transcriptText) cacheTranscript(report.transcript || '');
  renderAnnotatedTranscript(report);
  $('transcript-details').hidden = false;
  $('prompt-details').hidden = false;
  markPromptStale();
  if ($('prompt-details').open) loadPromptPreview();
}
const ANNOTATION_LABELS = Object.freeze({ thesis: 'Thesis', evidence: 'Evidence', structure: 'Structure', delivery: 'Word habits', clarity: 'Clarity', great: 'Great sentence', impact: 'Impact sentence' });
function annotationSegments(text, annotations) {
  const source = String(text || '');
  const accepted = [];
  let end = 0;
  const candidates = Array.isArray(annotations) ? annotations.filter(item => item && typeof item === 'object').slice(0, MAX_TRANSCRIPT_ANNOTATIONS).sort((a, b) => a.start - b.start || a.end - b.end) : [];
  for (const item of candidates) {
    if (!Object.hasOwn(ANNOTATION_LABELS, item.category) || !Number.isInteger(item.start) || !Number.isInteger(item.end) ||
        item.start < end || item.end <= item.start || item.end > source.length || typeof item.quote !== 'string' ||
        source.slice(item.start, item.end) !== item.quote || typeof item.comment !== 'string' || !item.comment.trim()) continue;
    accepted.push({ ...item, assessment: annotationAssessment(item), number: accepted.length + 1 });
    end = item.end;
  }
  const segments = [];
  let position = 0;
  for (const annotation of accepted) {
    if (annotation.start > position) segments.push({ text: source.slice(position, annotation.start), annotation: null });
    segments.push({ text: source.slice(annotation.start, annotation.end), annotation });
    position = annotation.end;
  }
  if (position < source.length || !segments.length) segments.push({ text: source.slice(position), annotation: null });
  return segments;
}
function renderAnnotatedTranscript(report) {
  initializeTranscriptInteractions();
  const text = typeof report.transcript === 'string' ? report.transcript : '';
  const segments = annotationSegments(text, report.analysis?.method === 'ai' ? report.analysis.annotations : []);
  state.annotationPopover.setAnnotations(segments.filter(segment => segment.annotation).map(segment => segment.annotation));
  const container = $('annotated-transcript');
  const notes = $('annotations-notes');
  state.summaryTranscript = text;
  container.dataset.empty = String(!text.trim());
  renderDiscussableTranscript({ document, container, text, segments });
  notes.replaceChildren();
  for (const segment of segments) {
    if (!segment.annotation) continue;
    const item = segment.annotation;
    const note = addText('li', '', `annotation-${item.category}`);
    note.dataset.assessment = item.assessment;
    note.id = `annotation-note-${item.number}`;
    note.append(addText('strong', `${ANNOTATION_LABELS[item.category]}: `), document.createTextNode(item.comment));
    if (typeof item.suggestion === 'string' && item.suggestion.trim()) {
      const replacement = addText('p', '', 'annotation-note-suggestion');
      replacement.append(addText('strong', 'Suggested wording: '), document.createTextNode(item.suggestion.trim())); note.append(replacement);
    }
    notes.append(note);
  }
  const count = segments.filter(segment => segment.annotation).length;
  $('annotation-title').textContent = count ? 'Full annotated transcript' : 'Full transcript';
  $('annotation-legend').hidden = !count;
  container.setAttribute('aria-label', count ? 'Original transcript with AI annotations' : 'Original transcript');
  $('annotation-status').textContent = state.transcriptText && state.transcriptText !== text
    ? 'Showing the analyzed version. Your edits appear in playback; update feedback to annotate your corrected transcript.'
    : count ? `${count} AI coaching annotations. Click a marked passage for an explanation. Gold stars recognize great sentences; red underlines show wording to improve.`
      : report.analysis?.method === 'ai' ? 'No grounded annotations were returned for this analysis. Your complete transcript appears below.'
        : ['failed', 'invalid_response'].includes(report.meta?.coachingStatus)
          ? 'AI coaching did not finish, so no color annotations are available. Your complete transcript appears below.'
          : 'Your complete transcript appears below. Connect an AI coach above, then analyze it for color annotations.';
  $('download-transcript').disabled = !text.trim();
  syncChat();
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}
function buildAnnotatedDocument(report) {
  const text = typeof report?.transcript === 'string' ? report.transcript : '';
  const segments = annotationSegments(text, report?.analysis?.method === 'ai' ? report.analysis.annotations : []);
  const annotations = segments.filter(segment => segment.annotation).map(segment => segment.annotation);
  const star = '<span class="annotation-star" aria-hidden="true">★</span>';
  const transcript = segments.map(segment => {
    const item = segment.annotation;
    if (!item) return escapeHtml(segment.text);
    const label = item.category === 'great' ? `Read great sentence annotation ${item.number}` : item.category === 'impact' ? `Read impact sentence annotation ${item.number}` : `Read annotation ${item.number}`;
    return `<mark class="annotation-${item.category}" data-assessment="${item.assessment}" aria-describedby="note-${item.number}">${escapeHtml(segment.text)}</mark><a class="annotation-ref" href="#note-${item.number}" aria-label="${label}">${item.category === 'great' ? star : ''}[${item.number}]</a>`;
  }).join('');
  const notes = annotations.map(item => `<li class="annotation-${item.category}" id="note-${item.number}"><strong>${escapeHtml(ANNOTATION_LABELS[item.category])}:</strong> ${escapeHtml(item.comment)}${typeof item.suggestion === 'string' && item.suggestion.trim() ? `<p class="annotation-note-suggestion"><strong>Suggested wording:</strong> ${escapeHtml(item.suggestion.trim())}</p>` : ''}</li>`).join('');
  const legend = Object.entries(ANNOTATION_LABELS).map(([category, label]) => `<span class="annotation-${category}">${category === 'great' ? `${star} ` : ''}${escapeHtml(label)}</span>`).join(' ') + ' <span class="legend-needs-work">Needs work</span>';
  const markerStyles = `.transcript mark{box-decoration-break:clone;-webkit-box-decoration-break:clone}.annotation-great{background:transparent}.annotation-impact{background:#fff9ee}.transcript mark.annotation-great{text-shadow:0 0 7px #d4a13066;animation:annotation-great-glow 3s ease-in-out infinite}.transcript .annotation-star{animation:annotation-star-glow 3s ease-in-out infinite}.transcript mark.annotation-impact{background:linear-gradient(100deg,transparent 25%,#f3c76922 39%,#f3c76999 50%,#f3c76922 61%,transparent 75%) 180% 0/260% 100% no-repeat;background-color:#fff9ee;text-shadow:0 0 6px #ddb45a40;padding:2px 0;animation:annotation-impact-sweep 3.8s ease-in-out infinite}.transcript mark[data-assessment="needs_work"],.legend-needs-work{background:transparent;text-decoration-line:underline;text-decoration-color:#c55050;text-decoration-thickness:1.5px;text-underline-offset:4px}.annotation-note-suggestion{margin:6px 0 0;color:inherit}@keyframes annotation-great-glow{0%,100%{text-shadow:0 0 4px #d4a13040}50%{text-shadow:0 0 8px #d4a13080}}@keyframes annotation-star-glow{0%,100%{text-shadow:0 0 2px #e2b54160}50%{text-shadow:0 0 7px #dba120d9;color:#b47c05}}@keyframes annotation-impact-sweep{0%,12%{background-position:180% 0}75%,100%{background-position:-80% 0}}@media(prefers-reduced-motion:reduce){.transcript mark.annotation-great,.transcript .annotation-star{animation:none}.transcript mark.annotation-impact{animation:none;background-image:none;text-shadow:none}}@media print{.transcript mark.annotation-great,.transcript .annotation-star{animation:none;text-shadow:none}.transcript mark.annotation-impact{animation:none;background-image:none;text-shadow:none}}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Dress Rehearsal — annotated transcript</title><style>body{font:16px/1.65 system-ui,sans-serif;color:#29262d;max-width:850px;margin:48px auto;padding:0 24px}h1{font-size:28px;line-height:1.2}p{color:#655f6b}.legend{display:flex;flex-wrap:wrap;gap:8px;margin:24px 0}.legend>span,mark{padding:2px 5px;border-radius:4px;color:inherit}.transcript{white-space:pre-wrap;font-size:19px;line-height:1.9;overflow-wrap:anywhere}.annotation-thesis{background:#f0e9f7}.annotation-evidence{background:#e8f4ea}.annotation-structure{background:#e8f1fa}.annotation-delivery{background:#fbf2dc}.annotation-clarity{background:#faeaf0}.annotation-star{color:#a7770d;font-size:1.2em;line-height:1}.annotation-ref .annotation-star{margin-right:3px}.annotation-ref{font-size:11px;vertical-align:super;color:#5d347c;text-decoration:none;margin:0 3px;white-space:nowrap}li{padding:8px;margin:0 0 4px;overflow-wrap:anywhere}footer{font-size:13px;color:#655f6b;margin-top:32px}@media print{body{margin:0;max-width:none}mark,.legend>span,li,.annotation-star{print-color-adjust:exact;-webkit-print-color-adjust:exact}}${markerStyles}</style></head><body><h1>${annotations.length ? 'Full annotated transcript' : 'Full transcript'}</h1><p>${annotations.length ? 'AI coaching notes on selected passages. Stars recognize great sentences.' : 'Original transcript. No grounded AI coaching annotations were available.'} The text below preserves the analyzed transcript; suggestions are separate.</p><div class="legend" aria-label="Annotation categories">${legend}</div><div class="transcript">${transcript}</div>${notes ? `<h2>Coaching notes</h2><ol>${notes}</ol>` : ''}<footer>Dress Rehearsal · Neeley presentation practice. Annotations are coaching suggestions, not an academic grade. Speech recognition can make mistakes.</footer></body></html>`;
}
async function downloadAnnotatedTranscript() {
  const report = state.report || { transcript: state.summaryTranscript || state.transcriptText };
  if (!report.transcript?.trim()) return;
  const blob = new Blob([buildAnnotatedDocument(report)], { type: 'text/html;charset=utf-8' });
  try { await downloadBlob(blob, `dress-rehearsal-transcript-${new Date().toISOString().slice(0, 10)}.html`); }
  catch (error) { setStatus(errorMessage(error), 'error'); }
}
async function downloadReport() {
  if (!state.report) return;
  const payload = { ...state.report, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  try { await downloadBlob(blob, `dress-rehearsal-${new Date().toISOString().slice(0, 10)}.json`); }
  catch (error) { setStatus(errorMessage(error), 'error'); }
}

window.rehearsalHostedActions = {
  updateConfig,
  configurationReady() { state.recoveryNeedsConfig = false; },
  configurationFailed(message) {
    state.recoveryNeedsConfig = true;
    if (!state.recoveryController) state.recoveryPending = false;
    $('cloud-recovery').hidden = false;
    $('cloud-recovery-message').textContent = `The account connection could not be restored. ${message || 'Check your connection.'} Retry to reconnect and check your previous request.`;
    $('cloud-recovery-retry').hidden = false;
    $('cloud-recovery-cancel').hidden = true;
    syncRecordingControls(); syncAnalysisControls();
  },
  async recoverPending() {
    if (!window.rehearsalService?.getPendingRequest || state.recoveryController) return;
    const account = state.accountId;
    const generation = state.audioGeneration;
    const idle = !state.recording && !state.startingRecording && !state.busy && !state.requestingMic && !state.transcriptPromise && !state.liveTake && !state.livePromise;
    const controller = new AbortController();
    state.recoveryController = controller;
    state.recoveryPending = true;
    syncRecordingControls(); syncAnalysisControls();
    const current = () => !state.cancelRestartPending && state.accountId === account && state.audioGeneration === generation && state.recoveryController === controller;
    $('cloud-recovery-retry').hidden = true;
    $('cloud-recovery-cancel').hidden = true;
    try {
      const marker = await window.rehearsalService.getPendingRequest();
      if (!current()) return;
      if (!marker) { $('cloud-recovery').hidden = true; return; }
      if (!idle || state.audioBlob && state.cloudRecordingId !== marker.recordingId) {
        throw new Error('Finish or clear your current take before recovering the previous request.');
      }
      $('cloud-recovery').hidden = false;
      $('cloud-recovery-cancel').hidden = false;
      const result = await window.rehearsalService.recoverPending(marker, { signal: controller.signal,
        onProgress: message => { if (current()) $('cloud-recovery-message').textContent = message; } });
      if (!current()) return;
      state.recoveryPending = false;
      if (result.record) window.rehearsalHostedActions.restoreRecording(result.record);
      $('cloud-recovery-message').textContent = result.message;
      $('cloud-recovery-cancel').hidden = true;
      window.rehearsalAccount?.refreshHistory();
    } catch (error) {
      if (current()) {
        $('cloud-recovery').hidden = false;
        $('cloud-recovery-message').textContent = errorMessage(error);
        $('cloud-recovery-retry').hidden = false;
      }
    } finally {
      if (state.recoveryController === controller) {
        state.recoveryController = null; state.recoveryPending = false;
        syncRecordingControls(); syncAnalysisControls();
      }
    }
  },
  canReplaceAudio: canReplaceCurrentAudio,
  captureViewGeneration,
  isViewGenerationCurrent,
  accountChanged(id) {
    if (state.accountId === id) return;
    state.accountId = id;
    state.chatContextKey++;
    syncChat();
    state.cancelConfirmation = null; $('cancel-restart-dialog').close();
    state.recoveryController?.abort(); state.recoveryController = null;
    state.recoveryNeedsConfig = false;
    state.recoveryPending = Boolean(id && window.rehearsalService?.getPendingRequest);
    $('cloud-recovery').hidden = true;
    state.audioPreparationGeneration++;
    state.audioMetadataCancel?.();
    state.preparingAudio = false;
    cancelLiveSession();
    if (state.recording) stopRecording();
    cleanupMic(); discardAudio();
    for (const field of ['target-script', 'target-talking-points', 'planned-introduction', 'planned-transitions', 'instructor-rubric']) $(field).value = '';
    removeRubric(); removeAssignment(); updateTargetHint();
    setBusy(false); setStatus('');
    state.config.auth = { signedIn: Boolean(id) };
    state.config.analysisConfigured = false;
    updateConfig(state.config);
  },
  restoreRecording(record, { showRehearse = false, viewGeneration } = {}) {
    if (viewGeneration && !isViewGenerationCurrent(viewGeneration)) return;
    if (!window.rehearsalHostedActions.canReplaceAudio()) throw new Error('Finish your current take before opening another recording.');
    state.chatContextKey++;
    syncChat();
    setAudio(record.blob, record.durationSeconds, record.title || 'My rehearsal');
    state.cloudRecordingId = record.id;
    if (record.transcript) cacheTranscript(record.transcript);
    const input = record.report?.input || record.report?.meta;
    if (input) {
      removeRubric(); removeAssignment();
      for (const [field, key] of [['target-script', 'targetScript'], ['target-talking-points', 'targetTalkingPoints'], ['planned-introduction', 'plannedIntroduction'], ['planned-transitions', 'plannedTransitions'], ['instructor-rubric', 'instructorRubric'], ['assignment-instructions', 'assignmentInstructions']]) $(field).value = typeof input[key] === 'string' ? input[key] : '';
      state.rubricFileName = input.rubricFileName || ''; updateTargetHint(); updateRubricControls();
      state.assignmentFileName = typeof input.assignmentFileName === 'string' ? input.assignmentFileName : ''; preparationDocuments.assignment.updateControls();
      $('rubric-status').textContent = input.instructorRubric ? 'Saved rubric text restored. Choose the original file to see its preview again.' : 'No rubric was saved with this rehearsal.';
      $('assignment-status').textContent = input.assignmentInstructions ? 'Saved assignment instructions restored. Choose the original file to see its preview again.' : 'No assignment instructions were saved with this rehearsal.';
    }
    if (record.report) { state.report = record.report; renderReport(); }
    $('audio-save-status').textContent = 'Saved privately to your account.';
    $('record-title').textContent = 'Live Transcript';
    setStatus('Saved rehearsal opened. Replay does not upload or reprocess the recording.');
    if (showRehearse) showPage('rehearse');
  },
  recordingDeleted(id) {
    if (state.cloudRecordingId !== id) return;
    state.cloudRecordingId = '';
    resetTranscriptForModelChange();
    showTranscriptReadyState();
    $('audio-save-status').textContent = 'Cloud copy deleted. This open take remains in this tab; analyzing it again will create a new cloud copy.';
  },
};

$('settings-open').addEventListener('click', openSettings);
$('rehearse-tab').addEventListener('click', () => showPage('rehearse'));
$('history-tab').addEventListener('click', () => {
  if (state.config.hosted && !state.config.auth?.signedIn) { openSettings(); return; }
  showPage('history');
});
$('new-rehearsal').addEventListener('click', startNewRehearsal);
window.addEventListener('hashchange', () => {
  const page = window.location?.hash?.slice(1);
  if (page === 'rehearse' || page === 'history') showPage(page);
});
if (window.location?.hash === '#history') showPage('history', { focus: false, initial: true });
$('cloud-recovery-retry').addEventListener('click', async () => {
  if ($('cloud-recovery-retry').disabled) return;
  if (!state.recoveryNeedsConfig) return window.rehearsalHostedActions.recoverPending();
  $('cloud-recovery-retry').disabled = true;
  state.recoveryPending = true; syncRecordingControls(); syncAnalysisControls();
  try { await window.rehearsalAccount.refresh(); }
  finally { $('cloud-recovery-retry').disabled = false; }
});
for (const id of ['cancel-recording', 'cancel-analysis', 'cloud-recovery-cancel']) $(id).addEventListener('click', openCancelRestart);
$('cancel-restart-keep').addEventListener('click', closeCancelRestart);
$('cancel-restart-confirm').addEventListener('click', confirmCancelRestart);
$('cancel-restart-dialog').addEventListener('pointermove', event => {
  const confirmation = state.cancelConfirmation;
  if (confirmation && Math.hypot(event.clientX - confirmation.x, event.clientY - confirmation.y) >= 12) confirmation.moved = true;
});
$('cancel-restart-dialog').addEventListener('cancel', event => { if (state.cancelRestartPending) event.preventDefault(); else state.cancelConfirmation = null; });
$('coaching-action').addEventListener('click', () => state.config.analysisConfigured ? runAnalysis({ corrected: true }) : openSettings());
$('coaching-settings').addEventListener('click', openSettings);
$('prompt-details').addEventListener('toggle', () => { if ($('prompt-details').open) loadPromptPreview(); });
$('refresh-prompt').addEventListener('click', loadPromptPreview);
$('copy-prompt').addEventListener('click', copyPrompt);
$('transcript').addEventListener('input', () => {
  cacheTranscript($('transcript').value);
  if (state.report) renderAnnotatedTranscript(state.report);
});
$('target-script').addEventListener('input', markPromptStale);
$('target-talking-points').addEventListener('input', markPromptStale);
$('target-view-points').addEventListener('click', () => setTargetView('points'));
$('target-view-script').addEventListener('click', () => setTargetView('script'));
$('planned-introduction').addEventListener('input', markPromptStale);
$('planned-transitions').addEventListener('input', () => { $('remove-transitions').hidden = !$('planned-transitions').value; markPromptStale(); });
$('remove-transitions').addEventListener('click', () => { $('planned-transitions').value = ''; $('remove-transitions').hidden = true; markPromptStale(); });
for (const attachment of Object.values(preparationDocuments)) attachment.listen();
$('target-script').addEventListener('input', updateTargetHint);
$('target-talking-points').addEventListener('input', updateTargetHint);
$('enable-mic').addEventListener('click', async () => { if (state.stream) cleanupMic(); else await enableMic(); });
$('audio-input').addEventListener('pointerdown', openInputSelector);
$('audio-input').addEventListener('keydown', openInputSelector);
$('audio-input').addEventListener('focus', enumerateInputs);
$('audio-input').addEventListener('change', async () => { if (!state.recording) await enableMic($('audio-input').value); });
$('record-button').addEventListener('click', async () => {
  try { if (state.recording) stopRecording(); else await startRecording(); }
  catch (error) { setStatus(errorMessage(error), 'error'); }
});
$('pause-recording').addEventListener('click', toggleRecordingPause);
$('playback-toggle').addEventListener('click', togglePlayback);
$('playback-scrub').addEventListener('pointerdown', () => { state.scrubbing = true; });
$('playback-scrub').addEventListener('input', () => seekPlayback(Number($('playback-scrub').value)));
$('playback-scrub').addEventListener('change', () => { state.scrubbing = false; updatePlaybackUI(); });
$('playback-scrub').addEventListener('pointerup', () => { state.scrubbing = false; updatePlaybackUI(); });
$('playback-scrub').addEventListener('pointercancel', () => { state.scrubbing = false; updatePlaybackUI(); });
$('playback-scrub').addEventListener('blur', () => { state.scrubbing = false; updatePlaybackUI(); });
$('playback-scrub').addEventListener('keydown', event => {
  const duration = playbackDuration();
  const current = $('playback').currentTime || 0;
  const positions = { ArrowRight: current + 5, ArrowUp: current + 5, ArrowLeft: current - 5, ArrowDown: current - 5, Home: 0, End: duration, PageUp: current + duration / 10, PageDown: current - duration / 10 };
  if (Object.hasOwn(positions, event.key)) { event.preventDefault(); seekPlayback(positions[event.key]); }
});
for (const name of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeked']) $('playback').addEventListener(name, () => {
  if (name === 'loadedmetadata' && state.pendingSeek !== null) seekPlayback(state.pendingSeek);
  updatePlaybackUI();
});
$('playback').addEventListener('play', () => { stopPlaybackLoop(); playbackLoop(); maybeTranscribeForPlayback(); });
for (const name of ['pause', 'ended']) $('playback').addEventListener(name, () => { stopPlaybackLoop(); updatePlaybackUI(); });
$('playback').addEventListener('error', () => { stopPlaybackLoop(); if (state.audioBlob) setStatus('The recording could not be played. Try uploading it again.', 'error'); });
$('follow-transcript-connect').addEventListener('click', () => ensureTranscript().catch(() => {}));
$('discard-audio').addEventListener('click', () => discardAudio());
$('download-audio').addEventListener('click', downloadCurrentAudio);
$('saved-recordings-details').addEventListener('toggle', () => { if ($('saved-recordings-details').open) refreshSavedRecordings(); });
$('upload-button').addEventListener('click', () => {
  if (state.config.hosted && !state.config.auth?.signedIn) { openSettings(); setStatus('Sign in to upload and automatically transcribe your recording.'); return; }
  $('audio-upload').click();
});
$('audio-upload').addEventListener('change', () => uploadAudio($('audio-upload').files[0]));
$('analyze-button').addEventListener('click', () => runAnalysis());
$('live-transcription-cancel').addEventListener('click', () => { cancelLiveSession(); showLiveFallback('Live transcription was canceled. Retry the complete recording after you stop.'); });
$('reanalyze-button').addEventListener('click', () => runAnalysis({ corrected: true }));
$('download-report').addEventListener('click', downloadReport);
$('download-transcript').addEventListener('click', downloadAnnotatedTranscript);
$('print-report').addEventListener('click', () => window.print());
$('practice-again').addEventListener('click', () => {
  document.querySelector('.record-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('record-button').focus({ preventScroll: true });
});
navigator.mediaDevices?.addEventListener('devicechange', enumerateInputs);
window.addEventListener('focus', () => { enumerateInputs(); refreshSavedRecordings(); });
window.addEventListener('beforeunload', warnBeforeLeaving);
window.addEventListener('pagehide', (event) => { if (event.persisted) return; for (const [key, attachment] of Object.entries(preparationDocuments)) { state[key + 'Generation']++; attachment.clearPreview(); } state.annotationPopover?.dispose(); state.chat?.dispose(); state.processing?.clear(); clearInterval(state.timer); stopPlaybackLoop(); cleanupMic(); cancelLiveSession(); if (state.audioURL) URL.revokeObjectURL(state.audioURL); state.requestController?.abort(); state.transcriptController?.abort(); });

state.chat = createRehearsalChat({ document, request: api, getContext: getChatContext, onSignIn: openSettings });
renderSummaryDraft();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { enumerateInputs(); if (state.context?.state === 'suspended' && state.recording) state.context.resume().catch(() => {}); } });
initializeInputDetection();
refreshSavedRecordings();
setTargetView(state.targetView);
updateTargetHint();
for (const attachment of Object.values(preparationDocuments)) attachment.updateControls();
$('remove-transitions').hidden = !$('planned-transitions').value;
initializeWaveform();
updatePlaybackUI();
if (state.config.hosted) updateConfig(state.config);
window.rehearsalService?.setProgressHandler?.((message) => {
  if (typeof message !== 'string' || !message) return;
  if (state.transcriptController) $('follow-transcript-status').textContent = message;
  if (state.busy) setStatus(message, 'busy');
});
window.rehearsalService?.setRecordingSavedHandler?.((blob, id) => {
  if (state.audioBlob !== blob) return;
  state.cloudRecordingId = id;
  $('audio-save-status').textContent = 'Saved privately to your account. Transcription and coaching can be retried without uploading again.';
  window.rehearsalAccount?.refreshHistory();
});
api('/api/config').then(updateConfig).catch(error => setStatus(errorMessage(error), 'error'));
