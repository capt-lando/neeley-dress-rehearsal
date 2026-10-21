import policyText from '../lib/coaching-prompt.md?raw';
import { createBrowserService } from '../lib/browser-service.mjs';
import { transcribeLocally, transcribeChunkLocally, preloadLocalSpeech } from './local-speech.js';
import { createLiveTranscription } from '../lib/live-transcription.mjs';
import { extractRubric } from './rubric-documents.js';
import { createRecordingStore } from '../lib/recording-store.mjs';

window.rehearsalService = createBrowserService({ policyText, transcribe: transcribeLocally });
window.rehearsalDocuments = { extractRubric };
window.rehearsalRecordings = createRecordingStore();
let liveSession;
window.rehearsalLiveSpeech = {
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
};
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) { liveSession?.cancel(); window.rehearsalService.dispose(); window.rehearsalRecordings.close(); }
});
await import('./app.js');
