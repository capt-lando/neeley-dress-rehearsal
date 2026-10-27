import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedApi, fail } from '../supabase/functions/rehearsal-api/api.mjs';
const user='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333';
const other='44444444-4444-4444-8444-444444444444',origin='https://capt-lando.github.io';
const draftKey=Buffer.alloc(32,42).toString('base64url');
const token='h.'+Buffer.from(JSON.stringify({sub:user,amr:[{method:'oauth'}]})).toString('base64url')+'.s';
function wav(samples=160000) {
  const b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);return b;
}
function fixture({store:extra={},env:settings={}}={}) {
  const calls=[];let session=null,audio=wav(),debits=0,cancelled=false;
  function owned(owner,key){assert.equal(owner,user);if(key!==id||!session)throw fail('Not found.',404);return session;}
  const store={
    async admitRequest(){},async verifyUser(value){return value===token?{id:user,identities:[{provider:'google'}]}:null;},async profile(){},
    async liveStart(owner,key,request,title,hash,cost){assert.equal(owner,user);assert.equal(key,id);assert.equal(request,requestId);assert.equal(cost,300000);calls.push('reserve');
      if(cancelled)throw fail('This live rehearsal ended.',409);
      if(!session){debits++;session={request_id:requestId,status:'active',transport:'openai-stream',draft_key:draftKey,next_sequence:0,stream_segments:[],transcript:'Server transcript.',expires_at:'2030-10-27T12:12:00Z',storage_path:`${user}/${id}/audio.wav`};}return session;},
    async liveGet(owner,key){return owned(owner,key);},
    async liveDraftKey(owner,key,request){const s=owned(owner,key);if(request!==s.request_id||!s.draft_key)throw fail('Not found.',404);return {draft_key:s.draft_key};},
    async liveClose(owner,key,cancel=false){const s=owned(owner,key);if(s.status==='active')s.status=cancel?'cancelled':'failed';},
    async liveCancel(owner,key,request){assert.equal(owner,user);if(key!==id)throw fail('Not found.',404);if(request!==requestId)throw fail('Conflict.',409);
      cancelled=true;if(session?.status==='active')session.status='cancelled';return {status:session?.status||'cancelled',audio_saved:false};},
    async owned(owner,key){owned(owner,key);return {status:'pending',storage_path:`${user}/${id}/audio.wav`};},
    async audio(path){assert.equal(path,`${user}/${id}/audio.wav`);return new Blob([audio]);},
    async liveFinish(owner,key,duration,size){const s=owned(owner,key);calls.push('finish');assert.equal(size,audio.length);assert.equal(duration,(size-44)/32000);
      const complete=s.status==='active'||s.status==='completed';if(complete)s.status='completed';s.draft_key=null;return {complete,text:complete?s.transcript:''};},...extra,
  };
  const app=createHostedApi({store,env:{ALLOWED_ORIGINS:origin,COACHING_PROVIDER:'openai',COACHING_API_KEY:'private-key',...settings},policyText:'Coach the rehearsal.',fetchImpl:async()=>{throw new Error('Live admission must not call a provider.');}});
  const call=(path,{method='POST',body,auth=token}={})=>app(new Request('https://project.supabase.co/functions/v1/rehearsal-api'+path,{method,headers:{Origin:origin,...(auth?{Authorization:`Bearer ${auth}`}:{ } ),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}));
  return {call,start:()=>call('/live-sessions',{body:{recordingId:id,requestId,title:'Live practice'}}),calls,setAudio(value){audio=value;},get session(){return session;},get debits(){return debits;}};
}
test('live admission reserves once and returns bounded streaming configuration without a provider credential',async()=>{
  const f=fixture(),response=await f.start();assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.transport,'websocket');assert.equal(result.sampleRate,24000);assert.equal(result.segmentSeconds,110);assert.equal(result.maxDurationSeconds,600);
  assert.equal(result.draftKey,draftKey);
  assert.equal((await f.start()).status,200);assert.equal(f.debits,1);assert.doesNotMatch(JSON.stringify(result),/private-key|token|secret/);
});
test('retired warmup and ten-second chunk routes never start compute',async()=>{
  const f=fixture();await f.start();
  for(const path of ['/speech/prepare',`/live-sessions/${id}/prepare`,`/live-sessions/${id}/chunks/0`])assert.equal((await f.call(path)).status,404);
});
test('refresh cancellation closes the exact request regardless of admission order',async()=>{
  for(const startFirst of [true,false]) {
    const f=fixture();if(startFirst)await f.start();const response=await f.call(`/live-sessions/${id}/cancel`,{body:{requestId}});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{recordingId:id,cancelled:true,status:'cancelled',audioSaved:false});
    assert.equal((await f.start()).status,409);assert.equal((await f.call(`/live-sessions/${id}/cancel`,{body:{requestId}})).status,200);assert.equal(f.debits,startFirst?1:0);
  }
});
test('cancellation requires verified ownership and exact IDs even if new speech is disabled',async()=>{
  const f=fixture({env:{COACHING_API_KEY:''}}),path=`/live-sessions/${id}/cancel`;
  assert.equal((await f.call(path,{auth:null,body:{requestId}})).status,401);assert.equal((await f.call(path,{body:{requestId,userId:other}})).status,400);
  assert.equal((await f.call(path,{body:{requestId:other}})).status,409);assert.equal((await f.call(`/live-sessions/${other}/cancel`,{body:{requestId}})).status,404);
  assert.equal((await f.call(path,{body:{requestId:'invalid'}})).status,400);assert.equal((await f.call(path,{body:{requestId}})).status,200);assert.equal(f.debits,0);
});
test('refresh cancellation preserves completed saved audio and returns no transcript content',async()=>{
  const f=fixture({store:{liveCancel:async()=>({status:'completed',audio_saved:true,transcript:'private content omitted'})}});
  assert.deepEqual(await(await f.call(`/live-sessions/${id}/cancel`,{body:{requestId}})).json(),{recordingId:id,cancelled:true,status:'completed',audioSaved:true});
});
test('live routes reject unsupported fields, anonymous and foreign owners before admission',async()=>{
  const f=fixture();assert.equal((await f.call('/live-sessions',{auth:null,body:{recordingId:id,requestId}})).status,401);
  assert.equal((await f.call('/live-sessions',{body:{recordingId:id,requestId,model:'other'}})).status,400);await f.start();
  assert.equal((await f.call(`/live-sessions/${other}`,{method:'GET'})).status,404);
  const disabled=fixture({env:{COACHING_PROVIDER:'google'}});assert.equal((await disabled.start()).status,503);assert.equal(disabled.debits,0);
});
test('finalization uses actual private WAV bytes and server transcript, never browser text',async()=>{
  const f=fixture();await f.start();const path=`/live-sessions/${id}/finish`;
  assert.equal((await f.call(path,{body:{durationSeconds:10,sizeBytes:320044,text:'Forged transcript'}})).status,400);
  assert.equal((await f.call(path,{body:{durationSeconds:10,sizeBytes:44}})).status,400);
  assert.equal((await f.call(path,{body:{durationSeconds:9,sizeBytes:320044}})).status,400);
  const result=await(await f.call(path,{body:{durationSeconds:10,sizeBytes:320044}})).json();
  assert.equal(result.complete,true);assert.equal(result.text,'Server transcript.');assert.equal(result.model,'gpt-live-transcribe');
  const cancelled=fixture();await cancelled.start();await cancelled.call(`/live-sessions/${id}`,{method:'DELETE'});
  const saved=await(await cancelled.call(path,{body:{durationSeconds:10,sizeBytes:320044}})).json();assert.equal(saved.complete,false);assert.equal(saved.text,'');assert.equal(cancelled.debits,1);
});
test('cancellation waits for the relay stop acknowledgment instead of just closing the UI',async()=>{
  let polls=0;
  const f=fixture({store:{liveGet:async()=>({status:'cancelled',stream_segments:++polls<2?[{state:'reserved',expiresAt:new Date(Date.now()+125000).toISOString()}]:[{state:'cancelled'}]})}});
  await f.start();const response=await f.call(`/live-sessions/${id}/cancel`,{body:{requestId}});assert.equal(response.status,200);assert.equal(polls,2);
});

