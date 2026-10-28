import { normalizeConversationStarter } from './analysis-core.mjs';
export { normalizeConversationStarter, MAX_CONVERSATION_STARTER } from './analysis-core.mjs';
export const DEFAULT_CONVERSATION_STARTER = 'Let’s make your next rehearsal useful. What would you like to work on?';

function excerpt(value, max) {
  if (typeof value !== 'string' || /[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1), space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

export function conversationStarterFor(report, { hasTranscript = false } = {}) {
  const analysis = report?.analysis;
  if (analysis?.method === 'ai') {
    const generated = normalizeConversationStarter(analysis.conversationStarter);
    if (generated) return generated;
    const improvement = (Array.isArray(analysis.improvements) ? analysis.improvements : [])
      .map(item => excerpt(typeof item === 'string' ? item : item?.text ?? item?.advice, 230)).find(Boolean);
    if (improvement) return `Your feedback suggests “${improvement}” What would help you try that in your next take?`;
    const annotations = Array.isArray(analysis.annotations) ? analysis.annotations : [];
    const grounded = annotations.filter(item => typeof item?.quote === 'string' && item.quote.trim() &&
      typeof report.transcript === 'string' && report.transcript.includes(item.quote) && excerpt(item.comment, 150));
    const annotation = grounded.find(item => item.assessment === 'needs_work') || grounded[0];
    if (annotation) {
      const quote = excerpt(annotation.quote, 150), comment = excerpt(annotation.comment, 150);
      if (quote) return `Let’s revisit “${quote}” Your feedback notes: “${comment}” How would you build on that in your next take?`;
    }
    const thesis = excerpt(analysis.thesis?.summary, 230);
    if (thesis) return `Your feedback identifies “${thesis}” as your central idea. How would you like to make that case more convincing?`;
  }
  return hasTranscript || report
    ? 'We can work through this take together. What would you most like to strengthen before your next rehearsal?'
    : DEFAULT_CONVERSATION_STARTER;
}
