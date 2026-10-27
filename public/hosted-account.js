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
  let user = null, generation = 0, busy = false, disposed = false, signingIn = false, signingOut = false, liveTranscription = false, historyRequest = null;
  const analytics = createUsageAnalytics({ send: (events, { signal }) => service.request('/api/events', { method: 'POST', body: { events }, signal }) });
  const consentKey = () => user ? `neeley-usage-consent:${user.id}` : '';
  const readConsent = () => { try { return localStorage.getItem(consentKey()) === 'yes'; } catch { return false; } };
  const status = message => { $('account-status').textContent = message; };
  const show = () => { status(''); dialog.showModal(); };
  const close = () => dialog.close();
  const consent = () => {
    const enabled = Boolean(user && $('usage-consent').checked);
    try { if (user) localStorage.setItem(consentKey(), enabled ? 'yes' : 'no'); } catch { /* Consent still applies in this tab. */ }
    analytics.setConsent(enabled);
    analytics.flush();
  };
  async function refresh(authIdentity) {
    const own = ++generation;
    try {
      const identity = authIdentity === undefined ? await service.getIdentity() : authIdentity;
      if (own !== generation || disposed) return;
      if (identity?.id !== user?.id) {
        analytics.setConsent(false);
        $('cloud-recordings-list').replaceChildren();
        $('cloud-recordings-status').textContent = '';
        historyRequest = null;
        $('cloud-history-refresh').disabled = false;
        actions.accountChanged(identity?.id || '');
      }
      user = identity;
      $('oauth-options').hidden = Boolean(user);
      $('account-details').hidden = !user;
      $('usage-consent').checked = Boolean(user && readConsent());
      analytics.setConsent($('usage-consent').checked);
      const config = await service.request('/api/config');
      if (own !== generation || disposed) return;
      actions.updateConfig(config);
      liveTranscription = Boolean(config.liveTranscription);
      dialog.querySelector('.key-privacy-note p').textContent = (liveTranscription
        ? 'While signed in, recording sends 10-second audio segments for cloud transcription. Stop saves the complete recording and transcript privately. Replay does not upload audio. '
        : 'Create transcript or Analyze uploads and saves your recording, transcript, and resulting feedback privately. Recording and replay alone do not upload audio. ')
        + 'Coaching also sends your transcript and preparation text to our configured AI provider. Raw rubric files stay on your device.';
      $('account-summary').textContent = user ? 'Private recording history · free for everyone' : '';
      if (user) await refreshHistory(); else { $('cloud-recordings-list').replaceChildren(); $('cloud-recordings-status').textContent = 'Sign in to see recordings saved privately to your account.'; }
    } catch (error) { if (own === generation) status(error.message); }
  }
  async function refreshHistory() {
    const own = generation;
    if (!user || disposed) return;
    if (historyRequest?.generation === own) return historyRequest.promise;
    const request = { generation: own }; historyRequest = request;
    $('cloud-history-refresh').disabled = true;
    request.promise = (async () => { try {
      const { recordings } = await service.request('/api/recordings');
      if (own !== generation || disposed) return;
      const list = $('cloud-recordings-list');
      list.replaceChildren();
      for (const record of recordings || []) {
        const row = document.createElement('div'); row.className = 'saved-recording-row';
        const info = document.createElement('div'); info.className = 'saved-recording-meta';
        const title = document.createElement('strong'); title.textContent = record.title || 'My rehearsal';
        const date = document.createElement('span'); date.className = 'saved-recording-info';
        date.textContent = `${new Date(record.createdAt).toLocaleString()} · ${Math.floor(record.durationSeconds / 60)}:${String(Math.floor(record.durationSeconds % 60)).padStart(2, '0')}`;
        info.append(title, date);
        const buttons = document.createElement('div'); buttons.className = 'saved-recording-actions';
        for (const [label, action] of [['Open', async () => {
          if (!actions.canReplaceAudio()) throw new Error('Finish or cancel your current recording or analysis before opening another take.');
          const saved = await service.openRecording(record.id);
          if (own === generation) actions.restoreRecording(saved);
        }], ['Delete', async () => {
          if (!actions.canReplaceAudio()) throw new Error('Finish or cancel your current recording or analysis before deleting a take.');
          if (!window.confirm('Permanently delete this saved recording, transcript, and feedback from your account?')) return;
          await service.request(`/api/recordings/${record.id}`, { method: 'DELETE' });
          actions.recordingDeleted(record.id);
          await refreshHistory();
        }]]) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = label;
          button.setAttribute('aria-label', `${label} ${record.title || 'My rehearsal'} from ${new Date(record.createdAt).toLocaleString()}`);
          button.addEventListener('click', async () => {
            if (busy) return;
            busy = true; list.querySelectorAll('button').forEach(item => { item.disabled = true; });
            try { await action(); } catch (error) { $('cloud-recordings-status').textContent = error.message; }
            finally { busy = false; list.querySelectorAll('button').forEach(item => { item.disabled = false; }); }
          });
          buttons.append(button);
        }
        row.append(info, buttons); list.append(row);
      }
      $('cloud-recordings-status').textContent = recordings?.length ? 'Private to your account. Open a take to revisit its transcript and feedback.' : liveTranscription
        ? 'No cloud recordings yet. Stop your recording to save the complete take privately.'
        : 'No cloud recordings yet. Create transcript or Analyze saves the current take privately.';
    } catch (error) { if (own === generation) $('cloud-recordings-status').textContent = error.message; }
    finally { if (historyRequest === request) { historyRequest = null; $('cloud-history-refresh').disabled = false; } }
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
  $('cloud-recordings-details').addEventListener('toggle', () => { if ($('cloud-recordings-details').open) refreshHistory(); });

  let section = 'prepare';
  const sections = [['prepare', document.querySelector('.prepare-panel')], ['rehearse', document.querySelector('.record-panel')], ['feedback', $('report')]];
  const updateView = () => {
    const visible = sections.filter(([, el]) => !el.hidden).map(([name, el]) => {
      const rect = el.getBoundingClientRect();
      return { name, area: Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) * Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) };
    }).sort((a, b) => b.area - a.area);
    if (visible[0]?.area > 0) section = visible[0].name;
    analytics.setView({ section, visible: !document.hidden && Boolean(visible[0]?.area), focused: document.hasFocus() });
  };
  const activity = () => { analytics.activity(); updateView(); };
  const visibility = () => { updateView(); if (document.hidden) analytics.flush(); };
  const events = ['pointerdown', 'keydown', 'scroll'];
  events.forEach(name => window.addEventListener(name, activity, { passive: true }));
  window.addEventListener('focus', activity); window.addEventListener('blur', updateView);
  document.addEventListener('visibilitychange', visibility);
  const timer = setInterval(() => { updateView(); analytics.flush(); }, 15_000);
  const unsubscribe = service.onAuthChange(refresh);
  window.rehearsalAccount = { open: show, refreshHistory, track: name => { analytics.track(name); analytics.flush(); } };
  window.addEventListener('pagehide', event => {
    if (event.persisted) { analytics.setView({ visible: false }); analytics.flush(); return; }
    disposed = true; generation++; clearInterval(timer); unsubscribe(); analytics.dispose();
    events.forEach(name => window.removeEventListener(name, activity));
    window.removeEventListener('focus', activity); window.removeEventListener('blur', updateView); document.removeEventListener('visibilitychange', visibility);
  });
  updateView(); refresh();
}
