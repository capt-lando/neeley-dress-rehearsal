import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseStore } from '../supabase/functions/rehearsal-api/store.mjs';

test('failed private-file deletion stays visible and can be retried without freeing storage prematurely',async()=>{
  const row={id:'recording',user_id:'owner',storage_path:'owner/recording/audio.wav',status:'transcribed'};
  const rows=[row];let attempts=0;
  const client={
    async rpc(name,args){assert.equal(name,'rehearsal_prepare_delete');assert.deepEqual(args,{p_user:'owner',p_recording:'recording'});row.status='deleting';return {data:row.storage_path};},
    storage:{from(bucket){assert.equal(bucket,'recordings');return {async remove(paths){assert.deepEqual(paths,[row.storage_path]);attempts++;return attempts===1?{error:{message:'sensitive provider diagnostic'}}:{data:[]};}};}},
    from(table){
      assert.equal(table,'rehearsal_recordings');let removing=false;const filters=[];
      const query={select(){return query;},delete(){removing=true;return query;},eq(key,value){filters.push([key,value]);return query;},order(){return query;},limit(){return query;},then(resolve){
        assert.ok(filters.some(([k,v])=>k==='user_id'&&v==='owner'));
        if(removing){assert.ok(filters.some(([k,v])=>k==='id'&&v==='recording'));rows.length=0;}
        resolve({data:[...rows]});
      }};return query;
    },
  };
  const store=createSupabaseStore(client);
  await assert.rejects(store.remove('owner','recording'),{status:503,message:'Private storage is temporarily unavailable.'});
  assert.equal(rows.length,1);assert.equal((await store.list('owner'))[0].status,'deleting');
  await store.remove('owner','recording');assert.equal(rows.length,0);assert.equal(attempts,2);
});

test('record creation handles PostgREST composite rows and keeps the owner server-derived',async()=>{
  let sent;const row={id:'recording',storage_path:'owner/recording/audio.wav'};
  const store=createSupabaseStore({async rpc(name,args){sent={name,args};return {data:[row]};}});
  assert.deepEqual(await store.create('owner','recording','Practice',1,32044),row);
  assert.equal(sent.name,'rehearsal_create_recording');assert.equal(sent.args.p_user,'owner');
});

test('database budget denials preserve their safe status without disclosing database diagnostics',async()=>{
  for(const [message,status,expected] of [['budget_exhausted',429,/allowance/],['database password=secret',503,/temporarily unavailable/]]){
    const store=createSupabaseStore({async rpc(){return {error:{message}};}});
    await assert.rejects(store.reserve('u','r','q','coach','hash',500000),error=>error.status===status&&expected.test(error.message)&&!error.message.includes('password'));
  }
});

test('distributed rate admission uses only server-derived identity and a safe retry delay',async()=>{
  const calls=[];
  const store=createSupabaseStore({async rpc(name,args){calls.push([name,args]);return {data:null};}});
  await store.admitRequest();await store.admitRequest('verified-owner');
  assert.deepEqual(calls,[['rehearsal_admit_request',{p_user:null}],['rehearsal_admit_request',{p_user:'verified-owner'}]]);
  const limited=createSupabaseStore({async rpc(){return {error:{message:'rate_limited'}};}});
  await assert.rejects(limited.admitRequest(),error=>error.safe&&error.status===429&&error.retryAfter===60);
});

test('refresh recovery reads through the restricted RPC with the verified owner and safe errors',async()=>{
  const calls=[],result={recording_id:'recording',kind:'coach',state:'completed',response:{report:'saved'}};
  const store=createSupabaseStore({async rpc(name,args){calls.push([name,args]);return {data:result};}});
  assert.deepEqual(await store.requestStatus('verified-owner','request'),result);
  assert.deepEqual(calls,[['rehearsal_get_request',{p_user:'verified-owner',p_request:'request'}]]);
  for (const [message,status] of [['not_found',404],['database password=secret',503]]) {
    const failed=createSupabaseStore({async rpc(){return {error:{message}};}});
    await assert.rejects(failed.requestStatus('owner','request'),error=>error.safe&&error.status===status&&!error.message.includes('password'));
  }
});

test('refresh cancellation passes only verified owner and exact request identity to the restricted RPC',async()=>{
  let sent;const result={status:'cancelled',audio_saved:false};
  const store=createSupabaseStore({async rpc(name,args){sent={name,args};return {data:result};}});
  assert.deepEqual(await store.liveCancel('verified-owner','recording','request'),result);
  assert.deepEqual(sent,{name:'rehearsal_live_cancel',args:{p_user:'verified-owner',p_recording:'recording',p_request:'request'}});
  const limited=createSupabaseStore({async rpc(){return {error:{message:'recovery_limit'}};}});
  await assert.rejects(limited.liveCancel('owner','recording','request'),error=>error.safe&&error.status===429);
});

