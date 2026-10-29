import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { installWelcomeTutorial } from '../public/welcome.js';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const session = '33333333-3333-4333-8333-333333333333';
const newSession = '44444444-4444-4444-8444-444444444444';
const otherSession = '55555555-5555-4555-8555-555555555555';
const preference = (overrides = {}) => ({ signInCount: 1, dontShowAgain: false, sessionId: session, ...overrides });
const requestBody = call => typeof call.options.body === 'string' ? JSON.parse(call.options.body) : call.options.body;
const settle = async () => { for (let turn = 0; turn < 3; turn++) await new Promise(resolve => setImmediate(resolve)); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function harness({ account = owner, initialPreference = preference(), localStorage = storage(), storageAccessDenied = false, request, identity } = {}) {
  const { document, window: domWindow } = parseHTML(`<!doctype html><html><body>
    <button id="welcome-open">How it works</button>
    <dialog id="welcome-dialog" aria-labelledby="welcome-title">
      <button id="welcome-close" aria-label="Close welcome">×</button>
      <h2 id="welcome-title" tabindex="-1">Your next take starts here</h2>
      <details class="welcome-explanation"><summary>How feedback works</summary><p>Feedback follows your transcript.</p></details>
      <label><input id="welcome-dont-show-again" type="checkbox">Don't show again</label>
      <p id="welcome-preference-status" role="status"></p>
      <button id="welcome-done">Let's practice</button>
    </dialog>
  </body></html>`);
  const get = id => document.getElementById(id), dialog = get('welcome-dialog');
  let activeElement = document.body, currentAccount = account, authListener;
  const calls = [], listeners = new Map(), preferences = new Map([[owner, initialPreference], [other, preference({ sessionId: otherSession })]]);
  Object.defineProperty(document, 'activeElement', { get: () => activeElement });
  for (const element of document.querySelectorAll('*')) element.focus = () => { activeElement = element; };
  Object.defineProperty(dialog, 'open', { get: () => dialog.hasAttribute('open') });
  let showCount = 0;
  dialog.showModal = () => { showCount++; dialog.setAttribute('open', ''); };
  dialog.close = () => {
    if (!dialog.open) return;
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new domWindow.Event('close'));
  };
  const window = {
    localStorage, setTimeout, clearTimeout,
    addEventListener(type, listener) {
      const registered = listeners.get(type) || new Set(); registered.add(listener); listeners.set(type, registered);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
  };
  if (storageAccessDenied) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage access denied'); } });
  const service = {
    async getIdentity() { return identity ? identity() : currentAccount ? { id: currentAccount } : null; },
    onAuthChange(listener) { authListener = listener; return () => { authListener = null; }; },
    async request(path, options = {}) {
      const call = { path, options, account: currentAccount, method: options.method || 'GET' };
      calls.push(call);
      assert.equal(path, '/api/welcome-preference');
      if (request) return request(call);
      if (call.method === 'POST') {
        const body = requestBody(call);
        preferences.set(currentAccount, { ...preferences.get(currentAccount), dontShowAgain: body.dontShowAgain });
      }
      return { ...preferences.get(currentAccount) };
    },
  };
  const controller = installWelcomeTutorial({ document, window, service });
  return {
    get, document, dialog, calls, controller, preferences, window,
    get showCount() { return showCount; },
    async auth(nextAccount = currentAccount) {
      currentAccount = nextAccount;
      authListener?.(currentAccount ? { id: currentAccount } : null);
      await settle();
    },
    async click(id) { get(id).click(); await settle(); },
    async checkbox(checked) {
      get('welcome-dont-show-again').checked = checked;
      get('welcome-dont-show-again').dispatchEvent(new domWindow.Event('change', { bubbles: true }));
      await settle();
    },
    async escape() {
      const event = new domWindow.Event('cancel', { cancelable: true });
      dialog.dispatchEvent(event);
      if (!event.defaultPrevented) dialog.close();
      await settle();
    },
    async storageChanged(event = {}) {
      for (const listener of listeners.get('storage') || []) listener(event);
      await settle();
    },
  };
}

test('welcome waits for a signed-in account and its loaded eligibility before appearing', async () => {
  const loaded = deferred();
  const h = harness({ account: null, request: () => loaded.promise });
  await settle();
  assert.equal(h.dialog.open, false); assert.equal(h.calls.length, 0);
  await h.auth(owner);
  assert.equal(h.dialog.open, false); assert.equal(h.calls.length, 1);
  loaded.resolve(preference()); await settle();
  assert.equal(h.dialog.open, true); assert.equal(h.showCount, 1);
});

test('a manually dismissed guide does not reopen when its pending eligibility lookup finishes', async () => {
  const loaded = deferred();
  const h = harness({ request: () => loaded.promise }); await settle();
  await h.click('welcome-open'); assert.equal(h.dialog.open, true);
  await h.click('welcome-close'); assert.equal(h.dialog.open, false);
  loaded.resolve(preference()); await settle();
  assert.equal(h.dialog.open, false); assert.equal(h.showCount, 1);
  await h.auth(); assert.equal(h.dialog.open, false);
});

test('sign-ins zero through three are eligible while the fourth and permanent opt-out stay quiet', async () => {
  for (const signInCount of [0, 1, 2, 3, 4]) {
    const h = harness({ initialPreference: preference({ signInCount }) }); await settle();
    assert.equal(h.dialog.open, signInCount <= 3, `sign-in count ${signInCount}`);
  }
  const h = harness({ initialPreference: preference({ dontShowAgain: true }) }); await settle();
  assert.equal(h.dialog.open, false);
  await h.click('welcome-open'); assert.equal(h.dialog.open, true);
  assert.equal(h.get('welcome-dont-show-again').checked, true);
});

test('failed eligibility or identity lookup never interrupts the user with an automatic popup', async () => {
  for (const options of [
    { request: async () => { throw new Error('Offline'); } },
    { identity: async () => { throw new Error('Session unavailable'); } },
  ]) {
    const h = harness(options); await settle();
    assert.equal(h.dialog.open, false); assert.equal(h.showCount, 0);
    await h.click('welcome-open'); assert.equal(h.dialog.open, true);
    await h.click('welcome-close'); assert.equal(h.dialog.open, false);
  }
});

test('How it works opens while signed out without issuing account requests', async () => {
  const h = harness({ account: null }); await settle();
  await h.click('welcome-open');
  assert.equal(h.dialog.open, true); assert.equal(h.calls.length, 0);
  await h.click('welcome-done'); assert.equal(h.dialog.open, false);
});

test('close, primary action, and Escape dismiss without saving a permanent opt-out or reopening on auth refresh', async () => {
  for (const close of ['welcome-close', 'welcome-done', 'escape']) {
    const h = harness(); await settle(); assert.equal(h.dialog.open, true);
    if (close === 'escape') await h.escape(); else await h.click(close);
    assert.equal(h.dialog.open, false);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
    await h.auth(); await h.auth();
    assert.equal(h.dialog.open, false); assert.equal(h.showCount, 1);
    assert.equal(h.document.activeElement, h.get('welcome-open'));
  }
});

test('one actual sign-in session remains dismissed across reloads and tabs', async () => {
  const localStorage = storage();
  const first = harness({ localStorage }); await settle(); assert.equal(first.dialog.open, true);
  const anotherTab = harness({ localStorage }); await settle();
  assert.equal(anotherTab.dialog.open, false, 'showing the welcome already records the current session');
  await first.click('welcome-close');
  const refreshed = harness({ localStorage }); await settle();
  assert.equal(refreshed.dialog.open, false); assert.equal(anotherTab.dialog.open, false);
  await refreshed.click('welcome-open'); assert.equal(refreshed.dialog.open, true);
  await refreshed.click('welcome-close'); await refreshed.auth(); assert.equal(refreshed.dialog.open, false);
});

test('a new verified session may show once but token refresh in the same session does not', async () => {
  const h = harness(); await settle(); await h.click('welcome-close');
  await h.auth(); assert.equal(h.showCount, 1);
  h.preferences.set(owner, preference({ signInCount: 2, sessionId: newSession }));
  await h.auth(); assert.equal(h.dialog.open, true); assert.equal(h.showCount, 2);
  await h.click('welcome-close'); await h.auth(); assert.equal(h.dialog.open, false);
  h.preferences.set(owner, preference({ signInCount: 4, sessionId: otherSession }));
  await h.auth(); assert.equal(h.dialog.open, false); assert.equal(h.showCount, 2);
});

test('checking and unchecking the preference saves immediately for the current account', async () => {
  const h = harness(); await settle();
  await h.checkbox(true);
  assert.deepEqual(requestBody(h.calls.find(call => call.method === 'POST')), { dontShowAgain: true });
  assert.equal(h.preferences.get(owner).dontShowAgain, true);
  await h.click('welcome-close');
  h.preferences.set(owner, preference({ dontShowAgain: true, signInCount: 2, sessionId: newSession }));
  await h.auth(); assert.equal(h.dialog.open, false);
  await h.click('welcome-open'); assert.equal(h.get('welcome-dont-show-again').checked, true);
  await h.checkbox(false);
  const posted = h.calls.filter(call => call.method === 'POST');
  assert.deepEqual(requestBody(posted.at(-1)), { dontShowAgain: false });
  assert.equal(h.preferences.get(owner).dontShowAgain, false);
  await h.click('welcome-close'); await h.auth(); assert.equal(h.dialog.open, false);
});

test('pending or failed saves never trap the user in the dialog or claim a saved preference', async () => {
  const saved = deferred();
  const h = harness({ request: call => call.method === 'GET' ? preference() : saved.promise });
  await settle(); await h.checkbox(true);
  await h.click('welcome-close'); assert.equal(h.dialog.open, false);
  saved.reject(new Error('Save unavailable')); await settle();
  assert.equal(h.dialog.open, false);
  await h.click('welcome-open');
  assert.equal(h.get('welcome-dont-show-again').checked, false);
  assert.match(h.get('welcome-preference-status').textContent, /save|try|unavailable|unable|could|fail/i);
  await h.escape(); assert.equal(h.dialog.open, false);
});

test('late eligibility from a previous account cannot open the popup or replace the current preference', async () => {
  const previous = deferred();
  const h = harness({ request: call => call.account === owner ? previous.promise : preference({ dontShowAgain: true, sessionId: otherSession }) });
  await settle(); await h.auth(other);
  assert.equal(h.dialog.open, false);
  previous.resolve(preference()); await settle();
  assert.equal(h.dialog.open, false); assert.equal(h.showCount, 0);
  await h.click('welcome-open'); assert.equal(h.get('welcome-dont-show-again').checked, true);
});

test('an initial identity lookup cannot undo a newer account-change notification', async () => {
  const previous = deferred();
  const h = harness({ identity: () => previous.promise, request: () => preference({ dontShowAgain: true, sessionId: otherSession }) });
  await settle(); await h.auth(other);
  const requests = h.calls.length;
  previous.resolve({ id: owner }); await settle();
  assert.equal(h.calls.length, requests); assert.equal(h.dialog.open, false);
  await h.click('welcome-open'); assert.equal(h.get('welcome-dont-show-again').checked, true);
});

test('sign-out closes an open welcome and ignores in-flight account lookups', async () => {
  const h = harness(); await settle(); assert.equal(h.dialog.open, true);
  await h.auth(null); assert.equal(h.dialog.open, false);
  const previous = deferred(), pending = harness({ request: () => previous.promise });
  await settle(); await pending.auth(null);
  previous.resolve(preference()); await settle();
  assert.equal(pending.dialog.open, false); assert.equal(pending.showCount, 0);
  await pending.click('welcome-open'); assert.equal(pending.dialog.open, true);
});

test('late save success or failure cannot change a different account checkbox or status', async () => {
  for (const fail of [false, true]) {
    const previous = deferred();
    const h = harness({ request: call => call.method === 'POST' ? previous.promise : preference({ sessionId: call.account === owner ? session : otherSession }) });
    await settle(); await h.checkbox(true); await h.auth(other);
    const status = h.get('welcome-preference-status').textContent;
    assert.equal(h.get('welcome-dont-show-again').checked, false);
    if (fail) previous.reject(new Error('Previous account save failed'));
    else previous.resolve(preference({ dontShowAgain: true }));
    await settle();
    assert.equal(h.get('welcome-dont-show-again').checked, false);
    assert.equal(h.get('welcome-preference-status').textContent, status);
    assert.equal(h.dialog.open, true);
  }
});

test('same-session suppression is scoped to the account and does not suppress a different user', async () => {
  const h = harness(); await settle(); await h.click('welcome-close');
  await h.auth(other); assert.equal(h.dialog.open, true);
  await h.click('welcome-close'); await h.auth(owner);
  assert.equal(h.dialog.open, false); assert.equal(h.showCount, 2);
});

test('blocked browser storage still allows dismissal and suppresses duplicate auth notifications in the loaded page', async () => {
  for (const storageAccessDenied of [false, true]) {
    const localStorage = { getItem() { throw new Error('Storage blocked'); }, setItem() { throw new Error('Storage blocked'); } };
    const h = harness({ localStorage, storageAccessDenied }); await settle(); assert.equal(h.dialog.open, true);
    await h.click('welcome-close'); await h.auth(); await h.auth();
    assert.equal(h.dialog.open, false); assert.equal(h.showCount, 1);
    await h.click('welcome-open'); assert.equal(h.dialog.open, true);
    await h.checkbox(true); assert.equal(h.preferences.get(owner).dontShowAgain, true);
  }
});

test('manual re-opening resets optional explanation and moves focus into the accessible dialog', async () => {
  const h = harness(); await settle();
  assert.equal(h.document.activeElement, h.get('welcome-title'));
  h.dialog.querySelector('.welcome-explanation').open = true;
  await h.click('welcome-close'); await h.click('welcome-open');
  assert.equal(h.dialog.querySelector('.welcome-explanation').open, false);
  assert.equal(h.document.activeElement, h.get('welcome-title'));
  assert.equal(h.dialog.getAttribute('aria-labelledby'), h.get('welcome-title').id);
});
