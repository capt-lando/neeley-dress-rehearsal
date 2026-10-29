import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHostedApi } from '../supabase/functions/rehearsal-api/api.mjs';
import { createSupabaseStore } from '../supabase/functions/rehearsal-api/store.mjs';

const policyText=await readFile(new URL('../lib/coaching-prompt.md',import.meta.url),'utf8');
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const sessionId='33333333-3333-4333-8333-333333333333';
const origin='https://capt-lando.github.io';
const token='header.'+Buffer.from(JSON.stringify({sub:owner,session_id:sessionId,amr:[{method:'oauth'}]})).toString('base64url')+'.signature';
function fixture() {
  const calls=[];let preference={signInCount:4,dontShowAgain:false};
  const app=createHostedApi({policyText,env:{ALLOWED_ORIGINS:origin,COACHING_PROVIDER:'openai',COACHING_RESERVE_MICROUSD:'500000'},store:{
    async verifyUser(){return {id:owner,identities:[{provider:'google'}]};},async admitRequest(){},async profile(){},
    async welcomePreference(id,hide){calls.push({id,hide});if(hide!==undefined)preference={...preference,dontShowAgain:hide};return {...preference};},
  }});
  const call=(options={})=>app(new Request('https://project.supabase.co/functions/v1/rehearsal-api/welcome-preference'+(options.query||''),{
    method:options.method||'GET',headers:{Origin:origin,...(options.signedOut?{}:{Authorization:`Bearer ${options.token||token}`}),...(options.body===undefined?{}:{'Content-Type':'application/json'})},
    ...(options.body===undefined?{}:{body:JSON.stringify(options.body)}),
  }));
  return {call,calls};
}

test('welcome preference uses only the verified account and current verified session identifier',async()=>{
  const f=fixture(),response=await f.call();
  assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
  assert.deepEqual(await response.json(),{signInCount:4,dontShowAgain:false,sessionId});
  assert.deepEqual(f.calls,[{id:owner,hide:undefined}]);
  for(const dontShowAgain of [true,false]) {
    const saved=await f.call({method:'POST',body:{dontShowAgain}});
    assert.equal(saved.status,200);assert.deepEqual(await saved.json(),{signInCount:4,dontShowAgain,sessionId});
    assert.deepEqual(f.calls.at(-1),{id:owner,hide:dontShowAgain});
  }
});

test('welcome settings reject anonymous requests, forged identity/counts, and non-boolean preferences',async()=>{
  const f=fixture();
  for(const method of ['GET','POST'])assert.equal((await f.call({method,signedOut:true,...(method==='POST'?{body:{dontShowAgain:true}}:{})})).status,401);
  for(const body of [{},{dontShowAgain:null},{dontShowAgain:'true'},{dontShowAgain:1},{dontShowAgain:true,userId:other},{dontShowAgain:true,signInCount:0},{dontShowAgain:true,sessionId:other}]) {
    assert.equal((await f.call({method:'POST',body})).status,400);
  }
  assert.equal((await f.call({query:'?userId='+other})).status,400);
  assert.deepEqual(f.calls,[]);
});

test('welcome settings require a valid session ID from verified claims',async()=>{
  for(const session_id of [undefined,'not-a-session',owner+'?extra=1']) {
    const f=fixture();
    const invalid='header.'+Buffer.from(JSON.stringify({sub:owner,session_id,amr:[{method:'oauth'}]})).toString('base64url')+'.signature';
    assert.equal((await f.call({token:invalid})).status,401);assert.deepEqual(f.calls,[]);
  }
});

test('welcome store binds the verified account to its restricted RPC and redacts failures',async()=>{
  const calls=[],data={signInCount:3,dontShowAgain:false};
  const store=createSupabaseStore({async rpc(name,args){calls.push({name,args});return {data};}});
  assert.deepEqual(await store.welcomePreference(owner),data);
  await store.welcomePreference(owner,true);
  assert.deepEqual(calls,[
    {name:'rehearsal_welcome_preference',args:{p_user:owner,p_dont_show_again:null}},
    {name:'rehearsal_welcome_preference',args:{p_user:owner,p_dont_show_again:true}},
  ]);
  const failed=createSupabaseStore({async rpc(){return {error:{message:'sensitive database error'}};}});
  await assert.rejects(failed.welcomePreference(owner),{message:'Private storage is temporarily unavailable.',status:503});
});
