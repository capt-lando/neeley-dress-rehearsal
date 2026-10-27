import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHostedApi, fail, inspectHostedWav } from '../supabase/functions/rehearsal-api/api.mjs';

const policyText=await readFile(new URL('../lib/coaching-prompt.md',import.meta.url),'utf8');
const user='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333';
const other='44444444-4444-4444-8444-444444444444',origin='https://capt-lando.github.io';
const token='h.'+Buffer.from(JSON.stringify({sub:user,amr:[{method:'oauth'}]})).toString('base64url')+'.s';
function wav(samples=160000) {
  const b=Buffer.alloc(44+samples*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);return b;
}
function fixture({network,store:extra={},env:settings={}}={}) {
  const calls=[];let session=null,audio=wav(),debits=0,cancelled=false;
  function owned(owner,key) {assert.equal(owner,user);if(key!==id||!session)throw fail('Not found.',404);return session;}
  const store={
    async admitRequest(){},
    async verifyUser(value){return value===token?{id:user,identities:[{provider:'google'}]}:null;},async profile(){},
    async liveStart(owner,key,request,title,hash,cost){assert.equal(owner,user);assert.equal(key,id);assert.equal(request,requestId);assert.equal(cost,300000);calls.push('reserve');
      if(cancelled)throw fail('This live rehearsal ended.',409);
      if(!session){debits++;session={request_id:requestId,status:'active',prepare_state:'idle',next_sequence:0,chunks:[],transcript:'',expires_at:'2026-10-27T12:12:00Z',storage_path:`${user}/${id}/audio.wav`};}return session;},
    async requestStatus(owner,request){assert.equal(owner,user);assert.equal(request,requestId);return {state:session?.status==='active'?'reserved':session?.status==='completed'?'completed':'failed'};},
    async liveGet(owner,key){return owned(owner,key);},
    async livePrepare(owner,key){const s=owned(owner,key);if(s.status!=='active')throw fail('Ended.',409);const state=s.prepare_state;if(state==='idle')s.prepare_state='reserved';return {state:state==='idle'?'new':state};},
    async livePrepared(owner,key){const s=owned(owner,key);if(s.status!=='active')throw fail('Ended.',409);s.prepare_state='completed';},
    async liveChunk(owner,key,seq,hash,samples,final){const s=owned(owner,key),prior=s.chunks[seq];calls.push('chunk-claim');
      if(prior){if(prior.hash!==hash||prior.samples!==samples||prior.final!==final)throw fail('Conflict.',409);return prior;}
      if(s.status!=='active'||s.prepare_state!=='completed'||seq!==s.next_sequence||s.chunks.length!==seq||s.final)throw fail('Not ready.',409);
      s.chunks.push({state:'reserved',hash,samples,final});s.final=final;return {state:'new'};},
    async liveChunkDone(owner,key,seq,text){const s=owned(owner,key);if(s.status!=='active')throw fail('Ended.',409);Object.assign(s.chunks[seq],{state:'completed',text});s.next_sequence++;s.transcript=s.chunks.map(c=>c.text||'').filter(Boolean).join(' ');return s.chunks[seq];},
    async liveClose(owner,key,cancel=false){const s=owned(owner,key);if(s.status==='active')s.status=cancel?'cancelled':'failed';},
    async liveCancel(owner,key,request){assert.equal(owner,user);if(key!==id)throw fail('Not found.',404);if(request!==requestId)throw fail('Conflict.',409);
      cancelled=true;if(session?.status==='active')session.status='cancelled';return {status:session?.status||'cancelled',audio_saved:false};},
    async owned(owner,key){owned(owner,key);return {status:'pending',storage_path:`${user}/${id}/audio.wav`};},
    async audio(path){assert.equal(path,`${user}/${id}/audio.wav`);return new Blob([audio]);},
    async liveFinish(owner,key,duration,size){const s=owned(owner,key);calls.push('finish');assert.equal(size,audio.length);assert.equal(duration,(size-44)/32000);
      const complete=s.status==='active'||s.status==='completed';if(complete)s.status='completed';return {complete,text:complete?s.transcript:''};},
    ...extra,
  };
  const env={ALLOWED_ORIGINS:origin,BARK_WORKER_URL:'https://worker.example/transcribe',BARK_WORKER_ALLOWED_HOSTS:'worker.example',BARK_WORKER_TOKEN:'worker-secret',BARK_WORKER_MODAL_KEY:'proxy-key',BARK_WORKER_MODAL_SECRET:'proxy-secret',BARK_RESERVE_MICROUSD:'75000',BARK_LIVE_RESERVE_MICROUSD:'300000',...settings};
  const app=createHostedApi({store,env,policyText,fetchImpl:async(url,options)=>{calls.push({url,options});if(url.endsWith('/cancel'))return Response.json({cancelled:true});if(network)return network(url,options);return Response.json(url.endsWith('/prepare')?{ready:true,model:'bark-3.0-plus'}:{text:'Um, practice helps.',durationSeconds:(options.body.byteLength-44)/32000,model:'bark-3.0-plus'});}});
  const call=(path,{method='POST',body,raw,final=false,auth=token,headers={}}={})=>app(new Request('https://project.supabase.co/functions/v1/rehearsal-api'+path,{method,headers:{Origin:origin,...(auth?{Authorization:`Bearer ${auth}`}:{ } ),...(raw?{'Content-Type':'audio/wav'}:body?{'Content-Type':'application/json'}:{}),...(final?{'X-Rehearsal-Final':'true'}:{}),...headers},...(raw?{body:raw}:body?{body:JSON.stringify(body)}:{})}));
  const start=()=>call('/live-sessions',{body:{recordingId:id,requestId,title:'Live practice'}});
  const prepare=()=>call(`/live-sessions/${id}/prepare`);
  const chunk=(seq,raw=wav(),final=false)=>call(`/live-sessions/${id}/chunks/${seq}`,{raw,final});
  return {call,start,prepare,chunk,calls,setAudio(value){audio=value;},get session(){return session;},get debits(){return debits;}};
}

