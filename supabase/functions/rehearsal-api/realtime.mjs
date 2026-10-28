import { createRequestLimit } from './request-limit.mjs';
import { MAX_RECORDING_SECONDS } from '../../../lib/recording-limits.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RATE=24000, FRAME_BYTES=24000, MAX_SAMPLES=110*RATE, TOTAL_SAMPLES=MAX_RECORDING_SECONDS*RATE;
const UNAVAILABLE='Live transcription was interrupted. Your recording can still be saved and transcribed in full.';
const safeError=(message,status=400)=>Object.assign(new Error(message),{safe:true,status});
const combine=(prefix,text)=>[prefix.trim(),text.trim()].filter(Boolean).join(' ');

// The client can send audio and finish/cancel only. All paid provider settings
// and the credential stay on the server, including the fifteen-minute budget.
export const REALTIME_CONFIG={type:'session.update',session:{type:'transcription',audio:{input:{
  format:{type:'audio/pcm',rate:RATE},
  transcription:{model:'gpt-live-transcribe',languages:['en'],delay:'low',prompt:'Verbatim speech, including filler words and repetitions.'},
  turn_detection:null,
}}}};

function parseMessage(data,maxLength=20000) {
  if(typeof data!=='string'||data.length>maxLength)throw safeError('Invalid live transcription message.');
  let value;try{value=JSON.parse(data);}catch{throw safeError('Invalid live transcription message.');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw safeError('Invalid live transcription message.');
  return value;
}
function exactKeys(value,keys) { return Object.keys(value).every(key=>keys.includes(key)); }
function base64(bytes) { let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary); }

async function identify(store,token) {
  const user=await store.verifyUser(token);
  if(!user||!UUID.test(user.id||''))throw safeError('Your session expired. Sign in again.',401);
  let claims;try{claims=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));}catch{throw safeError('Your session is invalid. Sign in again.',401);}
  // Only validated JWT claims may be used; neither the frame nor a URL supplies
  // the owner identity used in any database operation.
  const identities=Array.isArray(user.identities)?user.identities:[];
  if(claims.sub!==user.id||!Array.isArray(claims.amr)||!claims.amr.some(item=>item?.method==='oauth')||
    !identities.some(item=>['google','azure'].includes(item.provider))||identities.some(item=>!['google','azure','email'].includes(item.provider)))
    throw safeError('Use Google or Microsoft sign-in for this pilot.',403);
  await store.admitRequest(user.id);
  await store.profile(user.id);
  return user.id;
}

