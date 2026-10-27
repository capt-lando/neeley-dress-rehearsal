import test from 'node:test';
import assert from 'node:assert/strict';
import { attachRealtimeSession,createRealtimeHandler,REALTIME_CONFIG } from '../supabase/functions/rehearsal-api/realtime.mjs';

const user='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const recordingId='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444';
const origin='https://capt-lando.github.io';
const token=(sub=user,method='oauth')=>'header.'+Buffer.from(JSON.stringify({sub,amr:[{method}]})).toString('base64url')+'.signature';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};

class Socket extends EventTarget {
  readyState=1;bufferedAmount=0;sent=[];closed=[];autoClose=true;
  send(value){if(this.readyState!==1)throw new Error('closed');this.sent.push(JSON.parse(value));}
  close(code){this.closed.push(code);this.readyState=2;if(this.autoClose)this.finishClose();}
  finishClose(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  emit(value){this.dispatchEvent(new MessageEvent('message',{data:typeof value==='object'&&!(value instanceof ArrayBuffer)?JSON.stringify(value):value}));}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
}
function fixture(options={}) {
  const socket=new Socket(),provider=new Socket(),calls=[];
  const claim={state:'new',maxSamples:2640000,consumedSamples:0,transcript:'',nextSequence:0,...options.claim};
  const store={
    async verifyUser(value){calls.push(['verify',value]);return {id:user,identities:[{provider:'google'}]};},
    async admitRequest(value){calls.push(['admit',value]);},
    async profile(value){calls.push(['profile',value]);},
    async liveStreamClaim(...args){calls.push(['claim',...args]);return claim;},
    async liveGet(...args){calls.push(['get',...args]);return {request_id:requestId,status:'active',expires_at:new Date(Date.now()+600000).toISOString()};},
    async liveStreamFinish(...args){calls.push(['finish',...args]);const text=args[4].trim(),samples=args[5];return {text,transcript:[claim.transcript,text].filter(Boolean).join(' '),samples,nextSequence:args[3]+1,consumedSamples:claim.consumedSamples+samples};},
    async liveStreamFail(...args){calls.push(['fail',provider.readyState,...args]);},
    ...options.store,
  };
  const session=attachRealtimeSession({socket,store,connectProvider(){calls.push(['connect']);return provider;},...options.session});
  const start=async(message={})=>{socket.emit({type:'start',token:token(),recordingId,requestId,segmentIndex:0,...message});await tick();};
  const ready=async(message={})=>{await start(message);provider.open();provider.emit({type:'session.updated'});await tick();};
  const final=async(text='Um, I, I think this works.',id='item-1')=>{
    socket.emit({type:'finish'});provider.emit({type:'input_audio_buffer.committed',item_id:id});
    provider.emit({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:text});await session.done;
  };
  return {socket,provider,calls,store,session,start,ready,final};
}
const audio=(samples=4800)=>new Int16Array(samples).buffer;

test('verified owner streams incremental text before commit, then persists the provider final exactly',async()=>{
  const f=fixture();await f.ready();
  assert.deepEqual(f.calls.find(call=>call[0]==='claim'),['claim',user,recordingId,requestId,0]);
  assert.deepEqual(f.provider.sent,[REALTIME_CONFIG]);
  assert.deepEqual(f.socket.sent[0],{type:'ready',segmentIndex:0,maxSamples:2640000,sampleRate:24000,transcript:''});
  f.socket.emit(audio());
  assert.equal(f.provider.sent[1].type,'input_audio_buffer.append');
  assert.equal(Buffer.from(f.provider.sent[1].audio,'base64').length,9600);
  assert.deepEqual(f.socket.sent.at(-1),{type:'audio_ack',samples:4800});
  f.provider.emit({type:'conversation.item.input_audio_transcription.delta',item_id:'item-1',delta:'Um, I, I '});
  assert.deepEqual(f.socket.sent.at(-1),{type:'transcript',text:'Um, I, I',final:false});
  assert.equal(f.provider.sent.some(event=>event.type==='input_audio_buffer.commit'),false);
  await f.final();
  assert.deepEqual(f.socket.sent.at(-1),{type:'segment_complete',text:'Um, I, I think this works.',transcript:'Um, I, I think this works.',nextSequence:1,consumedSamples:4800,samples:4800});
  assert.equal(f.provider.readyState,3);assert.equal(f.calls.some(call=>call[0]==='fail'),false);
});

test('rotation preserves the verified cumulative prefix and exact 24k sample accounting',async()=>{
  const f=fixture({claim:{transcript:'First section.',consumedSamples:24000,nextSequence:1}});await f.ready({segmentIndex:1});
  f.socket.emit(audio(12000));f.socket.emit(audio(12000));
  await f.final('Second section.');
  assert.deepEqual(f.socket.sent.at(-1),{type:'segment_complete',text:'Second section.',transcript:'First section. Second section.',nextSequence:2,consumedSamples:48000,samples:24000});
});

test('an empty segment finishes without sending an invalid empty provider commit',async()=>{
  const f=fixture();await f.ready();f.socket.emit({type:'finish'});await f.session.done;
  assert.equal(f.provider.sent.some(event=>event.type==='input_audio_buffer.commit'),false);
  assert.deepEqual(f.socket.sent.at(-1),{type:'segment_complete',text:'',transcript:'',nextSequence:1,consumedSamples:0,samples:0});
});

test('a sub-100ms tail is padded only upstream, while actual sample counts stay exact',async()=>{
  const f=fixture({claim:{consumedSamples:14399976,maxSamples:24}});await f.ready();f.socket.emit(audio(24));await f.final('');
  const appends=f.provider.sent.filter(event=>event.type==='input_audio_buffer.append');
  assert.equal(Buffer.from(appends[0].audio,'base64').length,48);
  const padding=Buffer.from(appends[1].audio,'base64');assert.equal(padding.length,4752);assert.equal(padding.every(byte=>byte===0),true);
  assert.equal(f.socket.sent.at(-1).samples,24);assert.equal(f.socket.sent.at(-1).consumedSamples,14400000);
});

test('a completion arriving before the committed event is joined by its provider item ID',async()=>{
  const f=fixture();await f.ready();f.socket.emit(audio());f.socket.emit({type:'finish'});
  f.provider.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'final-1',transcript:'Final.'});
  assert.equal(f.calls.some(call=>call[0]==='finish'),false);
  f.provider.emit({type:'input_audio_buffer.committed',item_id:'final-1'});await f.session.done;
  assert.equal(f.socket.sent.at(-1).transcript,'Final.');
});

