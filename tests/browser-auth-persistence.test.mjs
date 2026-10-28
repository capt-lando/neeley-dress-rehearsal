import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createClient } from '@supabase/supabase-js';

const bootstrap = await readFile(new URL('../public/bootstrap.js', import.meta.url), 'utf8');
const optionsSource = bootstrap.match(/createClient\(hosted\.url,\s*hosted\.publishableKey,\s*(\{\s*auth:\s*\{[\s\S]*?\}\s*\})\s*\)/)?.[1];
assert.ok(optionsSource, 'derive auth options from the application bootstrap');

function storage() {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}
const token = (id, expires = Math.floor(Date.now() / 1000) + 3600) => [
  { alg: 'HS256', typ: 'JWT' }, { sub: id, exp: expires, aud: 'authenticated' },
].map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).concat(Buffer.alloc(32).toString('base64url')).join('.');

test('browser auth survives a new tab, refreshes expired access, and respects sign-out/account replacement', { timeout: 5000 }, async t => {
  const shared = storage(), clients = [], calls = [];
  const accountA = '11111111-1111-4111-8111-111111111111';
  const accountB = '22222222-2222-4222-8222-222222222222';
  const users = new Map([accountA, accountB].map(id => [id, { id, aud: 'authenticated', role: 'authenticated' }]));
  const original = new Map(['window', 'document', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: Object.assign(new EventTarget(), { location: new URL('https://example.test/rehearsal/') }) },
    document: { configurable: true, value: { visibilityState: 'hidden' } },
    localStorage: { configurable: true, value: shared },
  });
  // Clients represent separate tabs but share this test's JS realm, so the SDK emits this expected warning.
  t.mock.method(console, 'warn', message => assert.match(message, /Multiple GoTrueClient instances/));
  t.after(async () => {
    await Promise.all(clients.map(client => client.auth.dispose()));
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  async function provider(input, init) {
    const url = new URL(input);
    assert.equal(url.origin, 'https://auth-persistence-test.supabase.co');
    calls.push(url.pathname);
    if (url.pathname === '/auth/v1/user') {
      const jwt = new Headers(init.headers).get('authorization').slice('Bearer '.length);
      const id = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).sub;
      assert.ok(users.has(id));
      return Response.json(users.get(id));
    }
    if (url.pathname === '/auth/v1/token') {
      assert.equal(url.searchParams.get('grant_type'), 'refresh_token');
      assert.equal(JSON.parse(init.body).refresh_token, 'synthetic-refresh-a');
      return Response.json({ access_token: token(accountA), refresh_token: 'synthetic-refresh-a-renewed',
        expires_in: 3600, token_type: 'bearer', user: users.get(accountA) });
    }
    assert.equal(url.pathname, '/auth/v1/logout', 'unexpected auth request must never reach the network');
    return new Response(null, { status: 204 });
  }
  function newTab() {
    const options = vm.runInNewContext(`(${optionsSource})`, { sessionStorage: storage() });
    assert.equal(options.auth.flowType, 'pkce');
    assert.equal(options.auth.persistSession, true);
    assert.equal(options.auth.autoRefreshToken, true);
    const client = createClient('https://auth-persistence-test.supabase.co', 'sb_publishable_synthetic',
      { ...options, global: { fetch: provider } });
    clients.push(client);
    return client;
  }
  async function session(client) {
    const result = await client.auth.getSession();
    assert.equal(result.error, null);
    return result.data.session;
  }
  async function signIn(client, id, refresh) {
    const result = await client.auth.setSession({ access_token: token(id), refresh_token: refresh });
    assert.equal(result.error, null);
    assert.equal(result.data.session.user.id, id);
  }

  const first = newTab();
  await signIn(first, accountA, 'synthetic-refresh-a');
  await first.auth.dispose(); // Closing a tab must not sign the account out.
  const later = newTab();
  assert.equal((await session(later))?.user.id, accountA, 'a later tab must restore the shared login');
  assert.equal(calls.filter(path => path === '/auth/v1/token').length, 0);
  await later.auth.dispose();

  const sessionKey = [...shared.data.keys()].find(key => JSON.parse(shared.getItem(key))?.access_token);
  assert.ok(sessionKey, 'the SDK must persist the login in shared browser storage');
  const expired = JSON.parse(shared.getItem(sessionKey));
  expired.expires_at = Math.floor(Date.now() / 1000) - 60;
  expired.access_token = token(accountA, expired.expires_at);
  shared.setItem(sessionKey, JSON.stringify(expired));
  const refreshed = newTab();
  const restored = await session(refreshed);
  assert.equal(restored?.user.id, accountA);
  assert.equal(restored.refresh_token, 'synthetic-refresh-a-renewed');
  assert.equal(calls.filter(path => path === '/auth/v1/token').length, 1);
  const observer = newTab();
  assert.equal((await session(observer))?.user.id, accountA);
  let receiveSignOut;
  const broadcast = new Promise(resolve => { receiveSignOut = resolve; });
  const { data: { subscription } } = observer.auth.onAuthStateChange((event, nextSession) => {
    if (event === 'SIGNED_OUT') receiveSignOut(nextSession);
  });
  assert.equal((await refreshed.auth.signOut()).error, null);
  assert.equal(await broadcast, null, 'an already-open tab must receive the SDK sign-out broadcast');
  assert.equal(await session(observer), null);
  subscription.unsubscribe();
  await observer.auth.dispose();
  await refreshed.auth.dispose();

  const signedOut = newTab();
  assert.equal(await session(signedOut), null, 'sign-out must survive opening another tab');
  await signIn(signedOut, accountB, 'synthetic-refresh-b');
  await signedOut.auth.dispose();
  const replacement = newTab();
  assert.equal((await session(replacement))?.user.id, accountB, 'the old account must not be restored');
  assert.equal((await session(replacement)).refresh_token, 'synthetic-refresh-b');
});
