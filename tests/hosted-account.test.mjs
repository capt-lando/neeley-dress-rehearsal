import test from 'node:test';
import assert from 'node:assert/strict';
import { beginHostedSignIn } from '../public/hosted-account.js';

const config = { url: 'https://pilot.supabase.co', publishableKey: 'sb_publishable_test' };
const redirect = 'https://capt-lando.github.io/neeley-dress-rehearsal/';

test('enabled Google and Microsoft sign-in use public settings before the existing OAuth flow', async () => {
  for (const provider of ['google', 'azure']) {
    const calls = [];
    const service = { signIn: async (...args) => calls.push(['signIn', ...args]) };
    await beginHostedSignIn(service, provider, redirect, config, async (url, options) => {
      calls.push(['settings']);
      assert.equal(url, `${config.url}/auth/v1/settings`);
      assert.deepEqual(options.headers, { apikey: config.publishableKey });
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json({ external: { google: true, azure: true } });
    });
    assert.deepEqual(calls, [['settings'], ['signIn', provider, redirect]]);
  }
});

test('disabled Microsoft remains in the app and offers only an enabled alternative', async () => {
  let redirects = 0;
  const service = { signIn: async () => { redirects++; } };
  for (const google of [true, false]) {
    await assert.rejects(beginHostedSignIn(service, 'azure', redirect, config,
      async () => Response.json({ external: { google, azure: false } })),
    { message: `Microsoft sign-in is not available yet. ${google ? 'Continue with Google.' : 'Please try again later.'}` });
  }
  assert.equal(redirects, 0);
});

test('failed or unreadable settings never navigate to an unchecked OAuth provider', async () => {
  let redirects = 0;
  const service = { signIn: async () => { redirects++; } };
  for (const fetchImpl of [
    async () => { throw new TypeError('Network failure'); },
    async () => { throw new DOMException('Timed out', 'TimeoutError'); },
    async () => Response.json({ external: { google: true } }, { status: 503 }),
    async () => new Response('unreadable'),
    async () => Response.json({ external: { google: 'true' } }),
    async () => Response.json({}),
  ]) {
    await assert.rejects(beginHostedSignIn(service, 'google', redirect, config, fetchImpl),
      { message: 'Sign-in availability could not be checked. Check your connection and try again.' });
  }
  assert.equal(redirects, 0);
});
