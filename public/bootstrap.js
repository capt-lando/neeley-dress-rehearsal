import policyText from '../lib/coaching-prompt.md?raw';
import { installBrowserTools } from './browser-tools.js';
import { readHostedConfig, createHostedService } from '../lib/hosted-service.mjs';

try {
  const hosted = readHostedConfig(import.meta.env);
  if (!hosted) throw new Error('Configure the private recording service before starting this website.');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(hosted.url, hosted.publishableKey, { auth: {
    flowType: 'pkce', persistSession: true, storage: sessionStorage, autoRefreshToken: true, detectSessionInUrl: true,
  } });
  const service = createHostedService({ client, ...hosted, policyText });
  installBrowserTools(service);
  await import('./app.js');
  const { installHostedAccount } = await import('./hosted-account.js');
  installHostedAccount(service, window.rehearsalHostedActions);
} catch {
  const message = document.getElementById('app-status');
  message.textContent = 'The app could not start. Please refresh. If this continues, contact the pilot organizer to check its configuration.';
  message.hidden = false; message.className = 'app-status error';
}
