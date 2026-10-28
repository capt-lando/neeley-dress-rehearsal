import { createUsageAnalytics } from '../lib/usage-analytics.mjs';
import { readHostedConfig } from '../lib/hosted-service.mjs';

export async function beginHostedSignIn(service, provider, redirectTo, config = readHostedConfig(import.meta.env), fetchImpl = fetch) {
  if (!['google', 'azure'].includes(provider)) throw new Error('Choose Google or Microsoft.');
  let settings;
  try {
    const response = await fetchImpl(`${config.url}/auth/v1/settings`, {
      headers: { apikey: config.publishableKey }, credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    settings = await response.json();
    if (typeof settings?.external?.[provider] !== 'boolean') throw new Error();
  } catch {
    throw new Error('Sign-in availability could not be checked. Check your connection and try again.');
  }
  if (!settings.external[provider]) {
    const label = provider === 'google' ? 'Google' : 'Microsoft';
    const alternative = provider === 'google' ? 'azure' : 'google';
    throw new Error(`${label} sign-in is not available yet. ${settings.external[alternative] === true ? `Continue with ${alternative === 'google' ? 'Google' : 'Microsoft'}.` : 'Please try again later.'}`);
  }
  await service.signIn(provider, redirectTo);
}

/** Student account controls only. Staff analytics is a separate application. */
export function installHostedAccount(service, actions) {
  const $ = id => document.getElementById(id);
  const dialog = $('account-dialog');
  let user = null, generation = 0, busy = null, disposed = false, signingIn = false, signingOut = false, liveTranscription = false, historyRequest = null;
  let currentSession = null;
  const analytics = createUsageAnalytics({ send: (events, { signal }) => service.request('/api/events', { method: 'POST', body: { events }, signal }) });
  const consentKey = () => user ? `neeley-usage-consent:${user.id}` : '';
  const readConsent = () => { try { return localStorage.getItem(consentKey()) === 'yes'; } catch { return false; } };
  const status = message => { $('account-status').textContent = message; };
  const show = () => { status(''); dialog.showModal(); };
  const close = () => dialog.close();
  function saveCurrentRehearsal() {
    if (disposed || signingOut || !user || currentSession?.ownerId !== user.id || !currentSession.ready || currentSession.restoring) return false;
    const snapshot = actions.captureCurrentRehearsal?.();
    return snapshot?.ownerId === user.id ? service.saveCurrentRehearsal?.(snapshot) === true : false;
  }
  function clearCurrentRehearsal() {
    service.clearCurrentRehearsal?.();
    if (currentSession) { currentSession.snapshot = null; currentSession.ready = true; }
  }
  async function restoreCurrentRehearsal() {
    const pending = currentSession;
    if (disposed || !user || !pending || pending.ownerId !== user.id || pending.ready) return;
    if (pending.restoring) return pending.restoring;
    if (!pending.snapshot || !actions.restoreCurrentRehearsal) { pending.ready = true; return; }
    const restoring = (async () => {
      const restored = await actions.restoreCurrentRehearsal(pending.snapshot);
      if (disposed || currentSession !== pending || user?.id !== pending.ownerId) return;
      // A failed connection or unresolved request can retry the same snapshot.
      // Intentional new work abandons the old restore and returns true instead.
      if (restored !== false) { pending.ready = true; pending.snapshot = null; }
    })();
    pending.restoring = restoring;
    try { return await restoring; }
    finally { if (pending.restoring === restoring) pending.restoring = null; }
  }
  const historyCount = count => {
    const badge = $('history-count');
    if (badge) { badge.textContent = String(count); badge.hidden = !user; }
  };
  const syncHistoryControls = () => {
    const blocked = disposed || !user || busy?.generation === generation || historyRequest?.generation === generation;
    $('cloud-history-refresh').disabled = blocked;
    $('cloud-recordings-list').querySelectorAll('button').forEach(button => { button.disabled = blocked; });
    if ($('history-sign-in')) $('history-sign-in').hidden = Boolean(user);
  };
  const consent = () => {
    const enabled = Boolean(user && $('usage-consent').checked);
    try { if (user) localStorage.setItem(consentKey(), enabled ? 'yes' : 'no'); } catch { /* Consent still applies in this tab. */ }
    analytics.setConsent(enabled);
    analytics.flush();
  };
  async function refresh(authIdentity) {
    const own = ++generation;
    busy = null;
    historyRequest = null;
    let configured = false;
    try {
      const identity = authIdentity === undefined ? await service.getIdentity() : authIdentity;
      if (own !== generation || disposed) return;
      if (identity?.id !== user?.id) {
        analytics.setConsent(false);
        $('cloud-recordings-list').replaceChildren();
        $('cloud-recordings-status').textContent = '';
        historyCount(0);
        actions.accountChanged(identity?.id || '');
      }
      user = identity;
      if (!user) currentSession = null;
      else if (currentSession?.ownerId !== user.id) {
        // Capture draft edits before recovery can restore a newer cloud report.
        const saved = service.readCurrentRehearsal?.();
        currentSession = { ownerId: user.id, snapshot: saved?.ownerId === user.id ? saved : null, ready: false, restoring: null };
      }
      if (!user) historyCount(0);
      else if ($('history-count')) $('history-count').hidden = false;
      syncHistoryControls();
      if (!user) $('cloud-recordings-status').textContent = 'Sign in to see rehearsals saved privately to your account.';
      $('oauth-options').hidden = Boolean(user);
      $('account-details').hidden = !user;
      $('usage-consent').checked = Boolean(user && readConsent());
      analytics.setConsent($('usage-consent').checked);
      const config = await service.request('/api/config');
      if (own !== generation || disposed) return;
      actions.updateConfig(config);
      configured = true;
      actions.configurationReady?.();
      liveTranscription = Boolean(config.liveTranscription);
      dialog.querySelector('.key-privacy-note p').textContent = (liveTranscription
        ? 'While signed in, recording streams audio to OpenAI for live transcription. Stop saves the complete recording and transcript privately. Replay does not upload audio. '
        : 'Transcription sends audio to OpenAI and saves your recording and transcript privately. Replay does not upload audio. ')
        + 'Analyze sends your transcript and preparation text to our AI coach and saves the resulting feedback. Raw rubric files stay on your device.';
      $('account-summary').textContent = user ? 'Private recording history · free for everyone' : '';
      await actions.recoverPending?.();
      if (own !== generation || disposed) return;
      await restoreCurrentRehearsal();
      if (own !== generation || disposed) return;
      if (user) await refreshHistory(); else { $('cloud-recordings-list').replaceChildren(); historyCount(0); }
    } catch (error) {
      if (own === generation && !disposed) {
        status(error.message);
        if (!configured) actions.configurationFailed?.(error.message);
      }
    }
  }
  async function refreshHistory() {
    const own = generation;
    if (!user || disposed) { syncHistoryControls(); return; }
    if (historyRequest?.generation === own) return historyRequest.promise;
    const request = { generation: own }; historyRequest = request;
    syncHistoryControls();
    $('cloud-recordings-status').textContent = 'Loading your saved rehearsals…';
    request.promise = (async () => { try {
      const { recordings } = await service.request('/api/recordings');
      if (own !== generation || disposed) return;
      if (!Array.isArray(recordings)) throw new Error('The history response was incomplete.');
      const list = $('cloud-recordings-list');
      list.replaceChildren();
      for (const record of recordings || []) {
        const row = document.createElement('div'); row.className = 'saved-recording-row';
        const info = document.createElement('div'); info.className = 'saved-recording-meta';
        const title = document.createElement('strong'); title.textContent = record.title || 'My rehearsal';
        const date = document.createElement('span'); date.className = 'saved-recording-info';
        const created = new Date(record.createdAt ?? NaN);
        const dateLabel = Number.isFinite(created.getTime()) ? created.toLocaleString() : 'Date unavailable';
        date.textContent = dateLabel;
        info.append(title, date);
        const duration = document.createElement('span'); duration.className = 'saved-recording-duration';
        const seconds = record.durationSeconds;
        duration.textContent = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
          ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '—';
        const state = document.createElement('span'); state.className = 'saved-recording-state';
        const labels = { analyzed: 'Feedback ready', transcribed: 'Ready to analyze', transcribing: 'Transcribing',
          pending: 'Needs transcription', failed: 'Needs attention', deleting: 'Deleting' };
        state.textContent = Object.hasOwn(labels, record.status) ? labels[record.status] : 'Status unavailable';
        const buttons = document.createElement('div'); buttons.className = 'saved-recording-actions';
        for (const [label, action] of [['Open', async () => {
          if (!actions.canReplaceAudio()) throw new Error('Finish or cancel your current recording or analysis before opening another take.');
          const viewGeneration = actions.captureViewGeneration?.();
          let saved;
          try { saved = await service.openRecording(record.id); }
          catch (error) { if (actions.isViewGenerationCurrent?.(viewGeneration) === false) return; throw error; }
          if (own !== generation || disposed) return;
          if (actions.isViewGenerationCurrent?.(viewGeneration) === false) return;
          if (!actions.canReplaceAudio()) throw new Error('Finish or cancel your current recording or analysis before opening another take.');
          actions.restoreRecording(saved, { showRehearse: true, viewGeneration });
        }], ['Delete', async () => {
          if (!actions.canReplaceAudio()) throw new Error('Finish or cancel your current recording or analysis before deleting a take.');
          if (!window.confirm('Permanently delete this saved recording, transcript, and feedback from your account?')) return;
          await service.request(`/api/recordings/${record.id}`, { method: 'DELETE' });
          if (own !== generation || disposed) return;
          actions.recordingDeleted(record.id);
          await refreshHistory();
        }]]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = label === 'Open' ? 'secondary-button small-button' : 'text-button saved-recording-delete'; button.textContent = label;
          button.setAttribute('aria-label', `${label} ${record.title || 'My rehearsal'} from ${dateLabel}`);
          button.addEventListener('click', async () => {
            if (disposed || own !== generation || busy?.generation === own || historyRequest?.generation === own) return;
            const operation = { generation: own }; busy = operation; syncHistoryControls();
            try { await action(); } catch (error) { if (own === generation && !disposed) $('cloud-recordings-status').textContent = error.message; }
            finally { if (busy === operation) { busy = null; syncHistoryControls(); } }
          });
          buttons.append(button);
        }
        row.append(info, duration, state, buttons); list.append(row);
      }
      historyCount(recordings?.length || 0);
      syncHistoryControls();
      $('cloud-recordings-status').textContent = recordings?.length ? 'Private to your account. Open a take to revisit its transcript and feedback.' : liveTranscription
        ? 'No cloud recordings yet. Stop your recording to save the complete take privately.'
        : 'No cloud recordings yet. Create transcript or Analyze saves the current take privately.';
    } catch (error) { if (own === generation && !disposed) $('cloud-recordings-status').textContent = `Saved rehearsals couldn’t be loaded. Try again. ${error.message}`; }
    finally { if (historyRequest === request) { historyRequest = null; syncHistoryControls(); } }
    })();
    return request.promise;
  }
  for (const provider of ['google', 'azure']) $(provider === 'google' ? 'sign-in-google' : 'sign-in-microsoft').addEventListener('click', async () => {
    if (signingIn) return;
    signingIn = true;
    $('sign-in-google').disabled = $('sign-in-microsoft').disabled = true;
    try {
      status('Checking sign-in…');
      const redirect = new URL(location.href); redirect.search = ''; redirect.hash = '';
      await beginHostedSignIn(service, provider, redirect.href);
    } catch (error) { status(error.message); }
    finally { signingIn = false; $('sign-in-google').disabled = $('sign-in-microsoft').disabled = false; }
  });
  $('account-signout').addEventListener('click', async () => {
    if (signingOut) return;
    signingOut = true; $('account-signout').disabled = true;
    try { await service.signOut(); status('Signed out.'); } catch (error) { status(error.message); }
    finally { signingOut = false; $('account-signout').disabled = false; }
  });
  $('account-close').addEventListener('click', close);
  $('usage-consent').addEventListener('change', consent);
  $('cloud-history-refresh').addEventListener('click', refreshHistory);
  $('history-sign-in')?.addEventListener('click', show);
  $('cloud-recordings-details').addEventListener('toggle', () => { if ($('cloud-recordings-details').open) refreshHistory(); });

  let section = 'prepare';
  const sections = [['prepare', document.querySelector('.prepare-panel')], ['rehearse', document.querySelector('.record-panel')], ['feedback', $('report')]];
  const updateView = () => {
    const visible = sections.filter(([, el]) => {
      if (!el) return false;
      for (let ancestor = el; ancestor; ancestor = ancestor.parentElement) if (ancestor.hidden) return false;
      return true;
    }).map(([name, el]) => {
      const rect = el.getBoundingClientRect();
      return { name, area: Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) * Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) };
    }).sort((a, b) => b.area - a.area);
    if (visible[0]?.area > 0) section = visible[0].name;
    analytics.setView({ section, visible: !document.hidden && Boolean(visible[0]?.area), focused: document.hasFocus() });
  };
  const activity = () => { analytics.activity(); updateView(); };
  const visibility = () => { updateView(); if (document.hidden) { saveCurrentRehearsal(); analytics.flush(); } };
  const events = ['pointerdown', 'click', 'keydown', 'scroll'];
  events.forEach(name => window.addEventListener(name, activity, { passive: true }));
  window.addEventListener('focus', activity); window.addEventListener('blur', updateView);
  document.addEventListener('visibilitychange', visibility);
  const timer = setInterval(() => { updateView(); analytics.flush(); }, 15_000);
  const unsubscribe = service.onAuthChange(refresh);
  window.rehearsalAccount = { open: show, refresh: () => refresh(), refreshHistory,
    saveCurrentRehearsal, clearCurrentRehearsal, restoreCurrentRehearsal,
    track: name => { analytics.track(name); analytics.flush(); } };
  window.addEventListener('pagehide', event => {
    saveCurrentRehearsal();
    if (event.persisted) { analytics.setView({ visible: false }); analytics.flush(); return; }
    disposed = true; generation++; clearInterval(timer); unsubscribe(); analytics.dispose();
    events.forEach(name => window.removeEventListener(name, activity));
    window.removeEventListener('focus', activity); window.removeEventListener('blur', updateView); document.removeEventListener('visibilitychange', visibility);
  });
  updateView(); refresh();
}
