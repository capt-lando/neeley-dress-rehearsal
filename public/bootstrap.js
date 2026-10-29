import policyText from '../lib/coaching-prompt.md?raw';
import { installBrowserTools } from './browser-tools.js';
import { readHostedConfig, createHostedService } from '../lib/hosted-service.mjs';
import { installWelcomeTutorial } from './welcome.js';

try {
  const hosted = readHostedConfig(import.meta.env);
  if (!hosted) throw new Error('Configure the private recording service before starting this website.');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(hosted.url, hosted.publishableKey, { auth: {
    // Supabase's default browser storage shares sign-in and token refresh across tabs.
    flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true,
  } });
  const service = createHostedService({ client, ...hosted, policyText });
  installBrowserTools(service);
  await import('./app.js');
  const { installHostedAccount } = await import('./hosted-account.js');
  installHostedAccount(service, window.rehearsalHostedActions);
  installWelcomeTutorial({ document, window });
} catch {
  const message = document.getElementById('app-status');
  message.textContent = 'The app could not start. Please refresh. If this continues, contact the pilot organizer to check its configuration.';
  message.hidden = false; message.className = 'app-status error';
}
