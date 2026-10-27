import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { beginHostedSignIn } from '../public/hosted-account.js';
import { createUsageAnalytics } from '../lib/usage-analytics.mjs';

const config = { url: 'https://pilot.supabase.co', publishableKey: 'sb_publishable_test' };
const redirect = 'https://capt-lando.github.io/neeley-dress-rehearsal/';
const accountSource = (await readFile(new URL('../public/hosted-account.js', import.meta.url), 'utf8'))
  .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '').replaceAll('import.meta.env', 'undefined');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function accountHarness({ getConfig = () => Promise.resolve({ liveTranscription: true }), getIdentity = identity => Promise.resolve(identity), recoverPending, configurationFailed, configurationReady } = {}) {
  class Element {
    constructor(tagName = 'DIV') { this.tagName = tagName; this.listeners = new Map(); this.children = []; this.disabled = false; this.textContent = ''; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    setAttribute() {}
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelector() { return this.note ||= new Element(); }
    querySelectorAll() { return this.children.flatMap(child => [...(child.tagName === 'BUTTON' ? [child] : []), ...child.querySelectorAll()]); }
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0 }; }
    showModal() {} close() {}
    click() { return this.listeners.get('click')?.(); }
  }
  const elements = new Map(), get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const histories = [], signouts = [], opens = [], deletes = [], restored = [], oauth = [], settings = deferred();
  let settingsCalls = 0;
  let identity = { id: 'first-user' }, authChanged;
  const service = {
    getIdentity: () => getIdentity(identity),
    request(path, options) {
      if (path === '/api/config') return getConfig();
      const pending = deferred();
      if (path === '/api/recordings') histories.push(pending);
      else if (options?.method === 'DELETE') deletes.push(pending);
      else throw new Error(`Unexpected request ${path}`);
      return pending.promise;
    },
    openRecording() { const pending = deferred(); opens.push(pending); return pending.promise; },
    signOut() { const pending = deferred(); signouts.push(pending); return pending.promise; },
    signIn: async (...args) => { oauth.push(args); },
    onAuthChange(callback) { authChanged = callback; return () => {}; },
  };
  const window = Object.assign(new Element(), { confirm: () => true });
  const document = Object.assign(new Element(), { getElementById: get, querySelector: get, createElement: tag => new Element(tag.toUpperCase()), hasFocus: () => true });
  const context = { window, document, createUsageAnalytics, readHostedConfig: () => config, innerHeight: 900, innerWidth: 1200,
    localStorage: { getItem: () => null }, setInterval: () => 1, clearInterval() {}, URL, location: { href: redirect }, AbortSignal,
    fetch: () => { settingsCalls++; return settings.promise; } };
  vm.createContext(context);
  vm.runInContext(`${accountSource}\nglobalThis.install = installHostedAccount;`, context);
  context.install(service, { accountChanged() {}, updateConfig() {}, recoverPending, configurationFailed, configurationReady, canReplaceAudio: () => true, restoreRecording: value => restored.push(value), recordingDeleted() {} });
  return { get, window, histories, signouts, opens, deletes, restored, oauth, settings, get settingsCalls() { return settingsCalls; }, changeUser(id) { identity = id ? { id } : null; return authChanged(identity); } };
}

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

test('1,000 history refresh actions share a request, clear on failure and allow a later retry', async () => {
  const h = accountHarness(); await turn();
  const refreshes = Array.from({ length: 1000 }, () => h.get('cloud-history-refresh').click());
  assert.equal(h.histories.length, 1); assert.equal(h.get('cloud-history-refresh').disabled, true);
  h.histories[0].reject(new Error('Retry later')); await Promise.all(refreshes);
  assert.equal(h.get('cloud-history-refresh').disabled, false);
  assert.equal(h.get('cloud-recordings-status').textContent, 'Retry later');
  const retry = h.get('cloud-history-refresh').click();
  assert.equal(h.histories.length, 2);
  h.histories[1].resolve({ recordings: [] }); await retry;
  assert.equal(h.get('cloud-history-refresh').disabled, false);
});

