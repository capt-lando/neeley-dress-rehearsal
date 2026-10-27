import { readHostedConfig } from './hosted-service.mjs';

const SECRET_PATTERNS = [
  ['provider API key', /\bsk-(?:proj-|svcacct-|ant-(?:api\d{2}-)?)?[A-Za-z0-9_-]{40,}\b/],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['PEM private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----(?:\\[rn]|[\r\n\t ])+[A-Za-z0-9+/=]{32,}/],
];

/** Examine generated text only; diagnostics never include matched credentials. */
export function assertPublicBundleSafe(bundle) {
  const findings = [];
  for (const file of Object.values(bundle)) {
    if (file.type !== 'chunk' && !/\.(?:[cm]?js|html|css|json|map)$/i.test(file.fileName)) continue;
    let text = file.type === 'chunk' ? file.code : file.source;
    if (text instanceof Uint8Array) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(text); } catch { continue; }
    }
    if (typeof text !== 'string') continue;
    const categories = SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
    for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}/g)) {
      try {
        if (JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString()).role === 'service_role') {
          categories.push('Supabase service-role JWT'); break;
        }
      } catch { /* Not a JWT payload. */ }
    }
    if (categories.length) findings.push(`${file.fileName} (${categories.join(', ')})`);
  }
  if (findings.length) throw new Error(`Public build blocked: credential-shaped content in ${findings.join('; ')}. Remove private credentials from browser files.`);
}

export function webContentSecurityPolicy(env = {}) {
  const hosted = readHostedConfig(env);
  return [
    "default-src 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'none'", "frame-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
    "media-src 'self' blob:", "worker-src 'self' blob:",
    `connect-src 'self'${hosted ? ` ${hosted.url} ${hosted.url.replace(/^http/, 'ws')}` : ''}`,
  ].join('; ');
}

export function webSecurityPlugin(env = {}) {
  const policy = webContentSecurityPolicy(env);
  return {
    name: 'web-security-policy',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'pre',
      handler: () => [
        { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' },
        { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
      ],
    },
    generateBundle: { order: 'post', handler(_options, bundle) { assertPublicBundleSafe(bundle); } },
  };
}

// frame-ancestors requires an HTTP response header; it cannot protect a GitHub
// Pages deployment through a meta tag. Add that header when hosting supports it.