test('draft keys require verified ownership and exact request, survive cancellation, and disappear after saving',async()=>{
  const f=fixture();await f.start();const path=`/live-sessions/${id}/draft-key/${requestId}`;
  assert.equal((await f.call(path,{method:'GET',auth:null})).status,401);
  assert.equal((await f.call(`/live-sessions/${other}/draft-key/${requestId}`,{method:'GET'})).status,404);
  assert.equal((await f.call(`/live-sessions/${id}/draft-key/${other}`,{method:'GET'})).status,404);
  assert.equal((await f.call(`/live-sessions/${id}/draft-key/invalid`,{method:'GET'})).status,400);
  const response=await f.call(path,{method:'GET'});assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{recordingId:id,requestId,draftKey});
  await f.call(`/live-sessions/${id}/cancel`,{body:{requestId}});
  assert.equal((await(await f.call(path,{method:'GET'})).json()).draftKey,draftKey);
  await f.call(`/live-sessions/${id}/finish`,{body:{durationSeconds:10,sizeBytes:320044}});
  assert.equal((await f.call(path,{method:'GET'})).status,404);
});

test('draft recovery needs no configured speech provider and invalid key data stays redacted',async()=>{
  const f=fixture({env:{COACHING_API_KEY:''},store:{liveDraftKey:async(owner,key,request)=>{
    assert.equal(owner,user);assert.equal(key,id);assert.equal(request,requestId);return {draft_key:draftKey};}}});
  assert.equal((await f.call(`/live-sessions/${id}/draft-key/${requestId}`,{method:'GET'})).status,200);
  const bad=fixture({store:{liveDraftKey:async()=>({draft_key:'sensitive diagnostic'}),liveStart:async()=>({status:'active',expires_at:'2030-10-27T12:12:00Z',draft_key:'sensitive diagnostic'})}});
  for(const response of [await bad.start(),await bad.call(`/live-sessions/${id}/draft-key/${requestId}`,{method:'GET'})]) {
    assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/sensitive diagnostic/);
  }
});

test('replaying an expired live start cannot expose its old recovery key',async()=>{
  const f=fixture();await f.start();f.session.expires_at='2000-01-01T00:00:00Z';
  const response=await f.start();assert.equal(response.status,409);assert.doesNotMatch(await response.text(),new RegExp(draftKey));assert.equal(f.debits,1);
});