test('live session reserves once, warms only once, and keeps worker credentials server-side',async()=>{
  const f=fixture();assert.equal((await f.start()).status,200);assert.equal((await f.start()).status,200);assert.equal(f.debits,1);
  assert.equal((await f.prepare()).status,200);assert.equal((await f.prepare()).status,200);
  const requests=f.calls.filter(c=>c.url);assert.equal(requests.length,1);assert.equal(requests[0].url,'https://worker.example/prepare');
  assert.equal(requests[0].options.headers['Modal-Secret'],'proxy-secret');assert.equal(requests[0].options.body,undefined);assert.equal(requests[0].options.redirect,'error');
  assert.ok(f.calls.indexOf('reserve')<f.calls.indexOf(requests[0]));assert.doesNotMatch(JSON.stringify(await(await f.start()).json()),/secret|proxy-key/);
});

test('refresh cancellation closes the exact request regardless of whether start arrived first',async()=>{
  for(const startFirst of [true,false]) {
    const f=fixture();if(startFirst)await f.start();
    const response=await f.call(`/live-sessions/${id}/cancel`,{body:{requestId}});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{recordingId:id,cancelled:true,status:'cancelled',audioSaved:false});
    assert.equal((await f.start()).status,409);
    assert.equal((await f.call(`/live-sessions/${id}/cancel`,{body:{requestId}})).status,200);
    assert.equal(f.debits,startFirst?1:0);assert.equal(f.calls.some(c=>c.url&&!c.url.endsWith('/cancel')),false);
  }
});

test('refresh cancellation requires verified ownership and exact IDs even when speech is disabled',async()=>{
  const f=fixture({env:{BARK_LIVE_RESERVE_MICROUSD:''}}),path=`/live-sessions/${id}/cancel`;
  assert.equal((await f.call(path,{auth:null,body:{requestId}})).status,401);
  assert.equal((await f.call(path,{body:{requestId,userId:other}})).status,400);
  assert.equal((await f.call(path,{body:{requestId:other}})).status,409);
  assert.equal((await f.call(`/live-sessions/${other}/cancel`,{body:{requestId}})).status,404);
  assert.equal((await f.call(path,{body:{requestId:'invalid'}})).status,400);
  assert.equal((await f.call(path,{body:{requestId}})).status,200);
  assert.equal(f.debits,0);
});