test('batch cancel and atomic completion use restricted owner-scoped RPCs',async()=>{
  const calls=[];const store=createSupabaseStore({async rpc(name,args){calls.push({name,args});return {data:{state:'cancelled'}};}});
  await store.cancelRequest('owner','recording','request');await store.completeRequest('owner','request',{text:'Saved text.'});
  assert.deepEqual(calls,[{name:'rehearsal_cancel_request',args:{p_user:'owner',p_recording:'recording',p_request:'request'}},
    {name:'rehearsal_complete_request',args:{p_user:'owner',p_request:'request',p_response:{text:'Saved text.'}}}]);
  const cancelled=createSupabaseStore({async rpc(){return {error:{message:'request_cancelled'}};}});
  await assert.rejects(cancelled.completeRequest('owner','request',{}),error=>error.status===409&&error.jobState==='cancelled');
});

test('streaming claims and completions bind the server-derived owner and exact segment',async()=>{
  const calls=[]; const store=createSupabaseStore({async rpc(name,args){calls.push({name,args});return {data:{state:'new',ready:false}};}});
  await store.liveStreamClaim('owner','recording','request',0); await store.liveStreamFinish('owner','recording','request',0,'Hello.',24000);
  await store.liveStreamFail('owner','recording','request',0);
  assert.deepEqual(calls,[{name:'rehearsal_stream_claim',args:{p_user:'owner',p_recording:'recording',p_request:'request',p_sequence:0}},
    {name:'rehearsal_stream_finish',args:{p_user:'owner',p_recording:'recording',p_request:'request',p_sequence:0,p_text:'Hello.',p_samples:24000}},
    {name:'rehearsal_stream_fail',args:{p_user:'owner',p_recording:'recording',p_request:'request',p_sequence:0}}]);
});

test('draft key recovery uses the restricted RPC with verified owner and original request',async()=>{
  let sent;const store=createSupabaseStore({async rpc(name,args){sent={name,args};return {data:{draft_key:'key'}};}});
  assert.deepEqual(await store.liveDraftKey('owner','recording','request'),{draft_key:'key'});
  assert.deepEqual(sent,{name:'rehearsal_live_draft_key',args:{p_user:'owner',p_recording:'recording',p_request:'request'}});
});

test('only definite reservation refusals prove a request was not started',async()=>{
  for(const message of ['request_busy','daily_limit','budget_exhausted','request_conflict','private network failure']) {
    const store=createSupabaseStore({async rpc(){return {error:{message}};}});
    await assert.rejects(store.reserve('owner','recording','request','coach','hash',1),error=>{
      assert.equal(error.notStarted,['request_busy','daily_limit','budget_exhausted'].includes(message)?true:undefined);return true;
    });
    await assert.rejects(store.liveFinish('owner','recording',1,32044),error=>error.notStarted===undefined);
  }
  const uncertain=createSupabaseStore({async rpc(){throw new Error('Lost admission response');}});
  await assert.rejects(uncertain.reserve('owner','recording','request','coach','hash',1),error=>error.notStarted===undefined);
});

test('gateway audio storage uses a fixed private bucket and never overwrites a prior take',async()=>{
  const bytes=new Uint8Array([1,2,3]),calls=[];
  const store=createSupabaseStore({storage:{from(bucket){return {async upload(path,payload,options){calls.push({bucket,path,payload,options});return {data:{path}};}};}}});
  assert.deepEqual(await store.uploadAudio('verified-owner/reserved-id/audio.wav',bytes),{path:'verified-owner/reserved-id/audio.wav'});
  assert.deepEqual(calls,[{bucket:'recordings',path:'verified-owner/reserved-id/audio.wav',payload:bytes,options:{contentType:'audio/wav',upsert:false}}]);
});

test('duplicate storage replies expose only a safe conflict for an identical-byte retry',async()=>{
  for(const error of [{statusCode:'409',message:'private diagnostic'},{error:'Duplicate',message:'private diagnostic'}]) {
    const store=createSupabaseStore({storage:{from(){return {async upload(){return {error};}};}}});
    await assert.rejects(store.uploadAudio('owner/id/audio.wav',new Uint8Array()),error=>error.safe&&error.status===409&&!error.message.includes('private'));
  }
});
