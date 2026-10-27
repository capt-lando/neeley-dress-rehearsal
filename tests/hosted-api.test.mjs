import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHostedApi, inspectHostedWav, validateEvents, fail, readLimited } from '../supabase/functions/rehearsal-api/api.mjs';
import { createSupabaseStore } from '../supabase/functions/rehearsal-api/store.mjs';

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
  const jobs=new Map(),calls=[],cancelled=new Set(); let debits=0;
  const store={
    async admitRequest(id) { calls.push(['admit',id]); },
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
      if(cancelled.has(request))throw Object.assign(fail('Cancelled.',409),{jobState:'cancelled'});
      calls.push(['reserve',id,key,kind,cost]);const prior=jobs.get(request);
      if(prior){if(prior.hash!==hash||prior.recording!==key||prior.kind!==kind)throw fail('Request conflict.',409);return {state:prior.state,response:prior.response};}
      if([...jobs.values()].some(j=>j.state==='reserved'))throw fail('Another request is processing.',409);
      debits++;jobs.set(request,{hash,recording:key,user:id,kind,state:'reserved'});return {state:'new'};
    },
    async finish(id,request,ok,response) {const job=jobs.get(request);if(job.state==='reserved')Object.assign(job,{state:ok?'completed':'failed',response});},
    async completeRequest(id,request,response) {
      const job=jobs.get(request);
      if(job?.state==='cancelled')throw Object.assign(fail('Cancelled.',409),{jobState:'cancelled'});
      if(job)Object.assign(rows.get(job.recording),job.kind==='coach'?{status:'analyzed',transcript:response.transcript,report:response}:{status:'transcribed',transcript:response.text,duration_seconds:response.durationSeconds,report:null});
      await store.finish(id,request,true,response);return response;
    },
    async cancelRequest(id,key,request) {
      const job=jobs.get(request),row=rows.get(key);
      if(row?.user_id!==id)throw fail('Not found.',404);
      if(job&&(job.user!==id||job.recording!==key))throw fail('Not found.',404);
      if(!job){cancelled.add(request);return {state:'cancelled',kind:null};}
      if(job.state==='reserved')job.state='cancelled';
      return {state:job.state,kind:job.kind};
    },
    async requestStatus(id,request) {
      calls.push(['requestStatus',id,request]);
      const job=jobs.get(request),row=rows.get(job?.recording);
      if(!job&&overrides.store?.reserve)return {state:'reserved'};
      if (!job || job.user!==id || row?.user_id!==id || row.status==='deleting') throw fail('This recording was not found.',404);
      return {recording_id:job.recording,kind:job.kind,state:job.state,created_at:'2026-10-26T00:00:00Z',finished_at:job.state==='reserved'?null:'2026-10-26T00:01:00Z',response:job.response};
    },
    async events(id,events) {calls.push(['events',id,events]);return events.length;},
    ...overrides.store,
  };
  const app=createHostedApi({store,env:{...env,...overrides.env},policyText,
    fetchImpl:async(url,options)=>{calls.push(['fetch',url,options]);return Response.json(url.endsWith('/cancel')?{cancelled:true}:{text:'Um, we should expand tutoring.',durationSeconds:1,model:'bark-3.0-plus',chunks:[]});},
    coach:async options=>{calls.push(['coach',options]);return {thesis:{summary:'Expand tutoring.',clarity:'An explicit claim.',evidence:['We should expand tutoring.']}};},...overrides,store,env:{...env,...overrides.env}});
  async function call(path,{method='GET',body,auth=token(),headers={}}={}) {
    return app(new Request('https://project.supabase.co/functions/v1/rehearsal-api'+path,{method,headers:{Origin:origin,...(auth?{Authorization:`Bearer ${auth}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)}));
  }
  return {call,rows,calls,jobs,get debits(){return debits;}};
}
const transcribe={method:'POST',body:{recordingId:recording,requestId}};
const analyze={method:'POST',body:{recordingId:recording,requestId,text:'We should expand tutoring.',targetTalkingPoints:'Expand tutoring',durationSeconds:600}};
const streamHeaders={Accept:'application/x-ndjson'};
const frames=async response=>(await response.text()).trim().split('\n').map(line=>JSON.parse(line));

test('refresh polling recovers a disconnected batch request without a second paid admission',async()=>{
  for (const kind of ['transcribe','coach']) {
    let release;const wait=new Promise(resolve=>{release=resolve;});
    const f=fixture(kind==='transcribe'
      ? {fetchImpl:async()=>{await wait;return Response.json({text:'Recovered transcript.',durationSeconds:1,model:'bark-3.0-plus'});}}
      : {coach:async()=>{await wait;return {thesis:{summary:'Tutoring.',clarity:'Clear.',evidence:['We should expand tutoring.']}};}});
    const response=await f.call(kind==='transcribe'?'/transcribe':'/analyze-text',{...(kind==='transcribe'?transcribe:analyze),headers:streamHeaders});
    assert.equal(response.status,200);await response.body.cancel();
    const pending=await (await f.call('/requests/'+requestId)).json();
    assert.deepEqual(pending,{requestId,recordingId:recording,kind,state:'reserved',createdAt:'2026-10-26T00:00:00Z',finishedAt:null,result:null});
    release();await new Promise(setImmediate);
    const finished=await (await f.call('/requests/'+requestId)).json();
    assert.equal(finished.state,'completed');assert.deepEqual(finished.result,JSON.parse(JSON.stringify(f.jobs.get(requestId).response)));
    assert.equal(f.debits,1);assert.equal(f.calls.filter(call=>call[0]==='reserve').length,1);
    assert.equal(f.calls.filter(call=>call[0]==='requestStatus').length,3);
    assert.doesNotMatch(JSON.stringify(finished),/private-worker|private-coach|input_hash|reserved_microusd/);
  }
});

test('request recovery enforces sign-in, exact owner, valid IDs and deletion visibility',async()=>{
  const f=fixture();await f.call('/transcribe',transcribe);
  assert.equal((await f.call('/requests/'+requestId,{auth:null})).status,401);
  assert.equal((await f.call('/requests/not-an-id')).status,400);
  assert.equal((await f.call('/requests/'+other)).status,404);
  assert.equal((await f.call('/requests/'+requestId+'?user='+user)).status,400);
  f.jobs.get(requestId).user=other;
  assert.equal((await f.call('/requests/'+requestId)).status,404);
  f.jobs.get(requestId).user=user;f.rows.get(recording).status='deleting';
  assert.equal((await f.call('/requests/'+requestId)).status,404);
  assert.equal(f.debits,1);
});

test('explicit cancellation aborts running speech and coaching and preserves the saved take',async()=>{
  for(const kind of ['transcribe','coach']) {
    let begun,aborted=false,requests=0;const started=new Promise(resolve=>{begun=resolve;});
    const waitForAbort=signal=>new Promise((_resolve,reject)=>{
      requests++;begun();signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
    });
    const f=fixture({cancellationPollMs:5,
      fetchImpl:async(url,options)=>{
        if(url.endsWith('/cancel')){assert.deepEqual(JSON.parse(options.body),{requestId:`${user}:${requestId}`});return Response.json({cancelled:true});}
        assert.equal(options.headers['X-Rehearsal-Request'],`${user}:${requestId}`);return waitForAbort(options.signal);
      },coach:async options=>waitForAbort(options.signal)});
    const before=JSON.stringify(f.rows.get(recording));
    const response=await f.call(kind==='transcribe'?'/transcribe':'/analyze-text',{...(kind==='transcribe'?transcribe:analyze),headers:streamHeaders});
    await started;
    const cancelled=await f.call(`/requests/${requestId}/cancel`,{method:'POST',body:{recordingId:recording}});
    assert.deepEqual(await cancelled.json(),{requestId,recordingId:recording,cancelled:true,state:'cancelled'});
    const events=await frames(response);assert.equal(events.at(-1).jobState,'cancelled');
    assert.equal(aborted,true);assert.equal(requests,1);assert.equal(f.jobs.get(requestId).state,'cancelled');
    assert.equal(JSON.stringify(f.rows.get(recording)),before);assert.equal(f.debits,1);
    assert.equal(events.some(event=>event.stage==='saved'),false);
  }
});

test('late provider output cannot overwrite saved content even before cancellation polling runs',async()=>{
  let begun,release;const started=new Promise(resolve=>{begun=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const f=fixture({coach:async()=>{begun();await waiting;return {thesis:{summary:'Late feedback.',clarity:'Clear.',evidence:['We should expand tutoring.']}};}});
  const before=JSON.stringify(f.rows.get(recording)),response=await f.call('/analyze-text',{...analyze,headers:streamHeaders});await started;
  await f.call(`/requests/${requestId}/cancel`,{method:'POST',body:{recordingId:recording}});release();
  assert.equal((await frames(response)).at(-1).jobState,'cancelled');
  assert.equal(JSON.stringify(f.rows.get(recording)),before);assert.equal(f.jobs.get(requestId).state,'cancelled');
});

test('cancel before admission prevents paid work and cancellation cannot spoof another owner',async()=>{
  const f=fixture(),path=`/requests/${requestId}/cancel`,options={method:'POST',body:{recordingId:recording}};
  assert.equal((await f.call(path,{...options,auth:null})).status,401);
  assert.equal((await f.call(path,{...options,body:{...options.body,userId:other}})).status,400);
  assert.equal((await f.call(path,{...options,body:{recordingId:other}})).status,404);
  assert.equal((await f.call(path,options)).status,200);
  const response=await f.call('/transcribe',transcribe);
  assert.equal(response.status,409);assert.equal((await response.json()).jobState,'cancelled');assert.equal(f.debits,0);
  assert.equal(f.calls.some(call=>call[0]==='fetch'&&!call[1].endsWith('/cancel')),false);
});

test('cancelling an already completed request retains its exact result and saved recording',async()=>{
  const f=fixture();const result=await(await f.call('/analyze-text',analyze)).json(),before=JSON.stringify(f.rows.get(recording));
  const cancelled=await(await f.call(`/requests/${requestId}/cancel`,{method:'POST',body:{recordingId:recording}})).json();
  assert.equal(cancelled.state,'completed');assert.equal(JSON.stringify(f.rows.get(recording)),before);
  assert.deepEqual((await(await f.call('/requests/'+requestId)).json()).result,result);assert.equal(f.debits,1);
});

test('unconfirmed speech cancellation is retryable without reviving or recharging the request',async()=>{
  let attempts=0;const f=fixture({fetchImpl:async(url)=>{assert.ok(url.endsWith('/cancel'));return ++attempts===1?Response.json({error:'private failure'},{status:503}):Response.json({cancelled:true});}});
  const path=`/requests/${requestId}/cancel`,options={method:'POST',body:{recordingId:recording}};
  const first=await f.call(path,options);assert.equal(first.status,503);assert.match((await first.json()).error,/not confirmed stopping/);
  assert.equal((await f.call('/transcribe',transcribe)).status,409);assert.equal(f.debits,0);
  assert.equal((await f.call(path,options)).status,200);assert.equal(attempts,2);assert.equal(f.debits,0);
});

test('failed and expired recovery expose no stale result or private job fields',async()=>{
  for (const state of ['reserved','failed','expired']) {
    const f=fixture({store:{requestStatus:async(id,key)=>{
      assert.equal(id,user);assert.equal(key,requestId);
      return {recording_id:recording,kind:'coach',state,created_at:'created',finished_at:null,response:{private:'incomplete'},input_hash:'private-hash',reserved_microusd:500000,user_id:other};
    }}});
    const response=await f.call('/requests/'+requestId);assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{requestId,recordingId:recording,kind:'coach',state,createdAt:'created',finishedAt:null,result:null});
    assert.equal(f.debits,0);assert.equal(f.calls.some(call=>['reserve','fetch','coach'].includes(call[0])),false);
  }
});

test('progress streams report real checkpoints and cached retries invoke no extra model calls',async()=>{
  for(const [path,options,expected] of [
    ['/transcribe',transcribe,['accepted','audio_validated','speech_requested','transcript_received','saved']],
    ['/analyze-text',analyze,['accepted','coach_requested','feedback_received','feedback_validated','saved']],
  ]) {
    const f=fixture(),response=await f.call(path,{...options,headers:streamHeaders});
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/x-ndjson');
    const events=await frames(response);
    assert.deepEqual(events.slice(0,-1).map(event=>event.stage),expected);
    assert.ok(events.slice(0,-1).every(event=>Object.keys(event).sort().join(',')==='stage,type'));
    assert.equal(events.at(-1).type,'result');assert.equal(f.jobs.get(requestId).state,'completed');
    const replay=await frames(await f.call(path,{...options,headers:streamHeaders}));
    assert.deepEqual(replay,[{type:'progress',stage:'cached_result'},events.at(-1)]);
    assert.equal(f.debits,1);assert.equal(f.calls.filter(call=>call[0]===(path==='/transcribe'?'fetch':'coach')).length,1);
    assert.doesNotMatch(JSON.stringify(events),/private-worker|private-coach|Bearer|Modal-Secret/);
  }
});

test('stream opt-in preserves early authentication, ownership, validation and quota HTTP errors',async()=>{
  for(const [overrides,options,status] of [
    [{},{...analyze,auth:null},401],
    [{store:{owned:async()=>null}},analyze,404],
    [{},{...analyze,body:{...analyze.body,text:'!!!'}},400],
    [{store:{reserve:async()=>{throw fail('Daily limit.',429);}}},analyze,429],
  ]) {
    const f=fixture(overrides),response=await f.call('/analyze-text',{...options,headers:streamHeaders});
    assert.equal(response.status,status);assert.equal(response.headers.get('content-type'),'application/json');
    assert.equal(f.calls.some(call=>call[0]==='coach'),false);
  }
});

test('provider receipt and saved milestones wait for the actual provider and commit acknowledgements',async()=>{
  let completeCoach,completeSave;
  const coachWait=new Promise(resolve=>{completeCoach=resolve;}),saveWait=new Promise(resolve=>{completeSave=resolve;});
  const f=fixture({coach:async()=>{await coachWait;return {thesis:{summary:'Tutoring.',clarity:'Clear.',evidence:['We should expand tutoring.']}};},
    store:{finish:async()=>{await saveWait;}}});
  const response=await f.call('/analyze-text',{...analyze,headers:streamHeaders}),reader=response.body.getReader();
  const next=async()=>JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.equal((await next()).stage,'accepted');assert.equal((await next()).stage,'coach_requested');
  let arrived=false;const receipt=next().then(event=>{arrived=true;return event;});
  await new Promise(setImmediate);assert.equal(arrived,false);
  completeCoach();assert.equal((await receipt).stage,'feedback_received');assert.equal((await next()).stage,'feedback_validated');
  let saved=false;const committed=next().then(event=>{saved=true;return event;});
  await new Promise(setImmediate);assert.equal(saved,false);
  completeSave();assert.equal((await committed).stage,'saved');assert.equal((await next()).type,'result');
  assert.equal((await reader.read()).done,true);reader.releaseLock();
});

test('streamed provider failures are terminal, safe, and never claim receipt or saving',async()=>{
  for(const [path,options,overrides,stage] of [
    ['/analyze-text',analyze,{coach:async()=>{throw new Error('secret-provider-body');}},'coach_requested'],
    ['/transcribe',transcribe,{fetchImpl:async()=>new Response('private-provider-body',{status:502})},'speech_requested'],
  ]) {
    const f=fixture(overrides),events=await frames(await f.call(path,{...options,headers:streamHeaders}));
    assert.equal(events.at(-2).stage,stage);assert.equal(events.at(-1).type,'error');
    assert.equal(events.at(-1).status,502);assert.equal(events.at(-1).jobState,'failed');
    assert.equal(f.jobs.get(requestId).state,'failed');
    assert.doesNotMatch(JSON.stringify(events),/secret-provider|private-provider/);
    assert.equal(events.some(event=>['saved','feedback_received','transcript_received'].includes(event.stage)),false);
  }
});

test('streaming retains request and audio concurrency guards through disconnected admitted work',async()=>{
  for(const [path,options,limit] of [['/analyze-text',analyze,8],['/transcribe',transcribe,2]]) {
    let releaseWork;const wait=new Promise(resolve=>{releaseWork=resolve;});let completed=0;
    const f=fixture({store:{reserve:async()=>({state:'new'}),finish:async()=>{completed++;}},
      coach:async()=>{await wait;return {thesis:{summary:'Tutoring.',clarity:'Clear.',evidence:['We should expand tutoring.']}};},
      fetchImpl:async()=>{await wait;return Response.json({text:'Tutoring.',durationSeconds:1,model:'bark-3.0-plus'});}});
    const streams=[];
    for(let index=0;index<limit;index++) {
      const response=await f.call(path,{...options,headers:streamHeaders});assert.equal(response.status,200);
      streams.push(response);await response.body.cancel();
    }
    assert.equal((await f.call(path,{...options,headers:streamHeaders})).status,429);
    releaseWork();await new Promise(setImmediate);
    assert.equal(completed,limit);
    const after=await f.call(path,{...options,headers:streamHeaders});assert.equal(after.status,200);await after.text();
  }
});

test('all app routes enforce distributed admission before data access or paid calls',async()=>{
  const paths=[['/config','GET'],['/requests/'+requestId,'GET'],['/recordings','GET'],['/recordings','POST'],['/recordings/'+recording,'GET'],['/recordings/'+recording,'DELETE'],['/events','POST'],['/transcribe','POST'],['/analyze-text','POST'],['/live-sessions','POST'],['/live-sessions/'+recording,'GET'],['/live-sessions/'+recording,'DELETE'],['/live-sessions/'+recording+'/prepare','POST'],['/live-sessions/'+recording+'/chunks/0','POST'],['/live-sessions/'+recording+'/finish','POST']];
  for(const stage of ['global','user'])for(const [path,method] of paths) {
    const admissions=[];
    const f=fixture({store:{admitRequest:async id=>{admissions.push(id);if(stage==='global'||id)throw Object.assign(fail('Too many requests.',429),{retryAfter:60});}}});
    const response=await f.call(path,{method,body:method==='POST'?{}:undefined});
    assert.equal(response.status,429,path);assert.equal(response.headers.get('retry-after'),'60');
    assert.equal(f.debits,0);assert.equal(f.calls.some(c=>['profile','list','owned','fetch','coach','events'].includes(c[0])),false);
    assert.equal(admissions.length,stage==='global'?1:2);
    if(stage==='global')assert.equal(f.calls.some(c=>c[0]==='verify'),false);
  }
});

test('a global refusal is cached before SQL and failure of admission fails closed',async()=>{
  let checks=0;
  const f=fixture({now:()=>1000,store:{admitRequest:async()=>{checks++;throw Object.assign(fail('Too many requests.',429),{retryAfter:60});}}});
  for(let i=0;i<2000;i++)assert.equal((await f.call('/analyze-text',analyze)).status,429);
  assert.equal(checks,1);assert.equal(f.debits,0);assert.equal(f.calls.length,0);
  const unavailable=fixture({store:{admitRequest:async()=>{throw new Error('private database detail');}}});
  const response=await unavailable.call('/analyze-text',analyze);
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private database/);assert.equal(unavailable.debits,0);
});

test('two thousand repeated analysis submissions cannot trigger repeat paid work',async()=>{
  const f=fixture({now:()=>1000});
  for(let i=0;i<2000;i++)assert.ok([200,429].includes((await f.call('/analyze-text',analyze)).status));
  assert.equal(f.debits,1);assert.equal(f.calls.filter(c=>c[0]==='coach').length,1);
});

test('body reads cancel stalled streams without waiting for their cancellation',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({cancel(){cancelled=true;return new Promise(()=>{});}});
  await assert.rejects(readLimited(new Response(stream),100,20),error=>error.safe&&error.status===408);
  assert.equal(cancelled,true);assert.equal(stream.locked,false);
});

test('body deadline covers the complete upload even when bytes keep arriving',async()=>{
  let controller,cancelled=false;
  const stream=new ReadableStream({start(value){controller=value;},cancel(){cancelled=true;}});
  const interval=setInterval(()=>controller.enqueue(new Uint8Array([1])),5);
  try { await assert.rejects(readLimited(new Response(stream),1000,30),error=>error.status===408); }
  finally { clearInterval(interval); }
  assert.equal(cancelled,true);
});

test('body limits cancel declared or streamed overflow and preserve valid bytes',async()=>{
  for(const declared of [true,false]) {
    let cancelled=false;
    const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(4));},cancel(){cancelled=true;}}),{headers:declared?{'content-length':'4'}:{}});
    await assert.rejects(readLimited(response,3),error=>error.status===413);
    assert.equal(cancelled,true);
  }
  assert.deepEqual(await readLimited(new Response(new Uint8Array([1,2,3])),3),new Uint8Array([1,2,3]));
});

test('packaged server prompt exactly matches the canonical coaching prompt',async()=>{
  const packaged=JSON.parse(await readFile(new URL('../supabase/functions/_shared/coaching-policy.json',import.meta.url),'utf8'));
  assert.equal(packaged.text,policyText);
});
test('public config has no user content, credentials, or administrative authority',async()=>{
  const f=fixture(),response=await f.call('/config',{auth:null}),config=await response.json();
  assert.equal(response.status,200);assert.equal(config.hosted,true);assert.deepEqual(config.auth,{signedIn:false});assert.equal(config.liveTranscription,false);
  assert.deepEqual(f.calls,[['admit',undefined]]);assert.doesNotMatch(JSON.stringify(config),/private-|admin|storage_path|service_role/);
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

test('known pre-admission refusals clear recovery state while uncertain failures retain it',async()=>{
  for(const message of ['request_busy','daily_limit','budget_exhausted']) {
    const backing=createSupabaseStore({async rpc(){return {error:{message}};}}),f=fixture({store:{reserve:backing.reserve}});
    const response=await f.call('/transcribe',transcribe);
    assert.ok([409,429].includes(response.status));assert.equal((await response.json()).jobState,'not_started');
    assert.equal(f.jobs.size,0);assert.equal(f.debits,0);assert.equal(f.calls.some(call=>call[0]==='fetch'),false);
  }
  for(const options of [
    {...transcribe,body:{...transcribe.body,unsupported:true}},
    {...analyze,body:{...analyze.body,text:'!!!'}},
  ]) {
    const f=fixture(),response=await f.call(options.body.text?'/analyze-text':'/transcribe',options);
    assert.equal(response.status,400);assert.equal((await response.json()).jobState,'not_started');assert.equal(f.debits,0);
  }
  const uncertain=fixture({store:{reserve:async()=>{throw new Error('Admission reply lost');}}});
  const response=await uncertain.call('/transcribe',transcribe);
  assert.equal(response.status,503);assert.equal((await response.json()).jobState,undefined);
});
test('concurrent duplicate requests cannot trigger a second upstream operation',async()=>{
  let release;const wait=new Promise(r=>{release=r;});let started;
  const begin=new Promise(r=>{started=r;});const f=fixture({fetchImpl:async()=>{started();await wait;return Response.json({text:'Hello there.',durationSeconds:1,model:'bark-3.0-plus'});}});
  const first=f.call('/transcribe',transcribe);await begin;const retry=await f.call('/transcribe',transcribe);assert.equal(retry.status,409);assert.equal((await retry.json()).jobState,undefined);release();assert.equal((await first).status,200);assert.equal(f.debits,1);
});
test('coaching uses saved duration, retains all preparation inputs, and returns the existing report schema',async()=>{
  const f=fixture();const body={...analyze.body,targetScript:'Support tutoring.',plannedIntroduction:'Hello students.',plannedTransitions:'Next, costs.',instructorRubric:'Explain the claim.',rubricFileName:'Rubric.docx'};
  const response=await f.call('/analyze-text',{method:'POST',body}),report=await response.json();assert.equal(response.status,200);assert.equal(report.analysis.method,'ai');assert.equal(report.meta.durationSeconds,1);assert.equal(report.meta.localSpeech,false);assert.equal(f.rows.get(recording).report.transcript,body.text);
  const options=f.calls.find(c=>c[0]==='coach')[1];assert.equal(options.apiKey,'private-coach-key');assert.equal(options.browser,false);for(const value of ['Support tutoring.','Hello students.','Next, costs.','Explain the claim.'])assert.ok(options.prompt.includes(value));
  assert.equal((await f.call('/analyze-text',{method:'POST',body:{...body,text:'A changed speech.'}})).status,409);assert.equal(f.debits,1);
});
test('conversation guides analysis transiently but is absent from saved reports and recovery responses',async()=>{
  const f=fixture();const rehearsalContext='Student: My audience is the campus investment committee. Assistant: Try a short opening story.';
  const body={...analyze.body,rehearsalContext};
  const response=await f.call('/analyze-text',{method:'POST',body}),report=await response.json();
  assert.equal(response.status,200);
  assert.ok(f.calls.find(c=>c[0]==='coach')[1].prompt.includes(rehearsalContext));
  assert.equal(report.meta.rehearsalContext,undefined);
  assert.doesNotMatch(JSON.stringify(report),/rehearsalContext|campus investment committee|short opening story/);
  assert.doesNotMatch(JSON.stringify(f.rows.get(recording).report),/rehearsalContext|campus investment committee|short opening story/);
  const retry=await f.call('/analyze-text',{method:'POST',body});assert.equal(retry.status,200);
  assert.doesNotMatch(await retry.text(),/rehearsalContext|campus investment committee|short opening story/);
  assert.equal(f.calls.filter(c=>c[0]==='coach').length,1);assert.equal(f.debits,1);
});
test('coaching persists partial results honestly and never retries or fabricates missing criteria',async()=>{
  const text=analyze.body.text;
  for(const audience of ['valid','missing','unverifiable']) {
    let calls=0;
    const rubric=['claim','evidence','structure','audience','conclusion']
      .filter(criterion=>audience!=='missing'||criterion!=='audience')
      .map(criterion=>({criterion,score:0,reason:'A supported assessment.',
        evidence:[criterion==='audience'&&audience==='unverifiable'?'Words never spoken.':text]}));
    const f=fixture({coach:async()=>{calls++;return {rubric,annotations:[{category:'thesis',quote:text,comment:'Your proposal.'}]};}});
    const response=await f.call('/analyze-text',analyze),report=await response.json();
    assert.equal(response.status,200);assert.equal(calls,1);assert.equal(f.debits,1);
    assert.equal(report.analysis.method,'ai');assert.equal(report.analysis.annotations.length,1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.rows.get(recording).report)),report);
    assert.deepEqual(await(await f.call('/analyze-text',analyze)).json(),report);
    assert.equal(calls,1);assert.equal(f.debits,1);
    if(audience==='valid') {
      assert.equal(report.meta.coachingStatus,'complete');assert.deepEqual(report.meta.missingCoachingCriteria,[]);
      assert.deepEqual(report.warnings,[]);assert.equal(report.analysis.overallRating,0);
    } else {
      assert.equal(report.meta.coachingStatus,'partial');assert.deepEqual(report.meta.missingCoachingCriteria,['audience']);
      assert.match(report.warnings[0],/missing for: audience/);assert.equal(report.analysis.overallRating,null);
      assert.equal(report.analysis.rubric.find(item=>item.criterion==='audience').score,null);
    }
  }
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
