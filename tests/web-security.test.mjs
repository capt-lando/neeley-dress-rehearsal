import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { webContentSecurityPolicy, webSecurityPlugin, assertPublicBundleSafe } from '../lib/web-security.mjs';

const hosted = { VITE_SUPABASE_URL: 'https://pilot.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_build_test' };
const directives = policy => Object.fromEntries(policy.split('; ').map(item => { const [name, ...values] = item.split(' '); return [name, values]; }));

test('hosted policy permits only its exact backend and required browser assets', () => {
  const policy = directives(webContentSecurityPolicy(hosted));
  assert.deepEqual(policy['connect-src'], ["'self'", 'https://pilot.supabase.co', 'wss://pilot.supabase.co']);
  assert.deepEqual(policy['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(policy['worker-src'], ["'self'", 'blob:']);
  assert.deepEqual(policy['media-src'], ["'self'", 'blob:']);
  assert.deepEqual(policy['img-src'], ["'self'", 'data:']);
  assert.deepEqual(policy['frame-src'], ["'self'"], 'local document previews must not permit remote, data, or blob frames');
  for (const name of ['default-src', 'base-uri', 'object-src', 'form-action']) assert.deepEqual(policy[name], ["'none'"]);
  assert.ok(!policy['frame-ancestors'], 'frame-ancestors is ineffective in a meta tag');
});

test('unconfigured preview cannot reach remote providers or load remote scripts', () => {
  const policy = directives(webContentSecurityPolicy());
  assert.deepEqual(policy['connect-src'], ["'self'"]);
  assert.deepEqual(policy['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(policy['frame-src'], ["'self'"]);
  assert.ok(!policy['script-src'].includes("'unsafe-eval'") && !policy['script-src'].includes("'unsafe-inline'"));
  assert.ok(!Object.values(policy).flat().some(value => value === '*' || value === 'https:'));
});

test('invalid hosted configuration cannot widen or silently disable the policy', () => {
  for (const url of ['https://pilot.supabase.co/path', "https://pilot.supabase.co;script-src *", 'https://user:password@pilot.supabase.co', 'http://pilot.supabase.co']) {
    assert.throws(() => webContentSecurityPolicy({ ...hosted, VITE_SUPABASE_URL: url }));
  }
  assert.throws(() => webContentSecurityPolicy({ VITE_SUPABASE_URL: hosted.VITE_SUPABASE_URL }));
  assert.throws(() => webContentSecurityPolicy({ ...hosted, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_not_public' }));
});

const jwt = role => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.synthetic_signature_for_build_test`;
const syntheticSecrets = [
  ['provider API key', `sk-proj-${'X'.repeat(50)}`],
  ['provider API key', `sk-ant-api03-${'Y'.repeat(50)}`],
  ['provider API key', `sk-${'Z'.repeat(48)}`],
  ['Supabase secret key', `sb_secret_${'Q'.repeat(32)}`],
  ['Supabase service-role JWT', jwt('service_role')],
  ['GitHub token', `ghp_${'G'.repeat(36)}`],
  ['GitHub token', `github_pat_${'P'.repeat(80)}`],
  ['PEM private key', `-----BEGIN PRIVATE KEY-----\n${'M'.repeat(64)}\n-----END PRIVATE KEY-----`],
];

test('public build rejects private credential formats across emitted text without echoing values', () => {
  for (const [category, secret] of syntheticSecrets) for (const extension of ['js', 'html', 'css', 'json']) {
    const fileName = `assets/leak.${extension}`;
    const source = JSON.stringify({ accidentallyPublic: secret });
    const file = extension === 'js' ? { type: 'chunk', fileName, code: `export default ${source}` }
      : { type: 'asset', fileName, source: new TextEncoder().encode(source) };
    assert.throws(() => assertPublicBundleSafe({ [fileName]: file }), error => {
      assert.ok(error.message.includes(fileName) && error.message.includes(category));
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes(secret.split('\n')[1] || secret));
      return true;
    });
  }
});

test('public values, token validation patterns, and binary assets do not trigger the credential check', () => {
  const source = JSON.stringify({ publicKey: 'sb_publishable_expected_public_key', anonymousKey: jwt('anon'),
    keyPattern: String.raw`/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{40,}/`,
    pemPattern: String.raw`/-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=]+/`, example: 'sk-proj-your-key-here' });
  assert.doesNotThrow(() => assertPublicBundleSafe({
    safe: { type: 'chunk', fileName: 'assets/app.js', code: source },
    binary: { type: 'asset', fileName: 'assets/model.wasm', source: new TextEncoder().encode(syntheticSecrets[0][1]) },
  }));
});

test('production build fails when another plugin emits a credential-bearing artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rehearsal-build-secret-'));
  try {
    await writeFile(join(root, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    const secret = syntheticSecrets[0][1];
    await assert.rejects(build({ configFile: false, root, publicDir: false, logLevel: 'silent',
      plugins: [webSecurityPlugin(hosted), { name: 'accidental-config', generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'config.json', source: JSON.stringify({ apiKey: secret }) });
      } }], build: { write: false },
    }), error => {
      assert.match(error.message, /config\.json \(provider API key\)/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production HTML places enforcing policy and referrer metadata before scripts in both modes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rehearsal-web-policy-'));
  try {
    await writeFile(join(root, 'index.html'), '<!doctype html><html><head><title>Policy check</title><script type="module" src="./entry.js"></script></head><body></body></html>');
    await writeFile(join(root, 'entry.js'), 'document.body.textContent = "Ready";');
    for (const env of [{}, hosted]) {
      const result = await build({ configFile: false, root, publicDir: false, logLevel: 'silent', plugins: [webSecurityPlugin(env)], build: { write: false, minify: false } });
      const html = result.output.find(file => file.fileName === 'index.html').source;
      assert.match(html, /http-equiv="Content-Security-Policy"/);
      assert.match(html, /name="referrer" content="no-referrer"/);
      assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
      assert.ok(html.indexOf('name="referrer"') < html.indexOf('<script'));
      assert.equal((html.match(/Content-Security-Policy/g) || []).length, 1);
      assert.match(html.replaceAll('&#39;', "'"), /frame-src 'self';/, 'production preview frames need the same narrow policy as local development');
      assert.equal(html.includes('https://pilot.supabase.co'), Boolean(env.VITE_SUPABASE_URL));
      assert.ok(!html.includes('sb_publishable_'), 'policy metadata must not include credentials');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
