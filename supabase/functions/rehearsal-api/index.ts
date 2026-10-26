import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import policy from '../_shared/coaching-policy.json' with { type: 'json' };
import { createHostedApi } from './api.mjs';
import { createSupabaseStore } from './store.mjs';

const env = Deno.env.toObject();
const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
Deno.serve(createHostedApi({ env, store: createSupabaseStore(client), policyText: policy.text }));