test('another user cannot claim a session even with a real-looking browser identifier',async()=>{
  const f=fixture({store:{async liveStreamClaim(id){assert.equal(id,user);throw Object.assign(new Error('This recording was not found.'),{safe:true});}}});
  await f.start();await f.session.done;
  assert.equal(f.calls.some(call=>call[0]==='connect'),false);assert.equal(f.socket.sent.at(-1).type,'error');
});

for(const [name,start,store] of [
  ['invalid verified token',{}, {async verifyUser(){return null;}}],
  ['spoofed subject',{token:token(other)},{}],
  ['password authentication',{token:token(user,'password')},{}],
  ['unapproved identity',{}, {async verifyUser(){return {id:user,identities:[{provider:'google'},{provider:'github'}]};}}],
  ['browser owner override',{userId:other},{}],
  ['browser model override',{model:'expensive-model'},{}],
  ['oversized credential',{token:'x'.repeat(16378)},{}],
  ['out-of-bound segment index',{segmentIndex:12},{}],
])test(`rejects ${name} before a paid connection`,async()=>{
  const f=fixture({store});await f.start(start);await f.session.done;
  assert.equal(f.calls.some(call=>call[0]==='connect'),false);
  assert.equal(f.calls.some(call=>call[0]==='claim'),false);
});

for(const state of ['reserved','completed','failed'])test(`a ${state} segment is not replayed or billed again`,async()=>{
  const f=fixture({claim:{state}});await f.start();await f.session.done;
  assert.equal(f.calls.some(call=>call[0]==='connect'),false);assert.equal(f.calls.some(call=>call[0]==='fail'),false);
});

