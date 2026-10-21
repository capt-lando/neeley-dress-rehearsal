import policyText from '../lib/coaching-prompt.md?raw';
import { createBrowserService } from '../lib/browser-service.mjs';
import { transcribeLocally } from './local-speech.js';
import { installBrowserTools } from './browser-tools.js';

installBrowserTools(createBrowserService({ policyText, transcribe: transcribeLocally }));
await import('./app.js');
