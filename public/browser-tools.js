import { extractRubric } from './rubric-documents.js';
import { createRecordingStore } from '../lib/recording-store.mjs';

// Audio capture and rubric extraction stay in the browser; speech uses the service.
export function installBrowserTools(service) {
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
  } : null;
  window.addEventListener('pagehide', event => {
    if (!event.persisted) { service.dispose(); window.rehearsalRecordings.close(); }
  });
}
