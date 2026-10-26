import { analyzeSpeech, buildAnalysisPrompt, buildCoachingInstructions } from '../../../lib/analysis-core.mjs';
import { PROVIDERS, requestCoaching } from '../../../lib/providers.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AUDIO = 20 * 1024 * 1024;
const EVENT_NAMES = ['session_started','section_engaged','recording_completed','analysis_requested','analysis_completed','analysis_failed'];
const SECTIONS = ['prepare','rehearse','feedback'];
export function fail(message, status = 400) { return Object.assign(new Error(message), { status, safe: true }); }
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
async function readLimited(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw fail('The request or response is too large.', 413);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) { await reader.cancel(); throw fail('The request or response is too large.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
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
export function inspectHostedWav(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 44 || buffer.byteLength > MAX_AUDIO) throw fail('Use a WAV recording of up to 10 minutes.');
  const view = new DataView(buffer), label = at => String.fromCharCode(...new Uint8Array(buffer, at, 4));
  const size=buffer.byteLength-44;
  // Exactly the browser encoder / worker contract: no alternate chunks or metadata.
  if (label(0)!=='RIFF' || view.getUint32(4,true)!==buffer.byteLength-8 || label(8)!=='WAVE' || label(12)!=='fmt ' || view.getUint32(16,true)!==16 ||
      view.getUint16(20,true)!==1 || view.getUint16(22,true)!==1 || view.getUint32(24,true)!==16000 || view.getUint32(28,true)!==32000 ||
      view.getUint16(32,true)!==2 || view.getUint16(34,true)!==16 || label(36)!=='data' || view.getUint32(40,true)!==size || size%2) {
    throw fail('Re-import this audio through the app to prepare a compatible WAV recording.');
  }
  return number(size/32000,0.5,600);
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
export function createHostedApi({ store, env, policyText, fetchImpl=fetch, coach=requestCoaching }) {
  const policy=buildCoachingInstructions(policyText), worker=secureWorker(env);
  const provider=env.COACHING_PROVIDER||'google', model=env.COACHING_MODEL||PROVIDERS[provider]?.defaultModel;
  if (!['openai','anthropic','google','deepseek','meta'].includes(provider) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(model||'')) throw new Error('Invalid coaching configuration.');
  const speechCost=reservation(env.BARK_RESERVE_MICROUSD), coachCost=reservation(env.COACHING_RESERVE_MICROUSD);
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
    await store.profile(user.id);
    return {id:user.id};
  }
  async function paid(user,recordingId,requestId,kind,input,cost,run) {
    if (!cost) throw fail('The pilot service is not configured yet.',503);
    const job=await store.reserve(user.id,recordingId,requestId,kind,await hash(input),cost);
    if (job.state==='completed') return job.response;
    if (job.state!=='new') throw fail(job.state==='reserved'?'This request is still processing.':'This request already failed. Start a new request to retry.',409);
    try {
      const result=await run();
      await store.finish(user.id,requestId,true,result);
      return result;
    } catch (error) {
      try { await store.finish(user.id,requestId,false,null); } catch { /* Remains charged and reserved if the database is unavailable. */ }
      throw error;
    }
  }
  return async function handle(request) {
    const origin=request.headers.get('origin');
    const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
    if (origins.has(origin)) headers['Access-Control-Allow-Origin']=origin;
    const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
    try {
      if (!origins.has(origin)) throw fail('This origin is not allowed.',403);
      if (request.method==='OPTIONS') return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Max-Age':'600'}});
      const url=new URL(request.url), path=url.pathname.replace(/^\/(?:functions\/v1\/)?rehearsal-api(?=\/|$)/,'');
      if (url.search) throw fail('Query parameters are not supported.');
      if (request.method==='GET' && path==='/config') {
        const user=await identify(request,true);
        return json({hosted:true,configured:true,localSpeech:false,liveTranscription:false,retention:'private',auth:{signedIn:Boolean(user)},
          speechConfigured:Boolean(worker&&speechCost),analysisConfigured:Boolean(env.COACHING_API_KEY&&coachCost),analysisProvider:provider,analysisProviderLabel:PROVIDERS[provider].label,analysisModel:model,
          transcriptionModel:'bark-3.0-plus',providers:[],maxDurationSeconds:600,maxAudioBytes:MAX_AUDIO});
      }
      const user=await identify(request);
      if (request.method==='GET' && path==='/recordings') return json({recordings:(await store.list(user.id)).map(metadata)});
      if (request.method==='POST' && path==='/recordings') {
        const body=await jsonBody(request); exact(body,['id','title','durationSeconds','sizeBytes']);
        const id=uuid(body.id), title=text(body.title,120,true).trim(),duration=number(body.durationSeconds,0.5,600),size=number(body.sizeBytes,44,MAX_AUDIO);
        if (!Number.isInteger(size)) throw fail('Use a whole-byte file size.');
        const row=await store.create(user.id,id,title,duration,size);
        return json({id:row.id,storagePath:row.storage_path,bucket:'recordings'},201);
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
          return json(await paid(user,id,requestId,'transcribe',{recordingId:id},speechCost,async()=>{
            const blob=await store.audio(row.storage_path);
            if (blob.size!==row.size_bytes || blob.size>MAX_AUDIO) throw fail('The stored audio does not match this recording. Upload it again.');
            const audio=await blob.arrayBuffer(),durationSeconds=inspectHostedWav(audio);
            await store.update(user.id,id,{status:'transcribing'});
            try {
              const response=await fetchImpl(worker,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${env.BARK_WORKER_TOKEN}`,'Content-Type':'audio/wav',
                ...(env.BARK_WORKER_MODAL_KEY?{'Modal-Key':env.BARK_WORKER_MODAL_KEY,'Modal-Secret':env.BARK_WORKER_MODAL_SECRET}:{})},body:audio,signal:AbortSignal.timeout(125000)});
              if (!response.ok) throw fail('Cloud transcription is unavailable. Try again shortly.',response.status===429?429:502);
              let result; try { result=JSON.parse(new TextDecoder().decode(await readLimited(response,512*1024))); } catch { throw fail('The speech worker returned an unreadable response.',502); }
              if (result.model!=='bark-3.0-plus' || typeof result.text!=='string' || !result.text.trim() || result.text.length>60000 || typeof result.durationSeconds!=='number' || Math.abs(result.durationSeconds-durationSeconds)>0.1) throw fail('The speech worker returned an invalid transcript.',502);
              const output={text:result.text.trim(),durationSeconds,chunks:[],model:'bark-3.0-plus',localSpeech:false,recordingId:id};
              await store.update(user.id,id,{status:'transcribed',transcript:output.text,duration_seconds:durationSeconds,report:null});
              return output;
            } catch (error) {
              await store.update(user.id,id,{status:'failed'});
              if (error.safe) throw error;
              throw fail('Cloud transcription timed out or could not be reached. Your recording is saved.',502);
            }
          }));
        }
        if (!env.COACHING_API_KEY || !coachCost) throw fail('The managed AI coach is not configured yet.',503);
        if (!row.transcript) throw fail('Create a transcript for this recording before requesting coaching.',409);
        const input=analysisInput(body,row.duration_seconds);
        let prompt; try { prompt=buildAnalysisPrompt(input,policy); } catch { throw fail('Add a readable transcript and valid preparation text.'); }
        if (new TextEncoder().encode(prompt).byteLength>512*1024) throw fail('Shorten the script, rubric, or preparation notes.',413);
        return json(await paid(user,id,requestId,'coach',input,coachCost,async()=>{
          let feedback;
          try { feedback=await coach({provider,model,apiKey:env.COACHING_API_KEY,workspaceId:env.COACHING_WORKSPACE_ID,prompt,fetchImpl,browser:false}); }
          catch { throw fail('The AI coach is unavailable. Your recording is saved; try again later.',502); }
          const report=analyzeSpeech({...input,aiFeedback:feedback});
          if (report.analysis.method!=='ai') throw fail('The AI coach returned an incomplete report. Your recording is saved.',502);
          const output={...report,transcript:input.text,warnings:[],meta:{...input,text:undefined,useAI:undefined,generatedAt:new Date().toISOString(),analysisProvider:provider,analysisProviderLabel:PROVIDERS[provider].label,analysisModel:model,coachingStatus:'complete',localSpeech:false,recordingId:id}};
          await store.update(user.id,id,{status:'analyzed',transcript:input.text,report:output});
          return output;
        }));
      }
      throw fail('This app action does not exist.',404);
    } catch (error) { return json({error:error?.safe?error.message:'The service could not complete this request.'},error?.safe?error.status:503); }
  };
}
