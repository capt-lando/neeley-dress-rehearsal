import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBoundedFetch} from '../supabase/functions/rehearsal-api/bounded-fetch.mjs';

// Real fetch rejects on abort. This mock makes that contract deterministic and
// never opens a network connection; the watchdog only catches a broken bound.
function pendingFetch(_input,{signal}) {
  return new Promise((_resolve,reject)=>{
    if(signal.aborted)reject(signal.reason);
    else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
}
async function watchdog(run) {
  let timer;
  try{return await Promise.race([run,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Deadline did not release the operation.')),2000);})]);}
  finally{clearTimeout(timer);}
}

test('stalled database response headers are aborted within the configured deadline',async()=>{
  const bounded=createBoundedFetch({fetchImpl:pendingFetch,timeoutMs:10});
  await assert.rejects(watchdog(bounded('https://storage.invalid/auth/v1/user')),error=>error.name==='TimeoutError');
});

test('the database deadline remains active while a response body stalls after headers',async()=>{
  const bounded=createBoundedFetch({timeoutMs:10,fetchImpl:async(_input,{signal})=>new Response(new ReadableStream({
    start(controller){signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});},
  }))});
  const response=await bounded('https://storage.invalid/rest/v1/rpc/rehearsal_get_request');
  await assert.rejects(watchdog(response.text()),error=>error.name==='TimeoutError');
});

test('both explicit and Request input cancellation remain effective',async()=>{
  for(const source of ['request','options']) {
    const requestAbort=new AbortController(),optionsAbort=new AbortController();
    const bounded=createBoundedFetch({fetchImpl:pendingFetch});
    const result=bounded(new Request('https://storage.invalid/rest/v1/recordings',{signal:requestAbort.signal}),{signal:optionsAbort.signal});
    const reason=new Error(`${source} cancelled`);
    (source==='request'?requestAbort:optionsAbort).abort(reason);
    await assert.rejects(watchdog(result),error=>error===reason);
  }
});

test('the wrapper preserves request options and successful response bytes',async()=>{
  const bounded=createBoundedFetch({fetchImpl:async(input,options)=>{
    assert.equal(input,'https://storage.invalid/rest/v1/rpc/test');
    assert.equal(options.method,'POST');assert.equal(options.body,'{}');
    assert.equal(options.headers.Authorization,'Bearer synthetic');
    assert.equal(options.signal.aborted,false);return new Response('exact response');
  }});
  assert.equal(await(await bounded('https://storage.invalid/rest/v1/rpc/test',{method:'POST',body:'{}',headers:{Authorization:'Bearer synthetic'}})).text(),'exact response');
});

test('the production Supabase client uses the deadline for auth, database and storage',async()=>{
  const source=await readFile(new URL('../supabase/functions/rehearsal-api/index.ts',import.meta.url),'utf8');
  assert.match(source,/global:\s*\{\s*fetch:\s*createBoundedFetch\(\)/);
});
