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
function accountHarness({ getConfig = () => Promise.resolve({ liveTranscription: true }), getIdentity = identity => Promise.resolve(identity), prepareSpeech, recoverPending, configurationFailed, configurationReady, analyticsFactory = createUsageAnalytics,
  currentSnapshot = null, captureCurrentRehearsal, restoreCurrentRehearsal } = {}) {
  class Element {
    constructor(tagName = 'DIV') { this.tagName = tagName; this.listeners = new Map(); this.children = []; this.attributes = new Map(); this.disabled = false; this.textContent = ''; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    querySelector() { return this.note ||= new Element(); }
    querySelectorAll() { return this.children.flatMap(child => [...(child.tagName === 'BUTTON' ? [child] : []), ...child.querySelectorAll()]); }
    getBoundingClientRect() { return this.rect || { top: 0, bottom: 0, left: 0, right: 0 }; }
    showModal() { this.open = true; } close() { this.open = false; }
    click() { return this.listeners.get('click')?.(); }
  }
  const elements = new Map(), get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const histories = [], signouts = [], opens = [], deletes = [], restored = [], restoreOptions = [], deleted = [], oauth = [], settings = deferred();
  const currentSaves = [], currentRestores = []; let storedCurrent = currentSnapshot, currentClears = 0;
  let replaceAllowed = true, viewGeneration = 0;
  let settingsCalls = 0;
  let identity = { id: 'first-user' }, authChanged;
  const service = {
    prepareSpeech,
    readCurrentRehearsal: () => storedCurrent ? structuredClone(storedCurrent) : null,
    saveCurrentRehearsal(value) { storedCurrent = structuredClone(value); currentSaves.push(storedCurrent); return true; },
    clearCurrentRehearsal() { storedCurrent = null; currentClears++; },
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
  const context = { window, document, createUsageAnalytics: analyticsFactory, readHostedConfig: () => config, innerHeight: 900, innerWidth: 1200,
    localStorage: { getItem: () => null }, setInterval: () => 1, clearInterval() {}, URL, location: { href: redirect }, AbortSignal,
    fetch: () => { settingsCalls++; return settings.promise; } };
  vm.createContext(context);
  vm.runInContext(`${accountSource}\nglobalThis.install = installHostedAccount;`, context);
  context.install(service, { accountChanged() {}, updateConfig() {}, recoverPending, configurationFailed, configurationReady,
    captureCurrentRehearsal,
    async restoreCurrentRehearsal(value) { currentRestores.push(value); return restoreCurrentRehearsal?.(value); },
    canReplaceAudio: () => replaceAllowed, captureViewGeneration: () => viewGeneration, isViewGenerationCurrent: value => value === viewGeneration,
    restoreRecording(value, options) { restored.push(value); restoreOptions.push(options); }, recordingDeleted: id => deleted.push(id) });
  return { get, window, document, histories, signouts, opens, deletes, restored, restoreOptions, deleted, oauth, settings, currentSaves, currentRestores,
    get currentClears() { return currentClears; }, get storedCurrent() { return storedCurrent; },
    setReplaceAllowed(value) { replaceAllowed = value; }, changeView() { viewGeneration++; },
    get settingsCalls() { return settingsCalls; }, changeUser(id) { identity = id ? { id } : null; return authChanged(identity); } };
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
  assert.equal(h.get('cloud-recordings-status').textContent, 'Saved rehearsals couldn’t be loaded. Try again. Retry later');
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
    assert.equal(h.get('cloud-recordings-status').textContent, blockConfiguration ? '' : 'Loading your saved rehearsals…');
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

test('startup restores the pre-recovery editor snapshot and suppresses blank saves until restoration finishes', async () => {
  const recovered = deferred(), restored = deferred(), events = [];
  const snapshot = { ownerId: 'first-user', recordingId: 'saved-take', transcript: 'My unsent correction.', transcriptBasis: 'The analyzed transcript.' };
  let current = { ownerId: 'first-user', recordingId: '', transcript: '' };
  const h = accountHarness({ currentSnapshot: snapshot, captureCurrentRehearsal: () => current,
    recoverPending: async () => { events.push('recover'); await recovered.promise; },
    restoreCurrentRehearsal: async value => { events.push('restore'); assert.deepEqual(value, snapshot); await restored.promise; } });
  await turn();
  assert.deepEqual(events, ['recover']);
  assert.equal(h.window.rehearsalAccount.saveCurrentRehearsal(), false);
  assert.deepEqual(h.storedCurrent, snapshot);
  recovered.resolve(); await turn();
  assert.deepEqual(events, ['recover', 'restore']);
  assert.equal(h.window.rehearsalAccount.saveCurrentRehearsal(), false);
  assert.equal(h.histories.length, 0);
  restored.resolve(); await turn();
  assert.equal(h.histories.length, 1);
  current = { ...snapshot, transcript: 'A later correction.' };
  assert.equal(h.window.rehearsalAccount.saveCurrentRehearsal(), true);
  assert.equal(h.storedCurrent.transcript, current.transcript);
  h.histories[0].resolve({ recordings: [] }); await turn();
});

test('restoration coalesces retries and keeps failed snapshots until a successful retry', async () => {
  let blocked = true;
  const pending = deferred(), snapshot = { ownerId: 'first-user', recordingId: 'saved-take', transcript: 'Keep this draft.' };
  const h = accountHarness({ currentSnapshot: snapshot, captureCurrentRehearsal: () => ({ ownerId: 'first-user', transcript: '' }),
    restoreCurrentRehearsal: async () => { if (blocked) { await pending.promise; return false; } } });
  await turn();
  const retries = Array.from({ length: 10 }, () => h.window.rehearsalAccount.restoreCurrentRehearsal());
  assert.equal(h.currentRestores.length, 1);
  pending.resolve(); await Promise.all(retries); await turn();
  assert.equal(h.window.rehearsalAccount.saveCurrentRehearsal(), false);
  assert.deepEqual(h.storedCurrent, snapshot);
  blocked = false; await h.window.rehearsalAccount.restoreCurrentRehearsal();
  assert.equal(h.currentRestores.length, 2);
  assert.equal(h.window.rehearsalAccount.saveCurrentRehearsal(), true);
});

test('explicit reset abandons deferred restore without resurrecting the saved rehearsal', async () => {
  const h = accountHarness({ currentSnapshot: { ownerId: 'first-user', recordingId: 'saved-take' },
    captureCurrentRehearsal: () => ({ ownerId: 'first-user', recordingId: '', plannedIntroduction: 'My new draft.' }),
    restoreCurrentRehearsal: async () => false });
  await turn();
  h.window.rehearsalAccount.clearCurrentRehearsal();
  assert.equal(h.currentClears, 1); assert.equal(h.storedCurrent, null);
  await h.window.rehearsalAccount.restoreCurrentRehearsal();
  assert.equal(h.currentRestores.length, 1);
  assert.equal(h.window.rehearsalAccount.saveCurrentRehearsal(), true);
  assert.equal(h.storedCurrent.plannedIntroduction, 'My new draft.');
});

test('page hiding flushes current edits and restored accounts do not reopen work on ordinary account refresh', async () => {
  let current = { ownerId: 'first-user', recordingId: 'saved-take', transcript: 'Initial edit.' };
  const h = accountHarness({ currentSnapshot: current, captureCurrentRehearsal: () => current }); await turn();
  h.histories[0].resolve({ recordings: [] }); await turn();
  const refresh = h.window.rehearsalAccount.refresh(); await turn();
  h.histories[1].resolve({ recordings: [] }); await refresh;
  assert.equal(h.currentRestores.length, 1);
  current = { ...current, transcript: 'Latest edit before refresh.' };
  h.document.hidden = true; h.document.listeners.get('visibilitychange')();
  assert.equal(h.storedCurrent.transcript, current.transcript);
  h.window.listeners.get('pagehide')({ persisted: false });
  assert.equal(h.currentSaves.length, 2);
});

test('a different account never receives the prior owner snapshot or accepts a stale owner capture', async () => {
  const h = accountHarness({ currentSnapshot: { ownerId: 'first-user', recordingId: 'private-take' },
    captureCurrentRehearsal: () => ({ ownerId: 'first-user', transcript: 'Old private text.' }) });
  await turn(); h.histories[0].resolve({ recordings: [] }); await turn();
  const switched = h.changeUser('second-user'); await turn();
  h.histories[1].resolve({ recordings: [] }); await switched;
  assert.equal(h.currentRestores.length, 1, 'the previous owner snapshot must not be passed to the new account UI');
  assert.equal(h.window.rehearsalAccount.saveCurrentRehearsal(), false);
  assert.equal(h.currentSaves.length, 0);
});

test('signed-in speech startup runs without blocking recovery or history', async () => {
  const warmup = deferred(), events = [];
  const h = accountHarness({ getConfig: async () => ({ speechConfigured: true }),
    prepareSpeech: () => { events.push('warmup'); return warmup.promise; }, recoverPending: async () => events.push('recovery') });
  await turn();
  assert.deepEqual(events, ['recovery']);
  assert.equal(h.histories.length, 1, 'history appears while startup is still pending');
  h.histories[0].resolve({ recordings: [] }); warmup.resolve(); await turn();
  assert.equal(h.get('account-status').textContent, '', 'optional startup failure does not masquerade as sign-in failure');
});

test('signed-out and unconfigured accounts never start speech compute', async () => {
  let starts = 0;
  const h = accountHarness({ getConfig: async () => ({ speechConfigured: false }), prepareSpeech: async () => { starts++; } });
  await turn(); h.histories[0].resolve({ recordings: [] });
  await h.changeUser(null); assert.equal(starts, 0);
  const signedOut = accountHarness({ getIdentity: async () => null, getConfig: async () => ({ speechConfigured: true }), prepareSpeech: async () => { starts++; } });
  await turn(); assert.equal(starts, 0); assert.equal(signedOut.histories.length, 0);
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

test('history rows separate real dates, durations, and lifecycle status without treating unknown state as ready', async () => {
  const h = accountHarness(); await turn();
  const statuses = ['analyzed', 'transcribed', 'transcribing', 'pending', 'failed', 'deleting', 'constructor'];
  h.histories[0].resolve({ recordings: statuses.map((status, index) => ({ id: String(index), title: '<img src=x onerror=alert(1)>',
    createdAt: '2026-10-28T16:00:00Z', durationSeconds: 134.9, status })) }); await turn();
  const rows = h.get('cloud-recordings-list').children;
  assert.equal(h.get('history-count').textContent, '7'); assert.equal(h.get('history-count').hidden, false);
  assert.deepEqual(rows.map(row => row.children[2].textContent), [
    'Feedback ready', 'Ready to analyze', 'Transcribing', 'Needs transcription', 'Needs attention', 'Deleting', 'Status unavailable',
  ]);
  for (const row of rows) {
    assert.deepEqual(row.children.map(child => child.className), ['saved-recording-meta', 'saved-recording-duration', 'saved-recording-state', 'saved-recording-actions']);
    assert.equal(row.children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(row.children[0].children[0].children.length, 0, 'a title remains inert text');
    assert.equal(row.children[0].children[1].textContent, new Date('2026-10-28T16:00:00Z').toLocaleString());
    assert.equal(row.children[1].textContent, '2:14');
    const [open, remove] = row.children[3].children;
    assert.equal(open.className, 'secondary-button small-button');
    assert.equal(remove.className, 'text-button saved-recording-delete');
  }
});

test('history exposes loading, empty, and signed-out states with a shared count and sign-in action', async () => {
  const h = accountHarness(); await turn();
  assert.equal(h.get('cloud-recordings-status').textContent, 'Loading your saved rehearsals…');
  assert.equal(h.get('history-sign-in').hidden, true);
  h.histories[0].resolve({ recordings: [] }); await turn();
  assert.match(h.get('cloud-recordings-status').textContent, /No cloud recordings yet/);
  assert.equal(h.get('history-count').textContent, '0');
  await h.changeUser(null);
  assert.match(h.get('cloud-recordings-status').textContent, /^Sign in/);
  assert.equal(h.get('history-sign-in').hidden, false);
  assert.equal(h.get('history-count').textContent, '0'); assert.equal(h.get('history-count').hidden, true);
  assert.equal(h.get('cloud-history-refresh').disabled, true);
  h.get('history-sign-in').click(); assert.equal(h.get('account-dialog').open, true);
  await h.window.rehearsalAccount.refreshHistory(); assert.equal(h.histories.length, 1, 'signed-out refresh does not fetch private history');
});

test('old Open failures and cleanup cannot overwrite or unlock the new account action', async () => {
  const h = accountHarness(); await turn();
  h.histories[0].resolve({ recordings: [{ id: 'a', title: 'A private title', createdAt: 0, durationSeconds: 1 }] }); await turn();
  const oldOpen = h.get('cloud-recordings-list').querySelectorAll('button')[0];
  const openingA = oldOpen.click();
  const changed = h.changeUser('second-user'); await turn();
  assert.equal(h.get('history-count').textContent, '0');
  h.histories[1].resolve({ recordings: [{ id: 'b', title: 'B title', createdAt: 0, durationSeconds: 1 }] }); await changed;
  const [newOpen, newDelete] = h.get('cloud-recordings-list').querySelectorAll('button');
  const openingB = newOpen.click();
  h.opens[0].reject(new Error('Private A failure')); await openingA;
  assert.doesNotMatch(h.get('cloud-recordings-status').textContent, /Private A/);
  assert.equal(newOpen.disabled, true); assert.equal(newDelete.disabled, true);
  assert.equal(h.get('cloud-history-refresh').disabled, true);
  await oldOpen.click(); assert.equal(h.opens.length, 2, 'detached prior-account buttons cannot make requests');
  h.opens[1].resolve({ id: 'b' }); await openingB;
  assert.deepEqual(h.restored, [{ id: 'b' }]);
  assert.equal(h.restoreOptions[0].showRehearse, true); assert.equal(h.restoreOptions[0].viewGeneration, 0);
  assert.equal(newOpen.disabled, false); assert.equal(h.get('cloud-history-refresh').disabled, false);
});

test('old Delete completion cannot mutate or refresh the new account history', async () => {
  const h = accountHarness(); await turn();
  h.histories[0].resolve({ recordings: [{ id: 'a', createdAt: 0, durationSeconds: 1 }] }); await turn();
  const deleting = h.get('cloud-recordings-list').querySelectorAll('button')[1].click();
  const changed = h.changeUser('second-user'); await turn();
  h.histories[1].resolve({ recordings: [{ id: 'b', createdAt: 0, durationSeconds: 1 }] }); await changed;
  h.deletes[0].resolve(); await deleting;
  assert.deepEqual(h.deleted, []); assert.equal(h.histories.length, 2);
  assert.equal(h.get('cloud-recordings-list').children.length, 1); assert.equal(h.get('history-count').textContent, '1');
});

test('Open completion respects later navigation or a new active take', async () => {
  for (const change of ['navigate', 'record']) {
    const h = accountHarness(); await turn();
    h.histories[0].resolve({ recordings: [{ id: 'a', createdAt: 0, durationSeconds: 1 }] }); await turn();
    const opening = h.get('cloud-recordings-list').querySelectorAll('button')[0].click();
    if (change === 'navigate') h.changeView(); else h.setReplaceAllowed(false);
    h.opens[0].resolve({ id: 'a' }); await opening;
    assert.deepEqual(h.restored, [], `${change} invalidates the pending replacement`);
    assert.equal(h.get('cloud-recordings-list').querySelectorAll('button')[0].disabled, false);
  }
});

test('a refreshed history keeps newly rendered actions disabled while an Open remains pending', async () => {
  const h = accountHarness(); await turn();
  const record = { id: 'a', createdAt: 0, durationSeconds: 1 };
  h.histories[0].resolve({ recordings: [record] }); await turn();
  const opening = h.get('cloud-recordings-list').querySelectorAll('button')[0].click();
  const refreshed = h.window.rehearsalAccount.refreshHistory();
  h.histories[1].resolve({ recordings: [record] }); await refreshed;
  const [open, remove] = h.get('cloud-recordings-list').querySelectorAll('button');
  assert.equal(open.disabled, true); assert.equal(remove.disabled, true);
  await open.click(); assert.equal(h.opens.length, 1);
  h.opens[0].resolve({ id: 'a' }); await opening;
  assert.equal(open.disabled, false); assert.equal(remove.disabled, false);
});

test('a failed Open from a previous view cannot replace current history status', async () => {
  const h = accountHarness(); await turn();
  h.histories[0].resolve({ recordings: [{ id: 'a', createdAt: 0, durationSeconds: 1 }] }); await turn();
  const opening = h.get('cloud-recordings-list').querySelectorAll('button')[0].click();
  h.changeView();
  const before = h.get('cloud-recordings-status').textContent;
  h.opens[0].reject(new Error('Previous view failure')); await opening;
  assert.equal(h.get('cloud-recordings-status').textContent, before);
});

test('rehearsal analytics excludes content under a hidden history-page ancestor', async () => {
  const views = [];
  const h = accountHarness({ analyticsFactory: () => ({ setConsent() {}, flush() {}, track() {}, activity() {}, dispose() {}, setView: view => views.push(view) }) });
  await turn(); h.histories[0].resolve({ recordings: [] }); await turn();
  const rehearsalPage = h.get('rehearse-page');
  const prepare = h.get('.prepare-panel'); prepare.parentElement = rehearsalPage;
  prepare.rect = { top: 0, bottom: 800, left: 0, right: 1000 };
  h.window.listeners.get('click')(); assert.equal(views.at(-1).visible, true);
  rehearsalPage.hidden = true;
  h.window.listeners.get('click')(); assert.equal(views.at(-1).visible, false);
  assert.equal(views.at(-1).section, 'prepare', 'no invented history analytics section is submitted');
});
