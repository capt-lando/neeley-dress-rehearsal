import { analyzeSpeech, buildAnalysisPrompt, buildCoachingInstructions, coachingCompletion } from '../../../lib/analysis-core.mjs';
import { PROVIDERS, requestCoaching } from '../../../lib/providers.mjs';
import { createRequestLimit } from './request-limit.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AUDIO = 20 * 1024 * 1024;
const EVENT_NAMES = ['session_started','section_engaged','recording_completed','analysis_requested','analysis_completed','analysis_failed'];
const SECTIONS = ['prepare','rehearse','feedback'];
export function fail(message, status = 400) { return Object.assign(new Error(message), { status, safe: true }); }
function progressResponse(run, headers, release) {
  let controller, closed=false;
  const encoder=new TextEncoder();
  const body=new ReadableStream({start(value){controller=value;},cancel(){closed=true;}});
  const send=value=>{if(!closed)try{controller.enqueue(encoder.encode(JSON.stringify(value)+'\n'));}catch{closed=true;}};
  const task=(async()=>{
    try { send({type:'result',data:await run(stage=>send({type:'progress',stage}))}); }
    catch(error) {
      send({type:'error',error:error?.safe?error.message:'The service could not complete this request.',status:error?.safe?error.status:503,
        ...(error?.safe&&error.jobState==='failed'?{jobState:'failed'}:{})});
    } finally {
      if(!closed){closed=true;controller.close();}
      release();
    }
  })();
  // Keep the admitted job and its guards alive after a client disconnects; its
  // bounded provider call still saves once and can be recovered with the same ID.
  globalThis.EdgeRuntime?.waitUntil(task);
  return new Response(body,{headers:{...headers,'Content-Type':'application/x-ndjson','X-Accel-Buffering':'no'}});
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('The request contains unsupported fields.');
}
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) throw fail('Use a valid request or recording ID.'); return value.toLowerCase(); }
function number(value, min, max) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail('A numeric value is outside its allowed range.'); return value; }
function text(value, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw fail('A text field is missing or too long.');
  return value;
}
export async function readLimited(response, limit, timeoutMs = 20000) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(fail('The request or response body timed out.', 408)), timeoutMs);
  });
  try {
    if (Number(response.headers.get('content-length')) > limit) throw fail('The request or response is too large.', 413);
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]); if (done) break;
      size += value.length; if (size > limit) throw fail('The request or response is too large.', 413);
      chunks.push(value);
    }
  } catch (error) {
    // Cancellation itself can stall on an untrusted stream; never await it.
    void reader.cancel().catch(() => {});
    throw error;
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}
async function jsonBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw fail('Send this request as JSON.', 415);
  try {
    const value=JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readLimited(request, 512 * 1024)));
    if (!value || typeof value!=='object' || Array.isArray(value)) throw fail('Send a JSON object.');
    return value;
  }
  catch (error) { if (error.safe) throw error; throw fail('The request was not valid JSON.'); }
}
export function inspectHostedWav(buffer, minDuration = 0.5, maxDuration = 600) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 44 || buffer.byteLength > MAX_AUDIO) throw fail('Use a WAV recording of up to 10 minutes.');
  const view = new DataView(buffer), label = at => String.fromCharCode(...new Uint8Array(buffer, at, 4));
  const size=buffer.byteLength-44;
  // Exactly the browser encoder / worker contract: no alternate chunks or metadata.
  if (label(0)!=='RIFF' || view.getUint32(4,true)!==buffer.byteLength-8 || label(8)!=='WAVE' || label(12)!=='fmt ' || view.getUint32(16,true)!==16 ||
      view.getUint16(20,true)!==1 || view.getUint16(22,true)!==1 || view.getUint32(24,true)!==16000 || view.getUint32(28,true)!==32000 ||
      view.getUint16(32,true)!==2 || view.getUint16(34,true)!==16 || label(36)!=='data' || view.getUint32(40,true)!==size || size%2) {
    throw fail('Re-import this audio through the app to prepare a compatible WAV recording.');
  }
  return number(size/32000,minDuration,maxDuration);
}
export function analysisInput(body, durationSeconds) {
  exact(body,['recordingId','requestId','text','targetScript','targetTalkingPoints','plannedIntroduction','plannedTransitions','instructorRubric','rubricFileName','targetMode','speakerName','durationSeconds','useAI']);
  if (body.useAI !== undefined && body.useAI !== true) throw fail('Hosted analysis uses the managed AI coach.');
  if (body.targetMode !== undefined && !['points','script','both'].includes(body.targetMode)) throw fail('Choose a valid preparation view.');
  return {
    text:text(body.text,60000,true).trim(), targetScript:text(body.targetScript,30000),targetTalkingPoints:text(body.targetTalkingPoints,30000),
    plannedIntroduction:text(body.plannedIntroduction,8000),plannedTransitions:text(body.plannedTransitions,8000),instructorRubric:text(body.instructorRubric,40000),
    rubricFileName:text(body.rubricFileName,255),speakerName:text(body.speakerName,100),targetMode:body.targetMode||'points',durationSeconds,useAI:true,
  };
}
export function validateEvents(body) {
  exact(body,['events']);
  if (!Array.isArray(body.events) || body.events.length<1 || body.events.length>20) throw fail('Send between one and twenty usage events.');
  return body.events.map(event => {
    exact(event,['id','sessionId','name','section','activeSeconds']);
    if (!EVENT_NAMES.includes(event.name) || !SECTIONS.includes(event.section)) throw fail('Use a supported usage event.');
    const activeSeconds = number(event.activeSeconds ?? 0,0,60);
    if (event.name !== 'section_engaged' && activeSeconds !== 0) throw fail('Only engagement events include active time.');
    return { id:uuid(event.id),sessionId:uuid(event.sessionId),name:event.name,section:event.section,activeSeconds };
  });
}
function secureWorker(env) {
  if (!env.BARK_WORKER_URL) return null;
  let url; try { url = new URL(env.BARK_WORKER_URL); } catch { throw new Error('Invalid worker configuration.'); }
  const hosts = String(env.BARK_WORKER_ALLOWED_HOSTS||'').split(',').map(x=>x.trim()).filter(Boolean);
  if (url.protocol!=='https:' || url.username || url.password || url.port || url.search || url.hash || !hosts.includes(url.hostname) || !env.BARK_WORKER_TOKEN) throw new Error('Invalid worker configuration.');
  if (Boolean(env.BARK_WORKER_MODAL_KEY)!==Boolean(env.BARK_WORKER_MODAL_SECRET)) throw new Error('Both Modal proxy credentials are required.');
  return url.href;
}
function reservation(value) { const cost=Number(value); return Number.isSafeInteger(cost)&&cost>0&&cost<=100000000?cost:null; }
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function metadata(row) { return {id:row.id,title:row.title,createdAt:row.created_at,durationSeconds:row.duration_seconds,sizeBytes:row.size_bytes,status:row.status}; }

