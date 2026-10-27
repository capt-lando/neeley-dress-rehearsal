import { transcribeChunkLocally, preloadLocalSpeech } from './local-speech.js';
import { createLiveTranscription } from '../lib/live-transcription.mjs';
import { extractRubric } from './rubric-documents.js';
import { createRecordingStore } from '../lib/recording-store.mjs';

// Both the standalone page and Codex panel use the same local audio/document tools.
export function installBrowserTools(service, { liveSpeech = true } = {}) {
  window.rehearsalService = service;
  window.rehearsalDocuments = { extractRubric };
  window.rehearsalRecordings = createRecordingStore();
  let liveSession;
  window.rehearsalLiveSpeech = service.hosted ? {
    startSession(options) {
      liveSession?.cancel();
      liveSession = service.startLiveSession(options);
      return liveSession;
    },
  } : liveSpeech ? {
    startSession({ model, sampleRate, onUpdate, onProgress }) {
      liveSession?.cancel();
      liveSession = createLiveTranscription({
        sampleRate, onUpdate,
        prepare: async ({ signal }) => {
          await preloadLocalSpeech({ model, signal, onProgress });
          onProgress?.('English speech model ready on this device.');
        },
        transcribe: (samples, options) => transcribeChunkLocally(samples, { ...options, model }),
      });
      return liveSession;
    },
  } : null;
  window.addEventListener('pagehide', event => {
    if (!event.persisted) { liveSession?.cancel(); service.dispose(); window.rehearsalRecordings.close(); }
  });
}
