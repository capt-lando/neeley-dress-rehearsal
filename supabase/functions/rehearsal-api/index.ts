import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import policy from '../_shared/coaching-policy.json' with { type: 'json' };
import { createHostedApi } from './api.mjs';
import { createSupabaseStore } from './store.mjs';
import { createRealtimeHandler } from './realtime.mjs';

const env = Deno.env.toObject();
const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const store=createSupabaseStore(client);
const api=createHostedApi({env,store,policyText:policy.text});
const realtime=createRealtimeHandler({env,store,
  upgrade:(request:Request)=>Deno.upgradeWebSocket(request,{idleTimeout:0}),
  // This credential-bearing connection exists only in the server runtime. The
  // browser connects to our authenticated, duration-limited proxy instead.
  connectProvider:()=>new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription',[
    'realtime','openai-insecure-api-key.'+env.COACHING_API_KEY,
  ]),
  waitUntil:(promise:Promise<unknown>)=>EdgeRuntime.waitUntil(promise),
});
Deno.serve((request:Request)=>new URL(request.url).pathname.endsWith('/live-stream')?realtime(request):api(request));