test('disconnect while the owner claim is pending never opens a late paid connection',async()=>{
  const pending=deferred();const f=fixture({store:{liveStreamClaim:()=>pending.promise}});
  await f.start();f.socket.finishClose();await tick();
  pending.resolve({state:'new'});await f.session.done;
  assert.equal(f.calls.some(call=>call[0]==='connect'),false);
  assert.deepEqual(f.calls.find(call=>call[0]==='fail').slice(2),[user,recordingId,requestId,0]);
});

test('disconnect while token validation is pending never creates a reservation',async()=>{
  const pending=deferred();const f=fixture({store:{verifyUser:()=>pending.promise}});
  await f.start();f.socket.finishClose();pending.resolve({id:user,identities:[{provider:'google'}]});await f.session.done;
  assert.equal(f.calls.some(call=>call[0]==='claim'),false);assert.equal(f.calls.some(call=>call[0]==='connect'),false);
});

test('client cancellation closes the provider before acknowledging durable cancellation',async()=>{
  const f=fixture();await f.ready();f.socket.emit(audio());f.socket.emit({type:'cancel'});await f.session.done;
  assert.equal(f.calls.find(call=>call[0]==='fail')[1],3);
  assert.equal(f.calls.some(call=>call[0]==='finish'),false);
});

test('a provider close that cannot be confirmed leaves the reservation pending',async()=>{
  const f=fixture({session:{closeTimeoutMs:5}});await f.ready();f.provider.autoClose=false;
  f.socket.emit({type:'cancel'});await f.session.done;
  assert.equal(f.provider.readyState,2);assert.equal(f.calls.some(call=>call[0]==='fail'),false);f.provider.finishClose();
});

test('durable cancellation stops the exact session while audio is streaming',async()=>{
  let cancelled=false;const f=fixture({session:{cancellationPollMs:5},store:{async liveGet(){return {request_id:requestId,status:cancelled?'cancelled':'active',expires_at:new Date(Date.now()+600000).toISOString()};}}});
  await f.ready();cancelled=true;await f.session.done;
  assert.equal(f.provider.readyState,3);assert.equal(f.calls.some(call=>call[0]==='finish'),false);
});

test('expired or replaced request is rejected before provider connection',async()=>{
  const f=fixture({store:{async liveGet(){return {request_id:other,status:'active',expires_at:new Date(Date.now()+600000).toISOString()};}}});
  await f.start();await f.session.done;assert.equal(f.calls.some(call=>call[0]==='connect'),false);
});

for(const [name,frame] of [
  ['odd byte count',new ArrayBuffer(3)],['empty audio',new ArrayBuffer(0)],['oversized audio',new ArrayBuffer(24002)],
  ['non-binary data',true],['provider configuration',{type:'session.update',session:{model:'different'}}],['transcript injection',{type:'finish',text:'invented'}],
])test(`rejects ${name}, closing upstream before durable failure`,async()=>{
  const f=fixture();await f.ready();f.socket.emit(frame);await f.session.done;
  assert.equal(f.calls.find(call=>call[0]==='fail')[1],3);assert.equal(f.provider.sent.length,1);
});

test('a socket cannot exceed its atomically reserved remaining sample budget',async()=>{
  const f=fixture({claim:{maxSamples:12000,consumedSamples:14388000}});await f.ready();
  f.socket.emit(audio(12000));f.socket.emit(audio(1));await f.session.done;
  assert.equal(f.provider.sent.filter(event=>event.type==='input_audio_buffer.append').length,1);
  assert.equal(f.calls.some(call=>call[0]==='finish'),false);
});

test('invalid server reservation totals fail closed before connecting',async()=>{
  const f=fixture({claim:{consumedSamples:14400000,maxSamples:1}});await f.start();await f.session.done;
  assert.equal(f.calls.some(call=>call[0]==='connect'),false);
});

test('audio cannot overrun a backed-up upstream socket',async()=>{
  const f=fixture();await f.ready();f.provider.bufferedAmount=262145;f.socket.emit(audio());await f.session.done;
  assert.equal(f.provider.sent.length,1);
});