test('refresh cancellation returns saved-audio presence and preserves a completed session',async()=>{
  const f=fixture({store:{liveCancel:async(owner,key,request)=>{
    assert.equal(owner,user);assert.equal(key,id);assert.equal(request,requestId);
    return {status:'completed',audio_saved:true,transcript:'private content omitted'};
  }}});
  const response=await f.call(`/live-sessions/${id}/cancel`,{body:{requestId}});
  assert.deepEqual(await response.json(),{recordingId:id,cancelled:true,status:'completed',audioSaved:true});
  assert.equal(f.debits,0);
});
test('live routes reject anonymous, foreign-owner, unknown fields, and disabled configuration before worker calls',async()=>{
  const f=fixture();assert.equal((await f.call('/live-sessions',{auth:null,body:{recordingId:id,requestId}})).status,401);
  assert.equal((await f.call('/live-sessions',{body:{recordingId:id,requestId,model:'other'}})).status,400);await f.start();
  assert.equal((await f.call(`/live-sessions/${other}/prepare`)).status,404);assert.equal(f.calls.some(c=>c.url),false);
  const disabled=fixture({env:{BARK_LIVE_RESERVE_MICROUSD:''}});assert.equal((await disabled.start()).status,503);assert.equal(disabled.debits,0);
});
test('ordered ten-second chunks and a one-sample ending have stable replay without new reservations',async()=>{
  const f=fixture();await f.start();await f.prepare();assert.equal((await f.chunk(1)).status,409);
  const first=await(await f.chunk(0)).json();assert.equal(first.nextSequence,1);assert.equal(first.durationSeconds,10);
  const tail=await(await f.chunk(1,wav(1),true)).json();assert.equal(tail.durationSeconds,1/16000);assert.equal(tail.transcript,'Um, practice helps. Um, practice helps.');
  assert.deepEqual(await(await f.chunk(0)).json(),first);assert.equal(f.calls.filter(c=>c.url?.endsWith('/transcribe-live')).length,2);assert.equal(f.debits,1);
  const changed=wav();changed[44]=1;assert.equal((await f.chunk(0,changed)).status,409);assert.equal((await f.chunk(2)).status,409);
});
test('concurrent duplicate preparation and chunk requests never start duplicate compute',async()=>{
  let release;let begun;const started=new Promise(r=>begun=r),gate=new Promise(r=>release=r);
  const f=fixture({network:async(url,options)=>{if(url.endsWith('/prepare'))return Response.json({ready:true,model:'bark-3.0-plus'});begun();await gate;return Response.json({text:'Hello.',durationSeconds:10,model:'bark-3.0-plus'});}});
  await f.start();await f.prepare();const first=f.chunk(0);await started;assert.equal((await f.chunk(0)).status,409);release();assert.equal((await first).status,200);
  assert.equal(f.calls.filter(c=>c.url?.endsWith('/transcribe-live')).length,1);
});
test('live silence is valid, malformed or oversized sections never reach inference',async()=>{
  const f=fixture({network:async(url,options)=>Response.json(url.endsWith('/prepare')?{ready:true,model:'bark-3.0-plus'}:{text:'',durationSeconds:10,model:'bark-3.0-plus'})});await f.start();await f.prepare();
  assert.equal((await(await f.chunk(0)).json()).text,'');
  for(const [bytes,final] of [[wav(160001),true],[wav(2),false],[Buffer.from('invalid'),true]])assert.notEqual((await f.chunk(1,bytes,final)).status,200);
  assert.equal((await f.chunk(60)).status,400);assert.equal(f.calls.filter(c=>c.url?.endsWith('/transcribe-live')).length,1);
  assert.throws(()=>inspectHostedWav(wav(1).buffer));
});
test('uncertain worker failures close the session and cannot be retried as new work',async()=>{
  const f=fixture({network:async(url)=>{if(url.endsWith('/prepare'))return Response.json({ready:true,model:'bark-3.0-plus'});throw new Error('secret diagnostics');}});await f.start();await f.prepare();
  const response=await f.chunk(0);assert.equal(response.status,502);assert.doesNotMatch(await response.text(),/secret/);assert.equal(f.session.status,'failed');
  assert.equal((await f.chunk(0)).status,409);assert.equal((await f.chunk(1)).status,409);assert.equal(f.calls.filter(c=>c.url?.endsWith('/transcribe-live')).length,1);
});
test('cancelled in-flight responses cannot revive the session and cancellation never refunds admission',async()=>{
  let release,begun;const started=new Promise(r=>begun=r),gate=new Promise(r=>release=r);
  const f=fixture({network:async(url)=>{if(url.endsWith('/prepare'))return Response.json({ready:true,model:'bark-3.0-plus'});begun();await gate;return Response.json({text:'Late text.',durationSeconds:10,model:'bark-3.0-plus'});}});await f.start();await f.prepare();
  const chunk=f.chunk(0);await started;assert.equal((await f.call(`/live-sessions/${id}`,{method:'DELETE'})).status,200);release();assert.equal((await chunk).status,409);
  assert.equal(f.session.status,'cancelled');assert.equal(f.session.transcript,'');assert.equal(f.debits,1);
});
test('finalization checks actual private WAV bytes and preserves cancelled audio for explicit batch fallback',async()=>{
  const f=fixture();await f.start();await f.prepare();await f.chunk(0);
  const path=`/live-sessions/${id}/finish`;assert.equal((await f.call(path,{body:{durationSeconds:10,sizeBytes:44}})).status,400);
  assert.equal((await f.call(path,{body:{durationSeconds:9,sizeBytes:320044}})).status,400);
  const result=await(await f.call(path,{body:{durationSeconds:10,sizeBytes:320044}})).json();assert.equal(result.complete,true);assert.equal(result.recordingId,id);
  const cancelled=fixture();await cancelled.start();await cancelled.call(`/live-sessions/${id}`,{method:'DELETE'});
  const saved=await(await cancelled.call(path,{body:{durationSeconds:10,sizeBytes:320044}})).json();assert.equal(saved.complete,false);assert.equal(saved.text,'');assert.equal(cancelled.debits,1);
});
