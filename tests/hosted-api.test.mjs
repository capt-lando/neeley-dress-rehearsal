import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHostedApi, inspectHostedWav, validateEvents, fail } from '../supabase/functions/rehearsal-api/api.mjs';

const policyText=await readFile(new URL('../lib/coaching-prompt.md',import.meta.url),'utf8');
const user='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const recording='33333333-3333-4333-8333-333333333333', requestId='44444444-4444-4444-8444-444444444444';
const origin='https://capt-lando.github.io';
function token({sub=user,method='oauth',aal='aal1'}={}) { return 'header.'+Buffer.from(JSON.stringify({sub,amr:[{method}],aal})).toString('base64url')+'.signature'; }
const env={ALLOWED_ORIGINS:origin,BARK_WORKER_URL:'https://speech.example/transcribe',BARK_WORKER_ALLOWED_HOSTS:'speech.example',BARK_WORKER_TOKEN:'private-worker-token',BARK_RESERVE_MICROUSD:'250000',COACHING_PROVIDER:'google',COACHING_API_KEY:'private-coach-key',COACHING_RESERVE_MICROUSD:'500000'};
function wav(seconds=1) {
  const bytes=Buffer.alloc(44+seconds*32000); bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40);
  return bytes;
}
function fixture(overrides={}) {
  const rows=new Map([[recording,{id:recording,user_id:user,title:'Practice',created_at:'2026-10-26T00:00:00Z',duration_seconds:1,size_bytes:wav().length,storage_path:`${user}/${recording}/audio.wav`,status:'transcribed',transcript:'We should expand tutoring.'}]]);
  const jobs=new Map(),calls=[]; let debits=0;
  const store={
    async verifyUser(value) { calls.push(['verify',value]); return value==='invalid'?null:{id:user,identities:[{provider:'google'}]}; },
    async profile(id) { calls.push(['profile',id]);return {user_id:id}; },
    async list(id) { calls.push(['list',id]);return [...rows.values()].filter(row=>row.user_id===id); },
    async owned(id,key) {calls.push(['owned',id,key]);const row=rows.get(key);return row?.user_id===id?row:null;},
    async create(id,key,title,duration,size) { const row={id:key,user_id:id,title,duration_seconds:duration,size_bytes:size,storage_path:`${id}/${key}/audio.wav`};rows.set(key,row);return row; },
    async audio(path) {calls.push(['audio',path]);return new Blob([wav()]);},
    async update(id,key,patch) {assert.equal(id,user);Object.assign(rows.get(key),patch);},
    async signAudio(path,seconds) { calls.push(['sign',path,seconds]);return 'https://project.supabase.co/storage/v1/object/sign/recordings/private?token=test'; },
    async remove(id,key) {assert.equal(id,user);rows.delete(key);},
    async reserve(id,key,request,kind,hash,cost) {
      calls.push(['reserve',id,key,kind,cost]);const prior=jobs.get(request);
      if(prior){if(prior.hash!==hash||prior.recording!==key||prior.kind!==kind)throw fail('Request conflict.',409);return {state:prior.state,response:prior.response};}
      if([...jobs.values()].some(j=>j.state==='reserved'))throw fail('Another request is processing.',409);
      debits++;jobs.set(request,{hash,recording:key,kind,state:'reserved'});return {state:'new'};
    },
    async finish(id,request,ok,response) {const job=jobs.get(request);Object.assign(job,{state:ok?'completed':'failed',response});},
    async events(id,events) {calls.push(['events',id,events]);return events.length;},
    ...overrides.store,
  };
  const app=createHostedApi({store,env:{...env,...overrides.env},policyText,
    fetchImpl:async(url,options)=>{calls.push(['fetch',url,options]);return Response.json({text:'Um, we should expand tutoring.',durationSeconds:1,model:'bark-3.0-plus',chunks:[]});},
    coach:async options=>{calls.push(['coach',options]);return {thesis:{summary:'Expand tutoring.',clarity:'An explicit claim.',evidence:['We should expand tutoring.']}};},...overrides,store,env:{...env,...overrides.env}});
  async function call(path,{method='GET',body,auth=token(),headers={}}={}) {
    return app(new Request('https://project.supabase.co/functions/v1/rehearsal-api'+path,{method,headers:{Origin:origin,...(auth?{Authorization:`Bearer ${auth}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)}));
  }
  return {call,rows,calls,jobs,get debits(){return debits;}};
}
const transcribe={method:'POST',body:{recordingId:recording,requestId}};
const analyze={method:'POST',body:{recordingId:recording,requestId,text:'We should expand tutoring.',targetTalkingPoints:'Expand tutoring',durationSeconds:600}};

test('packaged server prompt exactly matches the canonical coaching prompt',async()=>{
  const packaged=JSON.parse(await readFile(new URL('../supabase/functions/_shared/coaching-policy.json',import.meta.url),'utf8'));
  assert.equal(packaged.text,policyText);
});
test('public config has no user content, credentials, or administrative authority',async()=>{
  const f=fixture(),response=await f.call('/config',{auth:null}),config=await response.json();
  assert.equal(response.status,200);assert.equal(config.hosted,true);assert.deepEqual(config.auth,{signedIn:false});assert.equal(config.liveTranscription,false);
  assert.deepEqual(f.calls,[]);assert.doesNotMatch(JSON.stringify(config),/private-|admin|storage_path|service_role/);
});
test('CORS rejects foreign and missing origins before authentication or data access',async()=>{
  const f=fixture();for(const value of ['https://evil.example','null',''])assert.equal((await f.call('/recordings',{headers:{Origin:value}})).status,403);
  const preflight=await f.call('/recordings',{method:'OPTIONS',auth:null});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);assert.equal(f.calls.length,0);
});
test('private actions require verified Google/Microsoft OAuth; user-submitted identity is ignored',async()=>{
  for(const auth of [null,'invalid',token({method:'password'}),token({sub:other})]){
    const f=fixture();const response=await f.call('/recordings',{auth});assert.ok([401,403].includes(response.status));assert.equal(f.calls.some(c=>c[0]==='list'),false);
  }
  const f=fixture({store:{verifyUser:async()=>({id:user,identities:[{provider:'email'}]})}});assert.equal((await f.call('/recordings')).status,403);
  const microsoft=fixture({store:{verifyUser:async()=>({id:user,identities:[{provider:'azure'}]})}});assert.equal((await microsoft.call('/recordings')).status,200);
  const linkedEmail=fixture({store:{verifyUser:async()=>({id:user,app_metadata:{provider:'email'},identities:[{provider:'email'},{provider:'google'}]})}});assert.equal((await linkedEmail.call('/recordings')).status,200);assert.equal((await linkedEmail.call('/recordings',{auth:token({method:'password'})})).status,403);
  const unsupportedOAuth=fixture({store:{verifyUser:async()=>({id:user,identities:[{provider:'google'},{provider:'github'}]})}});assert.equal((await unsupportedOAuth.call('/recordings')).status,403);
});
test('recording history and signed audio are scoped to the verified owner',async()=>{
  const f=fixture();f.rows.set(other,{id:other,user_id:other,title:'Private other-user data'});
  const listed=await(await f.call('/recordings')).json();assert.equal(listed.recordings.length,1);assert.equal(listed.recordings[0].id,recording);assert.equal(listed.recordings[0].transcript,undefined);
  for(const method of ['GET','DELETE'])assert.equal((await f.call('/recordings/'+other,{method})).status,404);
  assert.equal((await f.call('/transcribe',{method:'POST',body:{recordingId:other,requestId}})).status,404);assert.equal(f.debits,0);
  const detail=await(await f.call('/recordings/'+recording)).json();assert.equal(detail.recording.id,recording);assert.ok(detail.audioUrl);assert.deepEqual(f.calls.find(c=>c[0]==='sign').slice(1),[`${user}/${recording}/audio.wav`,60]);
});
test('client cannot select provider keys, models, paths, or arbitrary metadata fields',async()=>{
  const f=fixture();for(const body of [{...transcribe.body,userId:other},{...transcribe.body,model:'expensive-model'},{...transcribe.body,url:'http://localhost'}])assert.equal((await f.call('/transcribe',{method:'POST',body})).status,400);
  assert.equal((await f.call('/recordings',{method:'POST',body:{id:other,title:'Hi',durationSeconds:1,sizeBytes:32044,userId:other}})).status,400);
  assert.equal((await f.call('/analyze-text',{method:'POST',body:{...analyze.body,apiKey:'private-client-key'}})).status,400);
  assert.equal(f.debits,0);
});
test('transcription reserves before upstream, sends only server credentials, and persists validated output',async()=>{
  const f=fixture({env:{BARK_WORKER_MODAL_KEY:'modal-private',BARK_WORKER_MODAL_SECRET:'modal-secret'}});
  const response=await f.call('/transcribe',transcribe),result=await response.json();assert.equal(response.status,200);assert.equal(result.text,'Um, we should expand tutoring.');assert.equal(f.rows.get(recording).status,'transcribed');
  const network=f.calls.find(c=>c[0]==='fetch');assert.equal(network[1],env.BARK_WORKER_URL);assert.equal(network[2].redirect,'error');assert.equal(network[2].headers.Authorization,'Bearer private-worker-token');assert.equal(network[2].headers['Modal-Secret'],'modal-secret');
  assert.ok(f.calls.findIndex(c=>c[0]==='reserve')<f.calls.findIndex(c=>c[0]==='fetch'));assert.doesNotMatch(JSON.stringify(result),/private-|modal-secret/);
  assert.deepEqual(await(await f.call('/transcribe',transcribe)).json(),result);assert.equal(f.debits,1);assert.equal(f.calls.filter(c=>c[0]==='fetch').length,1);
});
test('worker destinations and incomplete Modal configuration fail closed',()=>{
  for(const change of [{BARK_WORKER_URL:'http://speech.example/'},{BARK_WORKER_ALLOWED_HOSTS:'other.example'},{BARK_WORKER_URL:'https://speech.example/?token=x'},{BARK_WORKER_MODAL_KEY:'key'}])assert.throws(()=>fixture({env:change}),/configuration|credentials/);
});
test('WAV validation derives duration and rejects forged size, formats, and over-limit audio',async()=>{
  const bytes=wav(),buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);assert.equal(inspectHostedWav(buffer),1);
  const bad=wav();bad.writeUInt32LE(44100,24);assert.throws(()=>inspectHostedWav(bad.buffer.slice(bad.byteOffset,bad.byteOffset+bad.byteLength)));
  const long=wav(601);assert.throws(()=>inspectHostedWav(long.buffer.slice(long.byteOffset,long.byteOffset+long.byteLength)));
  for(const changed of [wav(600.01),Buffer.concat([wav(),Buffer.from('metadata')])])assert.throws(()=>inspectHostedWav(changed.buffer.slice(changed.byteOffset,changed.byteOffset+changed.byteLength)));
  const extraFormat=wav();extraFormat.writeUInt32LE(18,16);assert.throws(()=>inspectHostedWav(extraFormat.buffer.slice(extraFormat.byteOffset,extraFormat.byteOffset+extraFormat.byteLength)));
  const f=fixture();f.rows.get(recording).size_bytes=44;assert.equal((await f.call('/transcribe',transcribe)).status,400);assert.equal(f.calls.some(c=>c[0]==='fetch'),false);
});
test('failed or uncertain upstream requests remain debited and are not silently retried',async()=>{
  let sent=0;const f=fixture({fetchImpl:async()=>{sent++;throw new Error('secret upstream network details');}});
  const response=await f.call('/transcribe',transcribe);assert.equal(response.status,502);assert.doesNotMatch(await response.text(),/secret upstream/);
  assert.equal((await f.call('/transcribe',transcribe)).status,409);assert.equal(f.debits,1);assert.equal(sent,1);assert.equal(f.jobs.get(requestId).state,'failed');
});

test('a busy worker reports a persisted terminal failure and the same ID cannot start new compute',async()=>{
  let sent=0;
  const f=fixture({fetchImpl:async()=>{sent++;return Response.json({error:'busy'}, {status:429});}});
  const first=await f.call('/transcribe',transcribe);
  assert.equal(first.status,429);assert.equal((await first.json()).jobState,'failed');
  const repeated=await f.call('/transcribe',transcribe);
  assert.equal(repeated.status,409);assert.equal((await repeated.json()).jobState,'failed');
  assert.equal(f.jobs.get(requestId).state,'failed');assert.equal(f.debits,1);assert.equal(sent,1);
});

test('admission failures and uncertain persistence never advertise a terminal job state',async()=>{
  for (const change of [
    {store:{reserve:async()=>{throw fail('Daily allowance reached.',429);}}},
    {store:{finish:async()=>{throw new Error('Database unreachable');}},fetchImpl:async()=>Response.json({}, {status:429})},
    {store:{finish:async(_user,_request,ok)=>{if(ok)throw new Error('Completion acknowledgement lost');}}},
  ]) {
    const f=fixture(change),result=await f.call('/transcribe',transcribe);
    assert.notEqual(result.status,200);assert.equal((await result.json()).jobState,undefined);
  }
});
test('concurrent duplicate requests cannot trigger a second upstream operation',async()=>{
  let release;const wait=new Promise(r=>{release=r;});let started;
  const begin=new Promise(r=>{started=r;});const f=fixture({fetchImpl:async()=>{started();await wait;return Response.json({text:'Hello there.',durationSeconds:1,model:'bark-3.0-plus'});}});
  const first=f.call('/transcribe',transcribe);await begin;assert.equal((await f.call('/transcribe',transcribe)).status,409);release();assert.equal((await first).status,200);assert.equal(f.debits,1);
});
test('coaching uses saved duration, retains all preparation inputs, and returns the existing report schema',async()=>{
  const f=fixture();const body={...analyze.body,targetScript:'Support tutoring.',plannedIntroduction:'Hello students.',plannedTransitions:'Next, costs.',instructorRubric:'Explain the claim.',rubricFileName:'Rubric.docx'};
  const response=await f.call('/analyze-text',{method:'POST',body}),report=await response.json();assert.equal(response.status,200);assert.equal(report.analysis.method,'ai');assert.equal(report.meta.durationSeconds,1);assert.equal(report.meta.localSpeech,false);assert.equal(f.rows.get(recording).report.transcript,body.text);
  const options=f.calls.find(c=>c[0]==='coach')[1];assert.equal(options.apiKey,'private-coach-key');assert.equal(options.browser,false);for(const value of ['Support tutoring.','Hello students.','Next, costs.','Explain the claim.'])assert.ok(options.prompt.includes(value));
  assert.equal((await f.call('/analyze-text',{method:'POST',body:{...body,text:'A changed speech.'}})).status,409);assert.equal(f.debits,1);
});
test('invalid or unsupported analysis fails before consuming an AI reservation',async()=>{
  for(const input of [{text:'!!!'},{text:'a'.repeat(60001)},{targetScript:'a'.repeat(30001)},{useAI:false}]){const f=fixture();assert.equal((await f.call('/analyze-text',{method:'POST',body:{...analyze.body,...input}})).status,400);assert.equal(f.debits,0);}
  const missing=fixture();missing.rows.get(recording).transcript=null;assert.equal((await missing.call('/analyze-text',analyze)).status,409);assert.equal(missing.debits,0);
});
test('usage events reject free text, timestamps, identifiers, nonfinite time, and oversized batches',async()=>{
  const event={id:requestId,sessionId:recording,name:'section_engaged',section:'prepare',activeSeconds:20};
  assert.deepEqual(validateEvents({events:[event]}),[event]);
  for(const extra of [{transcript:'secret speech'},{occurredAt:'2020-01-01'},{email:'person@example.com'},{activeSeconds:61},{activeSeconds:NaN}])assert.throws(()=>validateEvents({events:[{...event,...extra}]}));
  assert.throws(()=>validateEvents({events:Array(21).fill(event)}));
  const f=fixture();assert.deepEqual(await(await f.call('/events',{method:'POST',body:{events:[event]}})).json(),{accepted:1});assert.equal(f.calls.find(c=>c[0]==='events')[1],user);
});
test('the free pilot exposes no dashboard or paid-plan endpoints',async()=>{
  const f=fixture();for(const path of ['/admin/summary','/billing','/plans'])assert.equal((await f.call(path)).status,404);
  const config=await(await f.call('/config')).json();assert.deepEqual(config.auth,{signedIn:true});
});
test('backend and database failures never return secrets, transcripts, or raw diagnostics',async()=>{
  const f=fixture({store:{list:async()=>{throw new Error('sk-secret transcript personal speech');}}});const response=await f.call('/recordings');assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');assert.doesNotMatch(await response.text(),/sk-secret|personal|transcript/);
});