/** One bounded, owner-verified segment; injected sockets keep tests offline. */
export function attachRealtimeSession({socket,store,connectProvider,now=Date.now,
  authTimeoutMs=5000,sessionTimeoutMs=120000,drainTimeoutMs=15000,cancellationPollMs=2000,closeTimeoutMs=3000}) {
  socket.binaryType='arraybuffer';
  let state='auth',identity=null,claimed=false,provider=null,providerClosed=false,resolveProviderClosed;
  let samples=0,maxSamples=0,consumedSamples=0,prefix='',partial='',itemId=null,committedId=null,pendingFinal=null;
  let ending=false,finished=false,cleanupPromise=null,startupPromise=null,resolveDone;
  const done=new Promise(resolve=>{resolveDone=resolve;});
  const providerDone=new Promise(resolve=>{resolveProviderClosed=resolve;});
  const timers=new Set();
  const timer=(fn,ms)=>{const id=setTimeout(()=>{timers.delete(id);fn();},ms);timers.add(id);return id;};
  const clear=handle=>{clearTimeout(handle);timers.delete(handle);};
  const send=value=>{if(socket.readyState===1)socket.send(JSON.stringify(value));};
  const clearTimers=()=>{for(const handle of timers)clearTimeout(handle);timers.clear();};
  const closeClient=code=>{try{if(socket.readyState<2)socket.close(code);}catch{}};
  const closeProvider=()=>{if(!provider)return;try{if(provider.readyState<2)provider.close(1000);}catch{}};
  async function upstreamStopped() {
    closeProvider();
    if(!provider||providerClosed||provider.readyState===3)return true;
    let handle;
    const stopped=await Promise.race([providerDone.then(()=>true),new Promise(resolve=>{handle=setTimeout(()=>resolve(false),closeTimeoutMs);})]);
    clearTimeout(handle);return stopped;
  }
  async function cleanup(error=null,{normal=false}={}) {
    if(cleanupPromise)return cleanupPromise;
    ending=true;state='closed';clearTimers();
    // Start closing the provider before any database await. Do not claim that
    // cancellation stopped paid work unless the close handshake confirms it.
    closeProvider();
    if(error) {try{send({type:'error',message:error.safe?error.message:UNAVAILABLE});}catch{}}
    closeClient(normal?1000:1008);
    cleanupPromise=(async()=>{
      const stopped=await upstreamStopped();
      if(claimed&&!finished&&identity&&stopped) {
        try{await store.liveStreamFail(identity.user,identity.recordingId,identity.requestId,identity.segmentIndex);}catch{}
      }
      await startupPromise;
      resolveDone();
    })();
    return cleanupPromise;
  }
  const abort=error=>{void cleanup(error);};
  const authTimer=timer(()=>abort(safeError('Sign in again to start live transcription.')),authTimeoutMs);
  timer(()=>abort(safeError(UNAVAILABLE)),sessionTimeoutMs);

  async function watchCancellation() {
    if(ending||!identity)return;
    try {
      const session=await store.liveGet(identity.user,identity.recordingId);
      if(ending)return;
      if(!session||session.request_id!==identity.requestId||session.status!=='active'||!(Date.parse(session.expires_at)>now()))
        throw safeError('This rehearsal has ended. You can start another recording.');
      timer(()=>{void watchCancellation();},cancellationPollMs);
    }catch(error){if(!ending)abort(error);}
  }
  async function persist(text) {
    if(ending||state==='persisting')return;
    if(typeof text!=='string'||combine(prefix,text).length>60000)throw safeError(UNAVAILABLE);
    text=text.trim();
    state='persisting';
    // No more provider output is needed once the final transcript arrived.
    // Stop the upstream connection before publishing a durable completion.
    if(!await upstreamStopped())throw safeError(UNAVAILABLE);
    if(ending)return;
    const result=await store.liveStreamFinish(identity.user,identity.recordingId,identity.requestId,identity.segmentIndex,text,samples);
    if(ending)return;
    if(result?.nextSequence!==identity.segmentIndex+1||result.samples!==samples||result.consumedSamples!==consumedSamples+samples||
      result.transcript!==combine(prefix,text)||result.text!==text.trim())throw safeError(UNAVAILABLE);
    finished=true;
    send({type:'segment_complete',text:result.text,transcript:result.transcript,nextSequence:result.nextSequence,consumedSamples:result.consumedSamples,samples});
    await cleanup(null,{normal:true});
  }
  function providerMessage(data) {
    if(ending||state==='persisting')return;
    const event=parseMessage(data,524288);
    if(event.type==='error'||event.type==='conversation.item.input_audio_transcription.failed')throw safeError(UNAVAILABLE);
    if(event.type==='session.updated') {
      if(state!=='connecting')throw safeError(UNAVAILABLE);
      state='ready';send({type:'ready',segmentIndex:identity.segmentIndex,maxSamples,sampleRate:RATE,transcript:prefix});return;
    }
    if(event.type==='conversation.item.input_audio_transcription.delta') {
      if(!['ready','finishing'].includes(state)||typeof event.item_id!=='string'||typeof event.delta!=='string'||(itemId&&event.item_id!==itemId))throw safeError(UNAVAILABLE);
      itemId=event.item_id;partial+=event.delta;
      if(combine(prefix,partial).length>60000)throw safeError(UNAVAILABLE);
      send({type:'transcript',text:combine(prefix,partial),final:false});return;
    }
    if(event.type==='input_audio_buffer.committed') {
      if(state!=='finishing'||typeof event.item_id!=='string'||(itemId&&event.item_id!==itemId)||committedId)throw safeError(UNAVAILABLE);
      committedId=event.item_id;
      if(pendingFinal) {
        if(pendingFinal.item_id!==committedId)throw safeError(UNAVAILABLE);
        void persist(pendingFinal.transcript).catch(abort);
      }
      return;
    }
    if(event.type==='conversation.item.input_audio_transcription.completed') {
      if(state!=='finishing'||typeof event.item_id!=='string'||typeof event.transcript!=='string'||(itemId&&event.item_id!==itemId)||pendingFinal)throw safeError(UNAVAILABLE);
      pendingFinal=event;
      if(committedId) {
        if(event.item_id!==committedId)throw safeError(UNAVAILABLE);
        void persist(event.transcript).catch(abort);
      }
    }
  }
  async function start(message) {
    if(!exactKeys(message,['type','token','recordingId','requestId','segmentIndex'])||typeof message.token!=='string'||!message.token||message.token.length>16377||
      !UUID.test(message.recordingId||'')||!UUID.test(message.requestId||'')||!Number.isInteger(message.segmentIndex)||message.segmentIndex<0||message.segmentIndex>17)
      throw safeError('Invalid live transcription request.');
    state='identifying';
    const user=await identify(store,message.token);
    if(ending)return;
    identity={user,recordingId:message.recordingId,requestId:message.requestId,segmentIndex:message.segmentIndex};
    const claim=await store.liveStreamClaim(user,message.recordingId,message.requestId,message.segmentIndex);
    if(claim.state==='new')claimed=true;
    // A disconnect during the atomic reservation must still terminalize the
    // just-created reservation, without opening a late paid connection.
    if(ending) {
      if(claimed)try{await store.liveStreamFail(user,message.recordingId,message.requestId,message.segmentIndex);}catch{}
      return;
    }
    clear(authTimer);
    if(claim.state!=='new')throw safeError('This live section is already processing or finished. Save the recording to continue.');
    maxSamples=claim.maxSamples;consumedSamples=claim.consumedSamples;prefix=claim.transcript;
    if(!Number.isInteger(maxSamples)||maxSamples<=0||maxSamples>MAX_SAMPLES||!Number.isInteger(consumedSamples)||consumedSamples<0||consumedSamples+maxSamples>TOTAL_SAMPLES||
      typeof prefix!=='string'||prefix.length>60000||claim.nextSequence!==identity.segmentIndex)throw safeError(UNAVAILABLE);
    // Confirm cancellation immediately, then continue checking while audio is
    // flowing; database ownership/request binding is authoritative throughout.
    await watchCancellation();
    if(ending)return;
    state='connecting';provider=connectProvider();
    provider.addEventListener('close',()=>{
      providerClosed=true;resolveProviderClosed();
      if(!ending&&state!=='persisting')abort(safeError(UNAVAILABLE));
    });
    provider.addEventListener('error',()=>{if(!ending)abort(safeError(UNAVAILABLE));});
    provider.addEventListener('open',()=>{
      if(ending){closeProvider();return;}
      try{provider.send(JSON.stringify(REALTIME_CONFIG));}catch(error){abort(error);}
    });
    provider.addEventListener('message',({data})=>{try{providerMessage(data);}catch(error){abort(error);}});
  }
  function receive(data) {
    if(ending)return;
    if(typeof data==='string') {
      const message=parseMessage(data);
      if(message.type==='cancel'&&exactKeys(message,['type'])){abort(safeError('This rehearsal was cancelled.'));return;}
      if(state==='auth'&&message.type==='start'){startupPromise=start(message).catch(abort);return;}
      if(state==='ready'&&message.type==='finish'&&exactKeys(message,['type'])) {
        state='finishing';timer(()=>abort(safeError(UNAVAILABLE)),drainTimeoutMs);
        if(samples===0){void persist('').catch(abort);return;}
        // A rotation can leave a final fraction of a second. OpenAI requires
        // at least 100ms per commit; provider-only silence is never counted as
        // recorded audio or included in the saved recording/transcript timing.
        if(samples<2400)provider.send(JSON.stringify({type:'input_audio_buffer.append',audio:base64(new Uint8Array((2400-samples)*2))}));
        provider.send(JSON.stringify({type:'input_audio_buffer.commit'}));return;
      }
      throw safeError('Invalid live transcription message.');
    }
    if(state!=='ready'||!(data instanceof ArrayBuffer)||data.byteLength===0||data.byteLength>FRAME_BYTES||data.byteLength%2!==0)
      throw safeError('Invalid live audio.');
    const count=data.byteLength/2;
    if(samples+count>maxSamples)throw safeError('This live section reached its recording limit.');
    if(provider.readyState!==1||provider.bufferedAmount>262144||socket.bufferedAmount>262144)throw safeError(UNAVAILABLE);
    provider.send(JSON.stringify({type:'input_audio_buffer.append',audio:base64(new Uint8Array(data))}));
    samples+=count;send({type:'audio_ack',samples});
  }
  socket.addEventListener('message',({data})=>{try{receive(data);}catch(error){abort(error);}});
  socket.addEventListener('close',()=>{if(!ending)void cleanup();});
  socket.addEventListener('error',()=>abort(safeError(UNAVAILABLE)));
  return {done,close:()=>cleanup()};
}

/** HTTP checks happen before accepting an upgrade or receiving any credential. */
export function createRealtimeHandler({env,store,upgrade,connectProvider,waitUntil=()=>{},...sessionOptions}) {
  const origins=new Set(String(env.ALLOWED_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean));
  const enter=createRequestLimit({concurrent:8});
  return async request=>{
    let release;
    try {
      const url=new URL(request.url);
      if(url.search||request.method!=='GET'||request.headers.get('upgrade')?.toLowerCase()!=='websocket')throw safeError('Invalid live transcription connection.',400);
      if(!origins.has(request.headers.get('origin')))throw safeError('This origin is not allowed.',403);
      if(env.COACHING_PROVIDER!=='openai'||!env.COACHING_API_KEY)throw safeError('Live transcription is unavailable.',503);
      release=enter();await store.admitRequest();
      const {socket,response}=upgrade(request);
      const session=attachRealtimeSession({socket,store,connectProvider,...sessionOptions});
      waitUntil(session.done.finally(release));release=null;
      return response;
    }catch(error) {
      release?.();
      return Response.json({error:error.safe?error.message:UNAVAILABLE},{status:error.safe?error.status:503,headers:{'Cache-Control':'no-store'}});
    }
  };
}