test('a new account gets a separate history request and ignores the old account result and cleanup', async () => {
  const h = accountHarness(); await turn();
  const changed = h.changeUser('second-user'); await turn();
  assert.equal(h.histories.length, 2);
  h.histories[0].resolve({ recordings: [{ id: 'private', title: 'Old private title', durationSeconds: 1, createdAt: 0 }] }); await turn();
  assert.equal(h.get('cloud-recordings-list').children.length, 0);
  assert.equal(h.get('cloud-history-refresh').disabled, true, 'old cleanup cannot unlock the newer request');
  h.histories[1].resolve({ recordings: [] }); await changed;
  assert.equal(h.get('cloud-history-refresh').disabled, false);
  assert.equal(h.get('cloud-recordings-list').children.length, 0);
});

test('rendered history clears immediately when another account configuration or history stalls or fails', async () => {
  for (const stalledStage of ['configuration', 'history']) {
    const configPending = deferred(); let blockConfiguration = false;
    const h = accountHarness({ getConfig: () => blockConfiguration ? configPending.promise : Promise.resolve({ liveTranscription: true }) });
    await turn();
    h.histories[0].resolve({ recordings: [{ id: 'private-a', title: 'Private account A rehearsal', durationSeconds: 1, createdAt: 0 }] });
    await turn();
    assert.equal(h.get('cloud-recordings-list').children.length, 1);
    blockConfiguration = stalledStage === 'configuration';
    const changed = h.changeUser('second-user'); await turn();
    assert.equal(h.get('cloud-recordings-list').children.length, 0, 'old titles and buttons must disappear before new network work completes');
    assert.equal(h.get('cloud-recordings-status').textContent, '');
    if (blockConfiguration) {
      assert.equal(h.histories.length, 1);
      assert.equal(h.get('cloud-history-refresh').disabled, false);
      configPending.reject(new Error('Configuration unavailable'));
    } else {
      assert.equal(h.histories.length, 2);
      h.histories[1].reject(new Error('History unavailable'));
    }
    await changed;
    assert.equal(h.get('cloud-recordings-list').children.length, 0, 'failure cannot restore previous-account metadata');
  }
});

test('auth event clears prior account history without depending on a second identity lookup', async () => {
  let identityReads = 0;
  const h = accountHarness({ getIdentity: async identity => {
    if (++identityReads > 1) throw new Error('Session lookup unavailable');
    return identity;
  } });
  await turn();
  h.histories[0].resolve({ recordings: [{ id: 'private-a', title: 'Private account A rehearsal', durationSeconds: 1, createdAt: 0 }] }); await turn();
  assert.equal(h.get('cloud-recordings-list').children.length, 1);
  const changed = h.changeUser('second-user'); await turn();
  assert.equal(h.get('cloud-recordings-list').children.length, 0);
  assert.equal(identityReads, 1, 'the supplied auth identity controls immediate privacy cleanup');
  h.histories[1].resolve({ recordings: [] }); await changed;
  await h.changeUser(null);
  assert.equal(h.get('cloud-recordings-list').children.length, 0);
  assert.equal(h.get('account-details').hidden, true);
});

test('1,000 sign-out callbacks send once and a failed sign-out releases the button for retry', async () => {
  const h = accountHarness(); await turn(); h.histories[0].resolve({ recordings: [] });
  const signingOut = Array.from({ length: 1000 }, () => h.get('account-signout').click());
  assert.equal(h.signouts.length, 1); assert.equal(h.get('account-signout').disabled, true);
  h.signouts[0].reject(new Error('Try again')); await Promise.all(signingOut);
  assert.equal(h.get('account-signout').disabled, false);
  const retry = h.get('account-signout').click(); assert.equal(h.signouts.length, 2);
  h.signouts[1].resolve(); await retry;
  assert.equal(h.get('account-status').textContent, 'Signed out.');
});