/** All data access uses a verified server-derived user ID; store is injectable for tests. */
export function createHostedApi({ store, env, policyText, fetchImpl=fetch, coach=requestCoaching, now=Date.now }) {
  const enterRequest=createRequestLimit({now});
  // Whole recordings can occupy several buffers; keep those operations below
  // the isolate memory ceiling while small UI requests can still proceed.
  const enterAudio=createRequestLimit({now,concurrent:2});
  let globalPauseUntil=0;
  const policy=buildCoachingInstructions(policyText), worker=secureWorker(env);
  const provider=env.COACHING_PROVIDER||'google', model=env.COACHING_MODEL||PROVIDERS[provider]?.defaultModel;
  if (!['openai','anthropic','google','deepseek','meta'].includes(provider) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(model||'')) throw new Error('Invalid coaching configuration.');
  const speechCost=reservation(env.BARK_RESERVE_MICROUSD), coachCost=reservation(env.COACHING_RESERVE_MICROUSD), liveCost=reservation(env.BARK_LIVE_RESERVE_MICROUSD);
  const origins=new Set(String(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean));
  for (const origin of origins) {
    const url=new URL(origin);
    if (url.origin!==origin || url.protocol!=='https:' && !(url.protocol==='http:' && ['127.0.0.1','localhost'].includes(url.hostname))) throw new Error('Invalid allowed origin.');
  }
  async function identify(request, optional=false) {
    const authorization=request.headers.get('authorization');
    if (!authorization && optional) return null;
    if (!authorization?.startsWith('Bearer ') || authorization.length>16384) throw fail('Sign in with Google or Microsoft to continue.',401);
    const token=authorization.slice(7), user=await store.verifyUser(token);
    if (!user || !UUID.test(user.id||'')) throw fail('Your session expired. Sign in again.',401);
    let claims;
    try { claims=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); } catch { throw fail('Your session is invalid. Sign in again.',401); }
    // getUser above validates this JWT before any claims are used for authorization.
    const identities=Array.isArray(user.identities)?user.identities:[];
    if (claims.sub!==user.id || !claims.amr?.some(item=>item?.method==='oauth') || !identities.some(identity=>['google','azure'].includes(identity.provider)) ||
        identities.some(identity=>!['google','azure','email'].includes(identity.provider))) throw fail('Use Google or Microsoft sign-in for this pilot.',403);
    await store.admitRequest(user.id);
    await store.profile(user.id);
    return {id:user.id};
  }
  async function paid(user,recordingId,requestId,kind,input,cost,run,deliver) {
    if (!cost) throw fail('The pilot service is not configured yet.',503);
    const job=await store.reserve(user.id,recordingId,requestId,kind,await hash(input),cost);
    if (job.state==='completed') return deliver(async emit=>{emit('cached_result');return job.response;});
    if (job.state!=='new') {
      const error=fail(job.state==='reserved'?'This request is still processing.':'This request already failed. Start a new request to retry.',409);
      if (job.state==='failed') error.jobState='failed';
      throw error;
    }
    return deliver(async emit=>{
      let completionStarted=false;
      try {
        emit('accepted');
        const result=await run(emit);
        completionStarted=true;
        await store.finish(user.id,requestId,true,result);
        emit('saved');
        return result;
      } catch (error) {
        const failure=error?.safe?error:fail('The service could not complete this request.',503);
        try {
          await store.finish(user.id,requestId,false,null);
          // A lost completion acknowledgement might already have committed success.
          if (!completionStarted) failure.jobState='failed';
        } catch { /* Preserve the request ID while persisted job state is uncertain. */ }
        throw failure;
      }
    });
  }
  async function liveWorker(path, audio) {
    const response=await fetchImpl(new URL(path,worker).href,{method:'POST',redirect:'error',headers:{
      Authorization:`Bearer ${env.BARK_WORKER_TOKEN}`,...(audio?{'Content-Type':'audio/wav'}:{}),
      ...(env.BARK_WORKER_MODAL_KEY?{'Modal-Key':env.BARK_WORKER_MODAL_KEY,'Modal-Secret':env.BARK_WORKER_MODAL_SECRET}:{})},
      ...(audio?{body:audio}:{}),signal:AbortSignal.timeout(125000)});
    if (!response.ok) throw fail('Live transcription is unavailable. Your recording remains in this tab; save and transcribe the complete take.',response.status===429?429:502);
    try { return JSON.parse(new TextDecoder().decode(await readLimited(response,512*1024))); }
    catch { throw fail('The speech worker returned an unreadable response.',502); }
  }
  async function liveAction(request,path,user) {
    if (!worker || !liveCost) throw fail('Live cloud transcription is not configured yet.',503);
    if (path==='/live-sessions' && request.method==='POST') {
      const body=await jsonBody(request); exact(body,['recordingId','requestId','title']);
      const id=uuid(body.recordingId),requestId=uuid(body.requestId),title=text(body.title??'My rehearsal',120,true).trim();
      const session=await store.liveStart(user.id,id,requestId,title,await hash({mode:'live',recordingId:id,title}),liveCost);
      if (session.status!=='active') throw fail('This live rehearsal has ended. Start a new recording.',409);
      return {recordingId:id,storagePath:session.storage_path,bucket:'recordings',expiresAt:session.expires_at,chunkSeconds:10,maxDurationSeconds:600};
    }
    const match=path.match(/^\/live-sessions\/([^/]+)(?:\/(prepare|finish|chunks\/([0-9]+)))?$/);
    if (!match) throw fail('This live rehearsal action does not exist.',404);
    const id=uuid(match[1]),action=match[2];
    if (!action && request.method==='GET') {
      const session=await store.liveGet(user.id,id);
      return {recordingId:id,status:session.status,ready:session.prepare_state==='completed',nextSequence:session.next_sequence,transcript:session.transcript,expiresAt:session.expires_at};
    }
    if (!action && request.method==='DELETE') { await store.liveClose(user.id,id,true); return {recordingId:id,cancelled:true}; }
    if (request.method!=='POST') throw fail('This live rehearsal action does not exist.',404);
    if (action==='prepare') {
      if ((await readLimited(request,0)).length) throw fail('Preparation does not accept a request body.');
      const claim=await store.livePrepare(user.id,id);
      if (claim.state==='completed') return {recordingId:id,ready:true,model:'bark-3.0-plus'};
      if (claim.state!=='new') throw fail('The speech model is still preparing. Please wait.',409);
      try {
        const result=await liveWorker('prepare');
        if (result.ready!==true || result.model!=='bark-3.0-plus') throw fail('The speech worker could not prepare the model.',502);
        await store.livePrepared(user.id,id);
        return {recordingId:id,ready:true,model:'bark-3.0-plus'};
      } catch (error) {
        await store.liveClose(user.id,id).catch(()=>{});
        throw error?.safe?error:fail('Live preparation timed out. Your audio remains in this tab; save the complete take.',502);
      }
    }
    if (action?.startsWith('chunks/')) {
      const sequence=number(Number(match[3]),0,59),finalHeader=request.headers.get('x-rehearsal-final');
      if (finalHeader!==null && finalHeader!=='true') throw fail('Use a valid final-section flag.');
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='audio/wav') throw fail('Send live sections as WAV audio.',415);
      const bytes=await readLimited(request,320044),audio=bytes.buffer,final=finalHeader==='true';
      const durationSeconds=inspectHostedWav(audio,1/16000,10),samples=(bytes.byteLength-44)/2;
      if (!final && samples!==160000) throw fail('Ordinary live sections must contain ten seconds; mark the shorter ending as final.');
      const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',audio))].map(x=>x.toString(16).padStart(2,'0')).join('');
      const claim=await store.liveChunk(user.id,id,sequence,digest,samples,final);
      let text=claim.text;
      if (claim.state!=='completed') {
        if (claim.state!=='new') throw fail('This section is still processing. Retry the same section after it finishes.',409);
        try {
          const result=await liveWorker('transcribe-live',audio);
          if (result.model!=='bark-3.0-plus' || typeof result.text!=='string' || result.text.length>60000 || typeof result.durationSeconds!=='number' || Math.abs(result.durationSeconds-durationSeconds)>1/16000) throw fail('The speech worker returned an invalid live transcript.',502);
          text=(await store.liveChunkDone(user.id,id,sequence,result.text.trim())).text;
        } catch (error) {
          await store.liveClose(user.id,id).catch(()=>{});
          throw error?.safe?error:fail('Live transcription timed out. Save your recording and transcribe the complete take.',502);
        }
      }
      const session=await store.liveGet(user.id,id);
      // Replayed old chunks reproduce only the transcript through that sequence.
      const transcript=session.chunks.slice(0,sequence+1).map(chunk=>chunk.text||'').filter(Boolean).join(' ');
      return {recordingId:id,sequence,text,durationSeconds,transcript,nextSequence:sequence+1};
    }
    if (action==='finish') {
      const body=await jsonBody(request); exact(body,['durationSeconds','sizeBytes']);
      const duration=number(body.durationSeconds,0.5,600),size=number(body.sizeBytes,16044,MAX_AUDIO);
      const session=await store.liveGet(user.id,id),row=await store.owned(user.id,id);
      if (!row || row.status==='deleting') throw fail('This recording was not found.',404);
      const audio=await store.audio(row.storage_path);
      if (audio.size!==size) throw fail('The stored audio does not match the completed take.');
      const actualDuration=inspectHostedWav(await audio.arrayBuffer());
      if (Math.abs(actualDuration-duration)>1/16000) throw fail('The recording duration does not match its audio.');
      const result=await store.liveFinish(user.id,id,actualDuration,audio.size);
      return {recordingId:id,text:result.text,durationSeconds:actualDuration,chunks:[],model:'bark-3.0-plus',localSpeech:false,complete:result.complete};
    }
    throw fail('This live rehearsal action does not exist.',404);
  }
  return async function handle(request) {
    const origin=request.headers.get('origin');
    const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
    if (origins.has(origin)) headers['Access-Control-Allow-Origin']=origin;
    const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
    let release,releaseAudio;
    const deliver=async run=>{
      if(request.headers.get('accept')!=='application/x-ndjson') return json(await run(()=>{}));
      const releaseRequest=release,releaseWork=releaseAudio;
      release=releaseAudio=undefined;
      return progressResponse(run,headers,()=>{releaseWork?.();releaseRequest?.();});
    };
    try {
      release=enterRequest();
      if (!origins.has(origin)) throw fail('This origin is not allowed.',403);
      if (request.method==='OPTIONS') return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-rehearsal-final','Access-Control-Max-Age':'600'}});
      const url=new URL(request.url), path=url.pathname.replace(/^\/(?:functions\/v1\/)?rehearsal-api(?=\/|$)/,'');
      if (url.search) throw fail('Query parameters are not supported.');
      if (!['GET','POST','DELETE'].includes(request.method)) throw fail('This method is not allowed.',405);
      const publicConfig=request.method==='GET'&&path==='/config';
      const authorization=request.headers.get('authorization');
      if ((!publicConfig||authorization)&&(!authorization?.startsWith('Bearer ')||authorization.length>16384||!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization))) throw fail('Sign in with Google or Microsoft to continue.',401);
      if (globalPauseUntil>now()) throw Object.assign(fail('The service is receiving too many requests. Please try again shortly.',429),{retryAfter:Math.ceil((globalPauseUntil-now())/1000)});
      try { await store.admitRequest(); }
      catch(error) {
        if(error?.safe&&error.status===429) globalPauseUntil=now()+Math.min(60,Math.max(1,Number(error.retryAfter)||60))*1000;
        throw error;
      }
      if (request.method==='GET' && path==='/config') {
        const user=await identify(request,true);
        return json({hosted:true,configured:true,localSpeech:false,liveTranscription:Boolean(worker&&liveCost),liveChunkSeconds:10,retention:'private',auth:{signedIn:Boolean(user)},
          speechConfigured:Boolean(worker&&speechCost),analysisConfigured:Boolean(env.COACHING_API_KEY&&coachCost),analysisProvider:provider,analysisProviderLabel:PROVIDERS[provider].label,analysisModel:model,
          transcriptionModel:'bark-3.0-plus',providers:[],maxDurationSeconds:600,maxAudioBytes:MAX_AUDIO});
      }
      const user=await identify(request);
      if(request.method==='POST'&&(path==='/transcribe'||/^\/recordings\/[^/]+\/audio$/.test(path)||/^\/live-sessions\/[^/]+\/finish$/.test(path))) releaseAudio=enterAudio();
      if (path==='/live-sessions' || path.startsWith('/live-sessions/')) return json(await liveAction(request,path,user));
      if (request.method==='GET' && path==='/recordings') return json({recordings:(await store.list(user.id)).map(metadata)});
      if (request.method==='POST' && path==='/recordings') {
        const body=await jsonBody(request); exact(body,['id','title','durationSeconds','sizeBytes']);
        const id=uuid(body.id), title=text(body.title,120,true).trim(),duration=number(body.durationSeconds,0.5,600),size=number(body.sizeBytes,44,MAX_AUDIO);
        if (!Number.isInteger(size)) throw fail('Use a whole-byte file size.');
        const row=await store.create(user.id,id,title,duration,size);
        return json({id:row.id,storagePath:row.storage_path,bucket:'recordings'},201);
      }
      const upload=path.match(/^\/recordings\/([^/]+)\/audio$/);
      if (upload && request.method==='POST') {
        const id=uuid(upload[1]),row=await store.owned(user.id,id);
        if (!row || row.upload_expired) throw fail('This recording was not found.',404);
        if (row.status!=='pending' || Date.parse(row.upload_expires_at)<=now()) throw fail('This recording no longer accepts uploads.',409);
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='audio/wav') throw fail('Re-import this audio through the app before saving it.',415);
        const bytes=await readLimited(request,MAX_AUDIO),durationSeconds=inspectHostedWav(bytes.buffer);
        try { await store.uploadAudio(row.storage_path,bytes); }
        catch (error) {
          if (!error.safe || error.status!==409) throw error;
          // A lost acknowledgement may be retried, but can never replace a take.
          const prior=await store.audio(row.storage_path);
          if (prior.size!==bytes.byteLength) throw fail('This recording already contains different audio.',409);
          const existing=new Uint8Array(await prior.arrayBuffer());
          if (!existing.every((value,index)=>value===bytes[index])) throw fail('This recording already contains different audio.',409);
        }
        await store.update(user.id,id,{duration_seconds:durationSeconds,size_bytes:bytes.byteLength});
        return json({id,stored:true,durationSeconds,sizeBytes:bytes.byteLength},201);
      }
      const detail=path.match(/^\/recordings\/([^/]+)$/);
      if (detail && ['GET','DELETE'].includes(request.method)) {
        const id=uuid(detail[1]); const row=await store.owned(user.id,id);
        if (!row) throw fail('This recording was not found.',404);
        if (request.method==='DELETE') { await store.remove(user.id,id); return json({deleted:true}); }
        if (row.status==='deleting') throw fail('This recording is being deleted.',409);
        return json({recording:{...metadata(row),transcript:row.transcript||'',report:row.report||null},audioUrl:await store.signAudio(row.storage_path,60)});
      }
      if (request.method==='POST' && path==='/events') return json({accepted:await store.events(user.id,validateEvents(await jsonBody(request)))});
      if (request.method==='POST' && ['/transcribe','/analyze-text'].includes(path)) {
        const body=await jsonBody(request),id=uuid(body.recordingId),requestId=uuid(body.requestId);
        const row=await store.owned(user.id,id);
        if (!row || row.status==='deleting') throw fail('This recording was not found.',404);
        if (path==='/transcribe') {
          exact(body,['recordingId','requestId']);
          if (!worker || !speechCost) throw fail('Cloud speech is not configured yet.',503);
          return await paid(user,id,requestId,'transcribe',{recordingId:id},speechCost,async emit=>{
            const blob=await store.audio(row.storage_path);
            if (blob.size!==row.size_bytes || blob.size>MAX_AUDIO) throw fail('The stored audio does not match this recording. Upload it again.');
            const audio=await blob.arrayBuffer(),durationSeconds=inspectHostedWav(audio);
            emit('audio_validated');
            await store.update(user.id,id,{status:'transcribing'});
            try {
              emit('speech_requested');
              const response=await fetchImpl(worker,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${env.BARK_WORKER_TOKEN}`,'Content-Type':'audio/wav',
                ...(env.BARK_WORKER_MODAL_KEY?{'Modal-Key':env.BARK_WORKER_MODAL_KEY,'Modal-Secret':env.BARK_WORKER_MODAL_SECRET}:{})},body:audio,signal:AbortSignal.timeout(125000)});
              if (!response.ok) throw fail('Cloud transcription is unavailable. Try again shortly.',response.status===429?429:502);
              let result; try { result=JSON.parse(new TextDecoder().decode(await readLimited(response,512*1024))); } catch { throw fail('The speech worker returned an unreadable response.',502); }
              if (result.model!=='bark-3.0-plus' || typeof result.text!=='string' || !result.text.trim() || result.text.length>60000 || typeof result.durationSeconds!=='number' || Math.abs(result.durationSeconds-durationSeconds)>0.1) throw fail('The speech worker returned an invalid transcript.',502);
              emit('transcript_received');
              const output={text:result.text.trim(),durationSeconds,chunks:[],model:'bark-3.0-plus',localSpeech:false,recordingId:id};
              await store.update(user.id,id,{status:'transcribed',transcript:output.text,duration_seconds:durationSeconds,report:null});
              return output;
            } catch (error) {
              await store.update(user.id,id,{status:'failed'});
              if (error.safe) throw error;
              throw fail('Cloud transcription timed out or could not be reached. Your recording is saved.',502);
            }
          },deliver);
        }
        if (!env.COACHING_API_KEY || !coachCost) throw fail('The managed AI coach is not configured yet.',503);
        if (!row.transcript) throw fail('Create a transcript for this recording before requesting coaching.',409);
        const input=analysisInput(body,row.duration_seconds);
        let prompt; try { prompt=buildAnalysisPrompt(input,policy); } catch { throw fail('Add a readable transcript and valid preparation text.'); }
        if (new TextEncoder().encode(prompt).byteLength>256*1024) throw fail('Shorten the script, rubric, or preparation notes.',413);
        return await paid(user,id,requestId,'coach',input,coachCost,async emit=>{
          let feedback, coachingUsage;
          const coachingStarted=performance.now();
          emit('coach_requested');
          try { feedback=await coach({provider,model,apiKey:env.COACHING_API_KEY,workspaceId:env.COACHING_WORKSPACE_ID,prompt,fetchImpl,browser:false,onUsage:usage=>{
            coachingUsage={...usage,elapsedMs:Math.round(performance.now()-coachingStarted)};
            console.info(JSON.stringify({event:'coaching_usage',provider,model,...coachingUsage}));
          }}); }
          catch { throw fail('The AI coach is unavailable. Your recording is saved; try again later.',502); }
          emit('feedback_received');
          const report=analyzeSpeech({...input,aiFeedback:feedback});
          if (report.analysis.method!=='ai') throw fail('The AI coach returned an incomplete report. Your recording is saved.',502);
          emit('feedback_validated');
          const completion=coachingCompletion(report.analysis);
          const output={...report,transcript:input.text,warnings:completion.warnings,meta:{...input,text:undefined,useAI:undefined,generatedAt:new Date().toISOString(),analysisProvider:provider,analysisProviderLabel:PROVIDERS[provider].label,analysisModel:model,coachingStatus:completion.status,missingCoachingCriteria:completion.missingCriteria,localSpeech:false,recordingId:id,...(coachingUsage?{coachingUsage}:{})}};
          await store.update(user.id,id,{status:'analyzed',transcript:input.text,report:output});
          return output;
        },deliver);
      }
      throw fail('This app action does not exist.',404);
    } catch (error) {
      if(error?.safe&&error.retryAfter) headers['Retry-After']=String(Math.min(60,Math.max(1,Math.ceil(Number(error.retryAfter)||60))));
      return json({error:error?.safe?error.message:'The service could not complete this request.',...(error?.safe&&error.jobState==='failed'?{jobState:'failed'}:{})},error?.safe?error.status:503);
    } finally { releaseAudio?.();release?.(); }
  };
}
