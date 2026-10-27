import { analyzeSpeech, buildAnalysisPrompt, buildCoachingInstructions, coachingCompletion } from '../../../lib/analysis-core.mjs';
import { PROVIDERS, requestCoaching } from '../../../lib/providers.mjs';
import { createRequestLimit } from './request-limit.mjs';
import { CHAT_MODEL, buildChatPrompt, requestCoachChat } from '../../../lib/coach-chat.mjs';

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
        ...(error?.safe&&['failed','cancelled'].includes(error.jobState)?{jobState:error.jobState}:{})});
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
  // Exactly the browser encoder contract: no alternate chunks or metadata.
  if (label(0)!=='RIFF' || view.getUint32(4,true)!==buffer.byteLength-8 || label(8)!=='WAVE' || label(12)!=='fmt ' || view.getUint32(16,true)!==16 ||
      view.getUint16(20,true)!==1 || view.getUint16(22,true)!==1 || view.getUint32(24,true)!==16000 || view.getUint32(28,true)!==32000 ||
      view.getUint16(32,true)!==2 || view.getUint16(34,true)!==16 || label(36)!=='data' || view.getUint32(40,true)!==size || size%2) {
    throw fail('Re-import this audio through the app to prepare a compatible WAV recording.');
  }
  return number(size/32000,minDuration,maxDuration);
}
export function analysisInput(body, durationSeconds) {
  exact(body,['recordingId','requestId','text','targetScript','targetTalkingPoints','plannedIntroduction','plannedTransitions','instructorRubric','rubricFileName','assignmentInstructions','assignmentFileName','targetMode','speakerName','durationSeconds','useAI','rehearsalContext']);
  if (body.useAI !== undefined && body.useAI !== true) throw fail('Hosted analysis uses the managed AI coach.');
  if (body.targetMode !== undefined && !['points','script','both'].includes(body.targetMode)) throw fail('Choose a valid preparation view.');
  return {
    text:text(body.text,60000,true).trim(), targetScript:text(body.targetScript,30000),targetTalkingPoints:text(body.targetTalkingPoints,30000),
    plannedIntroduction:text(body.plannedIntroduction,8000),plannedTransitions:text(body.plannedTransitions,8000),instructorRubric:text(body.instructorRubric,40000),
    assignmentInstructions:text(body.assignmentInstructions,40000),assignmentFileName:text(body.assignmentFileName,255),
    rubricFileName:text(body.rubricFileName,255),speakerName:text(body.speakerName,100),targetMode:body.targetMode||'points',durationSeconds,useAI:true,
    ...(body.rehearsalContext===undefined?{}:{rehearsalContext:text(body.rehearsalContext,12000)}),
  };
}
export function chatInput(body) {
  exact(body,['requestId','recordingId','message','history','context']);
  const requestId=uuid(body.requestId),recordingId=body.recordingId===undefined?null:uuid(body.recordingId);
  const message=text(body.message,2000,true).trim();
  const history=body.history??[];
  if(!Array.isArray(history)||history.length>12)throw fail('Keep the chat to the twelve most recent messages.');
  let historySize=0;
  const messages=history.map(item=>{
    exact(item,['role','text']);
    if(!['user','assistant'].includes(item.role))throw fail('Use a supported chat message.');
    const value=text(item.text,4000,true);historySize+=value.length;
    return {role:item.role,text:value};
  });
  if(historySize>16000)throw fail('The chat history is too long. Start a new conversation.');
  const context=body.context??{};
  exact(context,['text','targetScript','targetTalkingPoints','plannedIntroduction','plannedTransitions','instructorRubric','assignmentInstructions','assignmentFileName','phase','selectedQuote']);
  if(context.phase!==undefined&&!['prepare','recording','review'].includes(context.phase))throw fail('Use a valid rehearsal stage.');
  return {requestId,recordingId,message,history:messages,context:{
    text:text(context.text,60000),targetScript:text(context.targetScript,30000),targetTalkingPoints:text(context.targetTalkingPoints,30000),
    plannedIntroduction:text(context.plannedIntroduction,8000),plannedTransitions:text(context.plannedTransitions,8000),instructorRubric:text(context.instructorRubric,40000),
    assignmentInstructions:text(context.assignmentInstructions,40000),assignmentFileName:text(context.assignmentFileName,255),
    phase:context.phase||'prepare',selectedQuote:text(context.selectedQuote,4000),
  }};
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
function reservation(value) { const cost=Number(value); return Number.isSafeInteger(cost)&&cost>0&&cost<=100000000?cost:null; }
async function hash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function metadata(row) { return {id:row.id,title:row.title,createdAt:row.created_at,durationSeconds:row.duration_seconds,sizeBytes:row.size_bytes,status:row.status}; }

/** All data access uses a verified server-derived user ID; store is injectable for tests. */
export function createHostedApi({ store, env, policyText, fetchImpl=fetch, coach=requestCoaching, chat=requestCoachChat, now=Date.now, cancellationPollMs=2000 }) {
  const enterRequest=createRequestLimit({now});
  // Whole recordings can occupy several buffers; keep those operations below
  // the isolate memory ceiling while small UI requests can still proceed.
  const enterAudio=createRequestLimit({now,concurrent:2});
  let globalPauseUntil=0;
  const policy=buildCoachingInstructions(policyText);
  const provider=env.COACHING_PROVIDER||'google', model=env.COACHING_MODEL||PROVIDERS[provider]?.defaultModel;
  if (!['openai','anthropic','google','deepseek','meta'].includes(provider) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(model||'')) throw new Error('Invalid coaching configuration.');
  const speechCost=75000, coachCost=reservation(env.COACHING_RESERVE_MICROUSD), liveCost=300000;
  const speechKey=provider==='openai'?env.COACHING_API_KEY:null;
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
    let job;
    try { job=await store.reserve(user.id,recordingId,requestId,kind,await hash(input),cost); }
    catch(error) { if(error?.safe&&error.notStarted===true)error.jobState='not_started';throw error; }
    if (job.state==='completed') return deliver(async emit=>{emit('cached_result');return job.response;});
    if (job.state!=='new') {
      if (job.state==='cancelled') throw cancellationError();
      const error=fail(job.state==='reserved'?'This request is still processing.':'This request already failed. Start a new request to retry.',409);
      if (job.state==='failed') error.jobState='failed';
      throw error;
    }
    return deliver(async emit=>{
      let completionStarted=false;
      const watching=watchCancellation(user.id,requestId);
      try {
        emit('accepted');
        await watching.ready;watching.signal.throwIfAborted();
        const result=await run(emit,watching.signal);
        watching.signal.throwIfAborted();watching.close();
        completionStarted=true;
        const saved=await store.completeRequest(user.id,requestId,result);
        emit('saved');
        return saved;
      } catch (error) {
        const failure=watching.signal.aborted?watching.signal.reason:error?.safe?error:fail('The service could not complete this request.',503);
        try {
          await store.finish(user.id,requestId,false,null);
          // A lost completion acknowledgement might already have committed success.
          if (!completionStarted && failure.jobState!=='cancelled') failure.jobState='failed';
        } catch { /* Preserve the request ID while persisted job state is uncertain. */ }
        throw failure;
      } finally { watching.close(); }
    });
  }
  function cancellationError() { return Object.assign(fail('This request was cancelled. You can start another rehearsal.',409),{jobState:'cancelled'}); }
  function watchCancellation(user,request) {
    const controller=new AbortController();let stopped=false,timer;
    const poll=async()=>{
      try {
        const job=await store.requestStatus(user,request);
        if (!stopped && job?.state!=='reserved') controller.abort(cancellationError());
      } catch(error) {
        if(!stopped)controller.abort(error?.safe?error:fail('Processing status could not be checked. Your recording is saved.',503));
      } finally {
        if(!stopped&&!controller.signal.aborted)timer=setTimeout(poll,cancellationPollMs);
      }
    };
    return {signal:controller.signal,ready:poll(),close(){stopped=true;clearTimeout(timer);}};
  }
  async function waitForLiveStop(user,id) {
    for(let attempt=0;attempt<6;attempt++) {
      let session;
      try { session=await store.liveGet(user,id); } catch(error) { if(error.status===404)return;throw error; }
      const pending=session.stream_segments?.find(segment=>segment.state==='reserved'&&Date.parse(segment.expiresAt)>now());
      if(!pending)return;
      if(attempt===5)throw fail('The recording is cancelled, but its streaming connection has not confirmed stopping. Try Cancel again.',503);
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  async function liveAction(request,path,user) {
    const draft=path.match(/^\/live-sessions\/([^/]+)\/draft-key\/([^/]+)$/);
    if(draft && request.method==='GET') {
      const id=uuid(draft[1]),requestId=uuid(draft[2]),result=await store.liveDraftKey(user.id,id,requestId);
      if(!/^[A-Za-z0-9_-]{43}$/.test(result?.draft_key||''))throw fail('The recording recovery key is unavailable.',503);
      return {recordingId:id,requestId,draftKey:result.draft_key};
    }
    const cancellation=path.match(/^\/live-sessions\/([^/]+)\/cancel$/);
    if (cancellation && request.method==='POST') {
      const body=await jsonBody(request);exact(body,['requestId']);
      const id=uuid(cancellation[1]),result=await store.liveCancel(user.id,id,uuid(body.requestId));
      if(result.status==='cancelled')await waitForLiveStop(user.id,id);
      return {recordingId:id,cancelled:true,status:result.status,audioSaved:result.audio_saved===true};
    }
    if (!speechKey) throw fail('Live cloud transcription is not configured yet.',503);
    if (path==='/live-sessions' && request.method==='POST') {
      const body=await jsonBody(request); exact(body,['recordingId','requestId','title']);
      const id=uuid(body.recordingId),requestId=uuid(body.requestId),title=text(body.title??'My rehearsal',120,true).trim();
      const session=await store.liveStart(user.id,id,requestId,title,await hash({mode:'openai-stream',recordingId:id,title}),liveCost);
      if (session.status!=='active'||!Number.isFinite(Date.parse(session.expires_at))||Date.parse(session.expires_at)<=now()) throw fail('This live rehearsal has ended. Start a new recording.',409);
      if(!/^[A-Za-z0-9_-]{43}$/.test(session.draft_key||''))throw fail('The recording recovery key is unavailable.',503);
      return {recordingId:id,storagePath:session.storage_path,bucket:'recordings',expiresAt:session.expires_at,transport:'websocket',sampleRate:24000,segmentSeconds:110,maxDurationSeconds:600,draftKey:session.draft_key};
    }
    const match=path.match(/^\/live-sessions\/([^/]+)(?:\/(finish))?$/);
    if (!match) throw fail('This live rehearsal action does not exist.',404);
    const id=uuid(match[1]),action=match[2];
    if (!action && request.method==='GET') {
      const session=await store.liveGet(user.id,id);
      return {recordingId:id,status:session.status,ready:session.transport==='openai-stream',nextSequence:session.next_sequence,transcript:session.transcript,expiresAt:session.expires_at};
    }
    if (!action && request.method==='DELETE') { await store.liveClose(user.id,id,true);await waitForLiveStop(user.id,id);return {recordingId:id,cancelled:true}; }
    if (request.method!=='POST') throw fail('This live rehearsal action does not exist.',404);
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
      return {recordingId:id,text:result.text,durationSeconds:actualDuration,chunks:[],model:'gpt-live-transcribe',localSpeech:false,complete:result.complete};
    }
    throw fail('This live rehearsal action does not exist.',404);
  }
  return async function handle(request) {
    const origin=request.headers.get('origin');
    const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
    if (origins.has(origin)) headers['Access-Control-Allow-Origin']=origin;
    const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
    let release,releaseAudio,validatingBatch=false;
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
        return json({hosted:true,configured:true,localSpeech:false,liveTranscription:Boolean(speechKey),liveTransport:'websocket',liveSegmentSeconds:110,liveTranscriptionModel:'gpt-live-transcribe',retention:'private',auth:{signedIn:Boolean(user)},
          speechConfigured:Boolean(speechKey),analysisConfigured:Boolean(env.COACHING_API_KEY&&coachCost),analysisProvider:provider,analysisProviderLabel:PROVIDERS[provider].label,analysisModel:model,
          transcriptionModel:'gpt-transcribe',providers:[],maxDurationSeconds:600,maxAudioBytes:MAX_AUDIO,
          chatConfigured:Boolean(provider==='openai'&&env.COACHING_API_KEY),chatModel:CHAT_MODEL});
      }
      const user=await identify(request);
      if(request.method==='POST'&&path==='/coach-chat') {
        const input=chatInput(await jsonBody(request));
        if(provider!=='openai'||!env.COACHING_API_KEY)throw fail('The rehearsal chat is not configured yet.',503);
        const row=input.recordingId?await store.owned(user.id,input.recordingId):null;
        if(input.recordingId&&(!row||row.status==='deleting'||row.upload_expired))throw fail('This recording was not found.',404);
        const originalInputHash=await hash(input);
        if(!input.context.text&&row?.transcript)input.context.text=row.transcript;
        if(input.context.selectedQuote&&!input.context.text.includes(input.context.selectedQuote))throw fail('Select a passage from the current transcript.');
        let prompt;try{prompt=buildChatPrompt(input,row?.report);}catch{throw fail('Shorten the assignment instructions, rubric, transcript, script, or chat history.',413);}
        const job=await store.chatReserve(user.id,input.recordingId,input.requestId,originalInputHash);
        if(job.state==='completed')throw Object.assign(fail('This reply was already processed but chat replies are not saved. Send again to request a new reply.',409),{jobState:'failed'});
        if(job.state!=='new') {
          const error=fail(job.state==='reserved'?'Your previous chat message is still processing.':'This message could not finish. Send a new message to try again.',409);
          if(job.state==='failed')error.jobState='failed';
          throw error;
        }
        const task=(async()=>{
          let completionStarted=false;
          try {
            const reply=await chat({apiKey:env.COACHING_API_KEY,prompt,fetchImpl,readBody:readLimited,
              onUsage:usage=>console.info(JSON.stringify({event:'chat_usage',model:CHAT_MODEL,...usage}))});
            if(typeof reply!=='string'||!reply.trim()||reply.length>4000)throw new Error('Invalid chat result');
            const result={requestId:input.requestId,reply:reply.trim(),model:CHAT_MODEL};
            completionStarted=true;
            await store.chatComplete(user.id,input.requestId);
            return json(result);
          } catch(error) {
            const failure=error?.safe?error:fail('Your coach could not reply just now. Your recording and feedback are unchanged. Try again shortly.',502);
            try { await store.chatFail(user.id,input.requestId);if(!completionStarted)failure.jobState='failed'; } catch {}
            throw failure;
          }
        })();
        // A closed tab must not turn an already admitted reply into extra spend.
        globalThis.EdgeRuntime?.waitUntil(task.catch(()=>{}));
        return await task;
      }
      const cancelRequest=path.match(/^\/requests\/([^/]+)\/cancel$/);
      if(cancelRequest&&request.method==='POST'){
        const body=await jsonBody(request);exact(body,['recordingId']);
        const id=uuid(cancelRequest[1]),recordingId=uuid(body.recordingId),job=await store.cancelRequest(user.id,recordingId,id);
        return json({requestId:id,recordingId,cancelled:true,state:job.state});
      }
      const requestStatus=path.match(/^\/requests\/([^/]+)$/);
      if (requestStatus && request.method==='GET') {
        const id=uuid(requestStatus[1]),job=await store.requestStatus(user.id,id);
        if (!job) throw fail('This request was not found.',404);
        return json({requestId:id,recordingId:job.recording_id,kind:job.kind,state:job.state,
          createdAt:job.created_at,finishedAt:job.finished_at,result:job.state==='completed'?job.response:null});
      }
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
        validatingBatch=true;
        const body=await jsonBody(request),id=uuid(body.recordingId),requestId=uuid(body.requestId);
        const row=await store.owned(user.id,id);
        if (!row || row.status==='deleting') throw fail('This recording was not found.',404);
        if (path==='/transcribe') {
          exact(body,['recordingId','requestId']);
          if (!speechKey) throw fail('Cloud speech is not configured yet.',503);
          validatingBatch=false;
          return await paid(user,id,requestId,'transcribe',{recordingId:id},speechCost,async (emit,signal)=>{
            const blob=await store.audio(row.storage_path);
            if (blob.size!==row.size_bytes || blob.size>MAX_AUDIO) throw fail('The stored audio does not match this recording. Upload it again.');
            const audio=await blob.arrayBuffer(),durationSeconds=inspectHostedWav(audio);
            emit('audio_validated');
            try {
              signal.throwIfAborted();
              emit('speech_requested');
              const form=new FormData();
              form.set('model','gpt-transcribe');form.set('file',new Blob([audio],{type:'audio/wav'}),'rehearsal.wav');
              form.set('prompt','Verbatim presentation rehearsal. Preserve spoken filler words, repetitions, and false starts; do not rewrite or improve the speech.');
              const response=await fetchImpl('https://api.openai.com/v1/audio/transcriptions',{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${speechKey}`},body:form,signal:AbortSignal.any([signal,AbortSignal.timeout(125000)])});
              if (!response.ok) throw fail('Cloud transcription is unavailable. Try again shortly.',response.status===429?429:502);
              let result; try { result=JSON.parse(new TextDecoder().decode(await readLimited(response,512*1024))); } catch { throw fail('The speech service returned an unreadable response.',502); }
              if (typeof result.text!=='string' || !result.text.trim() || result.text.length>60000) throw fail('The speech service returned an invalid transcript.',502);
              emit('transcript_received');
              const output={text:result.text.trim(),durationSeconds,chunks:[],model:'gpt-transcribe',localSpeech:false,recordingId:id};
              return output;
            } catch (error) {
              signal.throwIfAborted();
              if (error.safe) throw error;
              throw fail('Cloud transcription timed out or could not be reached. Your recording is saved.',502);
            }
          },deliver);
        }
        if (!env.COACHING_API_KEY || !coachCost) throw fail('The managed AI coach is not configured yet.',503);
        if (!row.transcript) throw fail('Create a transcript for this recording before requesting coaching.',409);
        const input=analysisInput(body,row.duration_seconds);
        let prompt; try { prompt=buildAnalysisPrompt(input,policy); } catch { throw fail('Add a readable transcript and valid preparation text.'); }
        if (new TextEncoder().encode(prompt).byteLength>256*1024) throw fail('Shorten the assignment instructions, rubric, script, or preparation notes.',413);
        validatingBatch=false;
        return await paid(user,id,requestId,'coach',input,coachCost,async (emit,signal)=>{
          let feedback, coachingUsage;
          const coachingStarted=performance.now();
          emit('coach_requested');
          try { feedback=await coach({provider,model,apiKey:env.COACHING_API_KEY,workspaceId:env.COACHING_WORKSPACE_ID,prompt,fetchImpl,browser:false,signal,onUsage:usage=>{
            coachingUsage={...usage,elapsedMs:Math.round(performance.now()-coachingStarted)};
            console.info(JSON.stringify({event:'coaching_usage',provider,model,...coachingUsage}));
          }}); }
          catch { signal.throwIfAborted();throw fail('The AI coach is unavailable. Your recording is saved; try again later.',502); }
          emit('feedback_received');
          const report=analyzeSpeech({...input,aiFeedback:feedback});
          if (report.analysis.method!=='ai') throw fail('The AI coach returned an incomplete report. Your recording is saved.',502);
          emit('feedback_validated');
          const completion=coachingCompletion(report.analysis);
          const {rehearsalContext:_conversation,...savedInput}=input;
          const output={...report,transcript:input.text,warnings:completion.warnings,meta:{...savedInput,text:undefined,useAI:undefined,generatedAt:new Date().toISOString(),analysisProvider:provider,analysisProviderLabel:PROVIDERS[provider].label,analysisModel:model,coachingStatus:completion.status,missingCoachingCriteria:completion.missingCriteria,localSpeech:false,recordingId:id,...(coachingUsage?{coachingUsage}:{})}};
          return output;
        },deliver);
      }
      throw fail('This app action does not exist.',404);
    } catch (error) {
      if(validatingBatch&&error?.safe&&[400,404,409,413,415].includes(error.status))error.jobState='not_started';
      if(error?.safe&&error.retryAfter) headers['Retry-After']=String(Math.min(60,Math.max(1,Math.ceil(Number(error.retryAfter)||60))));
      return json({error:error?.safe?error.message:'The service could not complete this request.',...(error?.safe&&['failed','cancelled','not_started'].includes(error.jobState)?{jobState:error.jobState}:{})},error?.safe?error.status:503);
    } finally { releaseAudio?.();release?.(); }
  };
}
