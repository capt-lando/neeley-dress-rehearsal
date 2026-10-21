import { readFileSync } from 'node:fs';
import { buildAnalysisPrompt as buildCorePrompt, buildCoachingInstructions as validatePolicy } from './analysis-core.mjs';

export { analyzeSpeech, sanitizeAiFeedback } from './analysis-core.mjs';

// The Node server rereads this editable policy for every request. Browser builds
// import the same Markdown as raw text and pass it to the pure analysis core.
const COACHING_PROMPT_PATH = new URL('./coaching-prompt.md', import.meta.url);

export function buildCoachingInstructions() {
  return validatePolicy(readFileSync(COACHING_PROMPT_PATH, 'utf8'));
}

export function buildAnalysisPrompt(input = {}) {
  return buildCorePrompt(input, buildCoachingInstructions());
}