test('audio before authentication or readiness is rejected without paid work',async()=>{
  const f=fixture();f.socket.emit(audio());await f.session.done;
  assert.equal(f.calls.some(call=>call[0]==='connect'),false);
});

test('a provider final cannot be published before the client finishes its segment',async()=>{
  const f=fixture();await f.ready();f.provider.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'unexpected',transcript:'Bad.'});await f.session.done;
  assert.equal(f.calls.some(call=>call[0]==='finish'),false);
});

test('a final transcript for a different item cannot be attached to the recording',async()=>{
  const f=fixture();await f.ready();f.socket.emit(audio());f.socket.emit({type:'finish'});
  f.provider.emit({type:'input_audio_buffer.committed',item_id:'expected'});
  f.provider.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'unexpected',transcript:'Bad.'});await f.session.done;
  assert.equal(f.calls.some(call=>call[0]==='finish'),false);
});

test('provider errors and credential details are never reflected to the browser',async()=>{
  const f=fixture();await f.ready();f.provider.emit({type:'error',error:{message:'Secret sk-test and private provider details.'}});await f.session.done;
  assert.equal(JSON.stringify(f.socket.sent).includes('sk-test'),false);
});

test('late final after cancellation does not persist text or resurrect a session',async()=>{
  const f=fixture();await f.ready();f.socket.emit(audio());f.socket.emit({type:'cancel'});
  f.provider.emit({type:'conversation.item.input_audio_transcription.completed',item_id:'late',transcript:'Late.'});await f.session.done;
  assert.equal(f.calls.some(call=>call[0]==='finish'),false);
});

test('overall socket deadline closes provider even without client finish',async()=>{
  const f=fixture({session:{sessionTimeoutMs:15}});await f.ready();await f.session.done;
  assert.equal(f.provider.readyState,3);assert.equal(f.calls.find(call=>call[0]==='fail')[1],3);
});

test('final drain deadline does not leave paid work running',async()=>{
  const f=fixture({session:{drainTimeoutMs:5}});await f.ready();f.socket.emit(audio());f.socket.emit({type:'finish'});await f.session.done;
  assert.equal(f.provider.readyState,3);
});

test('unidentified sockets have a short authentication deadline',async()=>{
  const f=fixture({session:{authTimeoutMs:5}});await f.session.done;assert.equal(f.calls.length,0);
});

test('HTTP upgrade enforces origin, query-free credentials, method, and server configuration',async()=>{
  let upgrades=0,admitted=0;
  const handler=createRealtimeHandler({env:{ALLOWED_ORIGINS:origin,COACHING_PROVIDER:'openai',COACHING_API_KEY:'secret'},store:{async admitRequest(){admitted++;}},upgrade(){upgrades++;throw new Error('must not upgrade');}});
  for(const [url,headers,method,status] of [
    ['https://example.test/live-stream',{origin,upgrade:'websocket'},'POST',400],
    ['https://example.test/live-stream?token=secret',{origin,upgrade:'websocket'},'GET',400],
    ['https://example.test/live-stream',{origin:'https://evil.test',upgrade:'websocket'},'GET',403],
    ['https://example.test/live-stream',{origin},'GET',400],
  ])assert.equal((await handler(new Request(url,{method,headers}))).status,status);
  assert.equal(upgrades,0);assert.equal(admitted,0);
});

test('accepted HTTP upgrades are held alive until the session closes',async()=>{
  const socket=new Socket();let active;
  const handler=createRealtimeHandler({env:{ALLOWED_ORIGINS:origin,COACHING_PROVIDER:'openai',COACHING_API_KEY:'secret'},store:{async admitRequest(){}},
    upgrade:()=>({socket,response:new Response('upgraded')}),waitUntil:promise=>{active=promise;}});
  const response=await handler(new Request('https://example.test/live-stream',{headers:{origin,upgrade:'websocket'}}));
  assert.equal(await response.text(),'upgraded');assert.ok(active instanceof Promise);socket.finishClose();await active;
});
