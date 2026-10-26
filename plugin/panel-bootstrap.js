import policyText from '../lib/coaching-prompt.md?raw';
import { createBrowserService } from '../lib/browser-service.mjs';
import { transcribeLocally } from '../public/local-speech.js';
import { installBrowserTools } from '../public/browser-tools.js';
import InlineSpeechWorker from '../public/speech-worker.js?worker&inline';
import { createPanelBridge, createPanelService } from './panel-bridge.mjs';

globalThis.rehearsalCreateSpeechWorker = () => new InlineSpeechWorker();
const bridge = createPanelBridge();
const service = createPanelService({ browserService: createBrowserService({ policyText, transcribe: transcribeLocally }), bridge });
installBrowserTools(service);
window.rehearsalDownloads = { download: (blob, name) => bridge.download(blob, name) };

// Keep the shared page and renderer, removing account setup from this host surface.
const $ = id => document.getElementById(id);
document.documentElement.dataset.coachingHost = 'codex';
$('connection-label').textContent = 'Codex coaching';
$('settings-title').textContent = 'Rehearsal settings';
document.querySelector('#settings-form > .support-text').textContent = 'Coaching uses this Codex conversation. Choose the speech model that runs on your device.';
for (const node of document.querySelectorAll('#settings-form > .provider-picker, #settings-form > .setup-step, #settings-form > .advanced-settings, #settings-form > .small-note')) {
  node.hidden = true;
  node.querySelectorAll('input, button, a').forEach(control => { control.disabled = true; control.tabIndex = -1; });
}
const privacy = document.querySelector('.key-privacy-note');
privacy.replaceChildren();
const privacyTitle = document.createElement('strong');
privacyTitle.textContent = 'Coaching uses your text. Audio is processed on your device.';
const privacyCopy = document.createElement('p');
privacyCopy.textContent = 'Analyze sends your transcript, preparation text, and extracted rubric text through this plugin to the current conversation. Raw audio and full rubric files are never sent for coaching. Your conversation’s history and data settings apply. Completed recordings save in this browser when storage is available. Clearing site data or private browsing can remove them. Download sends your chosen file to the host’s download handler to save a copy. Speech model files may remain cached.';
privacy.append(privacyTitle, privacyCopy);
$('speech-download-note').textContent = 'Your chosen model downloads from Hugging Face and runs on your device. Model files can remain cached. The first transcript takes longer while they download. If this host blocks local speech processing, paste your transcript below.';
$('coaching-settings').textContent = 'Speech settings';
$('print-report').hidden = true;
document.querySelector('#prompt-details > .support-text').textContent = 'See the full coaching instructions and transcript prepared for Codex. This preview uses your latest edits and stays on your device.';

// Reuse the existing editor outside the report so blocked mic/worker access is recoverable.
const editor = $('transcript-details');
document.querySelector('#transcript-details summary span').textContent = 'Paste or correct your transcript';
document.querySelector('#transcript-details > .support-text').textContent = 'Paste a transcript to get coaching without recording, or correct speech-recognition mistakes before updating your feedback.';
$('transcript').placeholder = 'Paste your rehearsal transcript here…';
$('report').before(editor);
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

await import('../public/app.js');

function hostNotice(message) {
  $('app-status').textContent = message;
  $('app-status').className = 'app-status error';
  $('app-status').hidden = false;
}
bridge.initialize().then(result => {
  const permissions = result.hostCapabilities?.sandbox?.permissions;
  const policy = document.permissionsPolicy || document.featurePolicy;
  const microphoneBlocked = (permissions && !Object.hasOwn(permissions, 'microphone')) || policy?.allowsFeature?.('microphone') === false;
  if (microphoneBlocked) {
    $('mic-status').textContent = 'This host has not enabled microphone access';
    hostNotice('Microphone access is unavailable in this panel. You can upload a recording or paste a transcript for coaching.');
  }
}).catch(error => hostNotice(`${error.message} You can still prepare and correct your transcript here.`));
