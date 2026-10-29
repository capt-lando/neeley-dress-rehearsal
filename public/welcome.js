// Only the account's opaque session identifier is stored here, never its token.
const SEEN_PREFIX = 'neeley-dress-rehearsal:welcome:v2:seen:';

export function installWelcomeTutorial({ document, window, service }) {
  const dialog = document.getElementById('welcome-dialog');
  const trigger = document.getElementById('welcome-open');
  const title = document.getElementById('welcome-title');
  const checkbox = document.getElementById('welcome-dont-show-again');
  const status = document.getElementById('welcome-preference-status');
  const seenInPage = new Map();
  let owner = null, profile = null, generation = 0, authRevision = 0;
  let loading = null, saving = null, disposed = false, returnFocus = trigger;
  let shownWhileLoading = false;

  function seen() {
    if (!owner || !profile) return false;
    try {
      if (window.localStorage.getItem(SEEN_PREFIX + owner) === profile.sessionId) return true;
    } catch { /* In-page memory still prevents repeated auth notifications. */ }
    return seenInPage.get(owner) === profile.sessionId;
  }

  function rememberSession() {
    if (!owner || !profile) return;
    seenInPage.set(owner, profile.sessionId);
    try { window.localStorage.setItem(SEEN_PREFIX + owner, profile.sessionId); }
    catch { /* The account preference can still be saved without browser storage. */ }
  }

  function updateCheckbox() {
    checkbox.checked = profile?.dontShowAgain === true;
    checkbox.disabled = !owner || Boolean(loading) || Boolean(saving);
  }

  function open() {
    if (disposed || dialog.open || document.querySelector('dialog[open]')) return;
    returnFocus = document.activeElement === document.body ? trigger : document.activeElement;
    dialog.querySelector('.welcome-explanation').open = false;
    updateCheckbox();
    dialog.showModal();
    if (!profile || loading) shownWhileLoading = true;
    rememberSession();
    dialog.scrollTop = 0;
    title.focus({ preventScroll: true });
  }

  function dismiss() { dialog.close(); }

  async function refresh(identity) {
    if (disposed) return;
    const nextOwner = identity?.id || null;
    if (nextOwner !== owner) {
      generation++;
      loading?.abort(); saving?.abort();
      loading = null; saving = null; profile = null;
      shownWhileLoading = false;
      owner = nextOwner;
      if (dialog.open) dialog.close();
      status.textContent = owner ? '' : 'Sign in to save this choice.';
      updateCheckbox();
    }
    if (!owner || loading || saving) return;
    const revision = generation, controller = new AbortController();
    loading = controller;
    updateCheckbox();
    try {
      const result = await service.request('/api/welcome-preference', { signal: controller.signal });
      if (disposed || revision !== generation || controller.signal.aborted) return;
      profile = result;
      loading = null;
      updateCheckbox();
      if (dialog.open || shownWhileLoading) rememberSession();
      else if (profile.signInCount <= 3 && !profile.dontShowAgain && !seen()) open();
      shownWhileLoading = false;
    } catch {
      if (!disposed && revision === generation) status.textContent = 'Couldn’t load your preference. You can still use this guide.';
    } finally {
      if (loading === controller) { loading = null; updateCheckbox(); }
    }
  }

  async function savePreference() {
    if (!owner || loading || saving || disposed) return;
    const dontShowAgain = checkbox.checked, revision = generation;
    const controller = new AbortController();
    saving = controller;
    checkbox.disabled = true;
    status.textContent = 'Saving…';
    try {
      const result = await service.request('/api/welcome-preference', {
        method: 'POST', body: JSON.stringify({ dontShowAgain }), signal: controller.signal,
      });
      if (disposed || revision !== generation || controller.signal.aborted) return;
      profile = result;
      if (dialog.open) rememberSession();
      status.textContent = 'Saved to your account.';
    } catch {
      if (!disposed && revision === generation) status.textContent = 'Couldn’t save your choice. Please try again.';
    } finally {
      if (saving === controller) { saving = null; updateCheckbox(); }
    }
  }

  trigger.addEventListener('click', open);
  document.getElementById('welcome-close').addEventListener('click', dismiss);
  document.getElementById('welcome-done').addEventListener('click', dismiss);
  checkbox.addEventListener('change', savePreference);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', () => {
    if (!document.querySelector('dialog[open]')) {
      (returnFocus?.isConnected ? returnFocus : trigger).focus({ preventScroll: true });
    }
  });

  status.textContent = 'Sign in to save this choice.';
  updateCheckbox();
  const unsubscribe = service.onAuthChange(identity => { authRevision++; void refresh(identity); });
  const initialRevision = authRevision;
  const ready = Promise.resolve().then(() => service.getIdentity()).then(identity => {
    if (authRevision === initialRevision) return refresh(identity);
  }).catch(() => { /* Uncertain eligibility must never interrupt a rehearsal. */ });
  function dispose() {
    disposed = true;
    loading?.abort(); saving?.abort(); unsubscribe();
  }
  window.addEventListener('pagehide', event => { if (!event.persisted) dispose(); });
  return { ready, dispose };
}
