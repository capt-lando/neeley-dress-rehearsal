import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedApi, fail } from '../supabase/functions/rehearsal-api/api.mjs';

const owner='11111111-1111-4111-8111-111111111111',id='33333333-3333-4333-8333-333333333333';
const origin='https://capt-lando.github.io';
function wav(seconds=1) {
  const b=Buffer.alloc(44+32000*seconds);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;
}
function fixture({deny=false}={}) {
  const row={id,user_id:owner,status:'pending',storage_path:`${owner}/${id}/audio.wav`,duration_seconds:.5,size_bytes:16044,upload_expires_at:'2100-01-01T00:00:00Z'};
  const stored=new Map(),calls=[];
  const app=createHostedApi({policyText:'Coach the rehearsal.',env:{ALLOWED_ORIGINS:origin},store:{
    async admitRequest(user){calls.push(['admit',user]);if(deny)throw Object.assign(fail('Too many requests.',429),{retryAfter:60});},async verifyUser(){return{id:owner,identities:[{provider:'google'}]};},async profile(){},
    async owned(user,key){return user===row.user_id&&key===row.id?row:null;},
    async uploadAudio(path,bytes){calls.push(['upload',path]);if(stored.has(path))throw fail('Exists',409);stored.set(path,new Blob([bytes]));},
    async audio(path){calls.push(['read',path]);return stored.get(path);},
    async update(user,key,patch){assert.equal(user,owner);assert.equal(key,id);Object.assign(row,patch);},
    async reserve(){assert.fail('Uploads must never reserve AI');},
  },coach(){assert.fail('Uploads must never call AI');},fetchImpl(){assert.fail('Uploads must never call a worker');}});
  const token='header.'+Buffer.from(JSON.stringify({sub:owner,amr:[{method:'oauth'}]})).toString('base64url')+'.signature';
  const upload=(bytes=wav(),type='audio/wav',key=id)=>app(new Request(`https://example.test/rehearsal-api/recordings/${key}/audio`,{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':type},body:bytes}));
  return {row,stored,calls,upload};
}
test('validated gateway stores only canonical audio and derives authoritative metadata',async()=>{
  const f=fixture(),bytes=wav(2),response=await f.upload(bytes);
  assert.equal(response.status,201);assert.deepEqual(await response.json(),{id,stored:true,durationSeconds:2,sizeBytes:64044});
  assert.equal(f.row.duration_seconds,2);assert.equal(f.row.size_bytes,64044);
  assert.deepEqual(Buffer.from(await f.stored.get(f.row.storage_path).arrayBuffer()),bytes);
  assert.deepEqual(f.calls.slice(0,3),[['admit',undefined],['admit',owner],['upload',f.row.storage_path]]);
});
test('fake WAV, compressed, alternate format and trailing data are rejected before storage',async()=>{
  const payloads=[Buffer.from('<script>alert(1)</script>'),Buffer.from('ID3not decoded MP3'),Buffer.from('PK\u0003\u0004zip'),Buffer.concat([wav(),Buffer.from('hidden metadata')]),wav(.25),wav(601)];
  for(const [offset,value,wide] of [[20,3,false],[22,2,false],[24,48000,true],[28,64000,true],[32,4,false],[34,32,false],[40,1,true],[4,10,true]]) {
    const bytes=wav();wide?bytes.writeUInt32LE(value,offset):bytes.writeUInt16LE(value,offset);payloads.push(bytes);
  }
  for(const bytes of payloads){const f=fixture();assert.equal((await f.upload(bytes)).status,400);assert.equal(f.stored.size,0);assert.equal(f.calls.some(c=>c[0]==='upload'),false);}
  const f=fixture();assert.equal((await f.upload(wav(),'audio/mpeg')).status,415);assert.equal(f.stored.size,0);
});
test('foreign, expired and nonpending recording slots cannot receive audio',async()=>{
  for(const patch of [{user_id:'22222222-2222-4222-8222-222222222222'},{upload_expired:true},{status:'analyzed'},{status:'deleting'},{upload_expires_at:'2020-01-01T00:00:00Z'}]) {
    const f=fixture();Object.assign(f.row,patch);assert.ok([404,409].includes((await f.upload()).status));assert.equal(f.stored.size,0);
  }
});
test('lost upload acknowledgement retries identical bytes without replacing a take',async()=>{
  const f=fixture(),bytes=wav();assert.equal((await f.upload(bytes)).status,201);
  assert.equal((await f.upload(bytes)).status,201);assert.equal(f.stored.size,1);
  const changed=wav();changed[100]=1;assert.equal((await f.upload(changed)).status,409);
  assert.equal((await f.upload(wav(2))).status,409);
  assert.deepEqual(Buffer.from(await f.stored.get(f.row.storage_path).arrayBuffer()),bytes);
});
test('concurrent identical uploads converge on one immutable stored recording',async()=>{
  const f=fixture(),responses=await Promise.all([f.upload(),f.upload(),f.upload()]);
  assert.deepEqual(responses.map(r=>r.status),[201,201,429]);assert.equal(f.stored.size,1);
  assert.equal(responses[2].headers.get('retry-after'),'2');
  assert.equal((await f.upload()).status,201);
});
test('upload endpoint rejects rate-limited submissions before reading or saving audio',async()=>{
  const f=fixture({deny:true}),response=await f.upload();
  assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60');assert.equal(f.stored.size,0);assert.deepEqual(f.calls,[['admit',undefined]]);
});