test('repeated cloud history Open and Delete callbacks share the existing action lock', async () => {
  const h = accountHarness(); await turn();
  h.histories[0].resolve({ recordings: [{ id: 'owned', title: '<img src=x onerror=alert(1)>', durationSeconds: 1, createdAt: 0 }] }); await turn();
  const [open, remove] = h.get('cloud-recordings-list').querySelectorAll('button');
  const opening = Array.from({ length: 1000 }, () => open.click());
  for (let index = 0; index < 1000; index++) remove.click();
  assert.equal(h.opens.length, 1); assert.equal(h.deletes.length, 0);
  h.opens[0].resolve({ id: 'owned' }); await Promise.all(opening); assert.equal(h.restored.length, 1);
  const deleting = Array.from({ length: 1000 }, () => remove.click());
  assert.equal(h.deletes.length, 1); h.deletes[0].resolve(); await turn();
  h.histories[1].resolve({ recordings: [] }); await Promise.all(deleting);
  assert.equal(h.get('cloud-recordings-list').children.length, 0);
});

test('1,000 mixed Google and Microsoft sign-in callbacks share one availability check and OAuth attempt', async () => {
  const h = accountHarness(); await turn(); h.histories[0].resolve({ recordings: [] });
  const attempts = Array.from({ length: 1000 }, (_, index) => h.get(index % 2 ? 'sign-in-microsoft' : 'sign-in-google').click());
  assert.equal(h.settingsCalls, 1); assert.equal(h.oauth.length, 0);
  assert.equal(h.get('sign-in-google').disabled, true); assert.equal(h.get('sign-in-microsoft').disabled, true);
  h.settings.resolve(Response.json({ external: { google: true, azure: true } })); await Promise.all(attempts);
  assert.equal(h.oauth.length, 1); assert.deepEqual(h.oauth[0], ['google', redirect]);
  assert.equal(h.get('sign-in-google').disabled, false); assert.equal(h.get('sign-in-microsoft').disabled, false);
});

test('signed-in startup automatically reconciles pending work before refreshing its history', async () => {
  const pending = deferred(); let checks = 0;
  const h = accountHarness({ recoverPending: async () => { checks++; await pending.promise; } });
  await turn();
  assert.equal(checks, 1); assert.equal(h.histories.length, 0);
  pending.resolve(); await turn();
  assert.equal(h.histories.length, 1);
  h.histories[0].resolve({ recordings: [] }); await turn();
});

test('initial configuration failure reaches the main UI and retry reloads configuration before recovery', async () => {
  const events = []; let offline = true;
  const h = accountHarness({
    getConfig: async () => { events.push('config'); if (offline) throw new Error('Offline'); return { liveTranscription: true }; },
    configurationFailed: message => events.push(`failed:${message}`),
    configurationReady: () => events.push('ready'), recoverPending: async () => events.push('recover'),
  });
  await turn();
  assert.deepEqual(events, ['config', 'failed:Offline']); assert.equal(h.histories.length, 0);
  offline = false;
  const retry = h.window.rehearsalAccount.refresh(); await turn();
  assert.deepEqual(events, ['config', 'failed:Offline', 'config', 'ready', 'recover']);
  h.histories[0].resolve({ recordings: [] }); await retry;
});

test('an old account configuration failure cannot show a recovery error in the newer account', async () => {
  const pending = deferred(), failures = []; let calls = 0;
  const h = accountHarness({ getConfig: () => ++calls === 1 ? pending.promise : Promise.resolve({ liveTranscription: true }),
    configurationFailed: message => failures.push(message) });
  await turn();
  const switched = h.changeUser('second-user'); await turn();
  pending.reject(new Error('Old private account failed')); await turn();
  assert.deepEqual(failures, []); assert.notEqual(h.get('account-status').textContent, 'Old private account failed');
  h.histories[0].resolve({ recordings: [] }); await switched;
});
