import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedApi, fail } from '../supabase/functions/rehearsal-api/api.mjs';

const user='11111111-1111-4111-8111-111111111111';
const origin='https://capt-lando.github.io';
const token='header.'+Buffer.from(JSON.stringify({sub:user,amr:[{method:'oauth'}]})).toString('base64url')+'.signature';
const env={ALLOWED_ORIGINS:origin,BARK_WORKER_URL:'https://speech.example/transcribe',BARK_WORKER_ALLOWED_HOSTS:'speech.example',BARK_WORKER_TOKEN:'secret',BARK_RESERVE_MICROUSD:'75000'};
function fixture({claim={state:'new',ready:false},finish,upstream,denial}={}) {
  const calls=[];
  const store={
    async admitRequest(id){calls.push(['admit',id]);},
    async verifyUser(){return {id:user,identities:[{provider:'google'}]};},
    async profile(){},
    async speechWarmupReserve(id,request,cost){calls.push(['reserve',id,request,cost]);if(denial)throw denial;return claim;},
    async speechWarmupFinish(id,request,ready){calls.push(['finish',id,request,ready]);return finish||{state:ready?'ready':'unavailable',ready};},
  };
  const api=createHostedApi({store,env,now:()=>1000000,policyText:'Coach the rehearsal.',fetchImpl:async(url,options)=>{
    calls.push(['fetch',url,options]);return upstream?upstream():Response.json({ready:true,model:'bark-3.0-plus'});
  }});
  return {calls,call:({body,auth=true,originHeader=origin}={})=>api(new Request('https://pilot.supabase.co/functions/v1/rehearsal-api/speech/prepare',{
    method:'POST',headers:{origin:originHeader,...(auth?{authorization:`Bearer ${token}`} : {}),...(body?{'content-type':'application/json'}:{})},body,
  }))};
}
test('sign-in startup verifies OAuth, reserves the existing budget and sends no personal content',async()=>{
  const f=fixture(),result=await f.call();assert.equal(result.status,200);assert.deepEqual(await result.json(),{ready:true,state:'ready'});
  const reserve=f.calls.find(call=>call[0]==='reserve'),sent=f.calls.find(call=>call[0]==='fetch'),finish=f.calls.find(call=>call[0]==='finish');
  assert.equal(reserve[1],user);assert.equal(reserve[3],75000);assert.match(reserve[2],/^[a-f0-9-]{36}$/);
  assert.equal(sent[1],'https://speech.example/prepare');assert.equal(sent[2].method,'POST');assert.equal(sent[2].body,undefined);
  assert.equal(sent[2].headers.Authorization,'Bearer secret');assert.equal(sent[2].headers['X-Rehearsal-Request'],`${user}:${reserve[2]}`);
  assert.equal(sent[2].headers['X-Rehearsal-Prepare-Expires'],'1125000');
  assert.equal(sent[2].redirect,'error');assert.ok(sent[2].signal instanceof AbortSignal);
  assert.deepEqual(finish,['finish',user,reserve[2],true]);
  assert.ok(f.calls.findIndex(call=>call[0]==='reserve')<f.calls.findIndex(call=>call[0]==='fetch'));
});
test('signed-out, foreign-origin and body-bearing warmups never reserve or wake compute',async()=>{
  for(const [options,status] of [[{auth:false},401],[{originHeader:'https://evil.example'},403],[{body:JSON.stringify({userId:user})},413]]){
    const f=fixture();assert.equal((await f.call(options)).status,status);
    assert.equal(f.calls.some(call=>['reserve','fetch','finish'].includes(call[0])),false);
  }
});
test('shared startup leases and cooldowns never cause another worker call',async()=>{
  for(const claim of [{state:'pending',ready:false},{state:'skipped',ready:false},{state:'ready',ready:true}]){
    const f=fixture({claim});const result=await f.call();assert.deepEqual(await result.json(),claim);
    assert.equal(f.calls.filter(call=>call[0]==='reserve').length,1);
    assert.equal(f.calls.some(call=>['fetch','finish'].includes(call[0])),false);
  }
});
test('budget rejection fails before compute starts',async()=>{
  const f=fixture({denial:fail('Allowance unavailable.',429)});assert.equal((await f.call()).status,429);
  assert.equal(f.calls.some(call=>call[0]==='fetch'),false);
});
test('startup failure is acknowledged without claiming readiness or exposing provider diagnostics',async()=>{
  for(const upstream of [async()=>{throw new Error('secret provider failure');},async()=>new Response('private details',{status:429}),async()=>Response.json({ready:true,model:'other'}),async()=>new Response('unreadable')]){
    const f=fixture({upstream});const result=await f.call();assert.equal(result.status,200);assert.deepEqual(await result.json(),{ready:false,state:'unavailable'});
    assert.equal(f.calls.find(call=>call[0]==='finish')[3],false);
  }
});
test('late startup completion cannot override a superseded lease',async()=>{
  const f=fixture({finish:{ready:false,state:'skipped'}});assert.deepEqual(await (await f.call()).json(),{ready:false,state:'skipped'});
});
