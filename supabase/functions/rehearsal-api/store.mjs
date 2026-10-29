import { fail } from './api.mjs';

const ERRORS = {
  not_found:['This recording was not found.',404], request_conflict:['This request ID was already used for different data.',409],
  request_busy:['Another request is processing. Please wait for it to finish.',409],
  request_cancelled:['This request was cancelled. You can start another rehearsal.',409],
  recovery_limit:['Too many interrupted rehearsals. Please try again later.',429],
  storage_limit:['Your saved-recording limit is reached. Delete an older recording first.',429],
  daily_limit:['Your pilot usage limit is reached. Try again later.',429],
  rate_limited:['Too many requests. Wait a minute, then try again.',429],
  budget_exhausted:['The pilot daily AI allowance is unavailable. Please try again another day.',429],
  invalid_request:['The request is invalid.',400],
  live_closed:['This live rehearsal ended or expired. Save the recording and transcribe the full take.',409],
  live_order:['Send live audio in order, one section at a time.',409],
  live_duration:['The live transcript does not cover the complete recording. Save the take and transcribe it in full.',409],
  chat_busy:['Your previous chat message is still processing. Please wait for it to finish.',409],
  chat_limit:['You have reached the pilot chat allowance. Try again later.',429],
  chat_expired:['This chat reply has expired. Send a new message to continue.',409],
};
function checked({ data, error }) {
  if (error) {
    const known=ERRORS[error.message];
    const failure=known?fail(...known):fail('Private storage is temporarily unavailable.',503);
    if (error.message==='rate_limited') failure.retryAfter=60;
    if (error.message==='request_cancelled') failure.jobState='cancelled';
    if (error.message==='chat_expired') failure.jobState='failed';
    throw failure;
  }
  return data;
}
export function createSupabaseStore(client) {
  const rpc=async(name,args)=>{
    const result=await client.rpc(name,args);
    try { return checked(result); }
    catch(error) {
      // These reserve failures occur after checking for this exact request ID
      // and before creating a job. Transport errors and conflicts are uncertain.
      if(name==='rehearsal_reserve'&&['request_busy','daily_limit','budget_exhausted'].includes(result?.error?.message))error.notStarted=true;
      throw error;
    }
  };
  const recordings=()=>client.from('rehearsal_recordings');
  return {
    admitRequest(user=null) { return rpc('rehearsal_admit_request',{p_user:user}); },
    async verifyUser(token) { const {data,error}=await client.auth.getUser(token); return error?null:data?.user; },
    async profile(id) {
      checked(await client.from('rehearsal_profiles').upsert({user_id:id},{onConflict:'user_id',ignoreDuplicates:true}));
      return checked(await client.from('rehearsal_profiles').select('user_id').eq('user_id',id).single());
    },
    welcomePreference(user,dontShowAgain=null) {
      return rpc('rehearsal_welcome_preference',{p_user:user,p_dont_show_again:dontShowAgain});
    },
    async list(id) { return checked(await recordings().select('id,title,created_at,duration_seconds,size_bytes,status').eq('user_id',id).eq('upload_expired',false).order('created_at',{ascending:false}).limit(50)); },
    async owned(user,id) { return checked(await recordings().select('*').eq('user_id',user).eq('id',id).maybeSingle()); },
    async create(user,id,title,duration,size) {
      const result=await rpc('rehearsal_create_recording',{p_user:user,p_id:id,p_title:title,p_duration:duration,p_size:size});
      return Array.isArray(result)?result[0]:result;
    },
    async audio(path) { return checked(await client.storage.from('recordings').download(path)); },
    async uploadAudio(path,bytes) {
      const result=await client.storage.from('recordings').upload(path,bytes,{contentType:'audio/wav',upsert:false});
      if (Number(result.error?.statusCode||result.error?.status)===409 || result.error?.error==='Duplicate') throw fail('This recording already contains audio.',409);
      return checked(result);
    },
    async signAudio(path,seconds) { return checked(await client.storage.from('recordings').createSignedUrl(path,seconds)).signedUrl; },
    async update(user,id,patch) { checked(await recordings().update({...patch,updated_at:new Date().toISOString()}).eq('user_id',user).eq('id',id)); },
    async remove(user,id) {
      const path=await rpc('rehearsal_prepare_delete',{p_user:user,p_recording:id});
      checked(await client.storage.from('recordings').remove([path]));
      checked(await recordings().delete().eq('user_id',user).eq('id',id));
    },
    reserve(user,recording,request,kind,inputHash,cost) { return rpc('rehearsal_reserve',{p_user:user,p_recording:recording,p_request:request,p_kind:kind,p_hash:inputHash,p_cost:cost}); },
    finish(user,request,ok,response) { return rpc('rehearsal_finish',{p_user:user,p_request:request,p_ok:ok,p_response:response}); },
    requestStatus(user,request) { return rpc('rehearsal_get_request',{p_user:user,p_request:request}); },
    cancelRequest(user,recording,request) { return rpc('rehearsal_cancel_request',{p_user:user,p_recording:recording,p_request:request}); },
    completeRequest(user,request,response) { return rpc('rehearsal_complete_request',{p_user:user,p_request:request,p_response:response}); },
    chatReserve(user,recording,request,inputHash) { return rpc('rehearsal_chat_reserve',{p_user:user,p_recording:recording,p_request:request,p_hash:inputHash}); },
    chatComplete(user,request) { return rpc('rehearsal_chat_complete',{p_user:user,p_request:request}); },
    chatFail(user,request) { return rpc('rehearsal_chat_fail',{p_user:user,p_request:request}); },
    liveStart(user,recording,request,title,inputHash,cost) { return rpc('rehearsal_stream_start',{p_user:user,p_recording:recording,p_request:request,p_title:title,p_hash:inputHash,p_cost:cost}); },
    liveStreamClaim(user,recording,request,sequence) { return rpc('rehearsal_stream_claim',{p_user:user,p_recording:recording,p_request:request,p_sequence:sequence}); },
    liveStreamFinish(user,recording,request,sequence,text,samples) { return rpc('rehearsal_stream_finish',{p_user:user,p_recording:recording,p_request:request,p_sequence:sequence,p_text:text,p_samples:samples}); },
    liveStreamFail(user,recording,request,sequence) { return rpc('rehearsal_stream_fail',{p_user:user,p_recording:recording,p_request:request,p_sequence:sequence}); },
    liveGet(user,recording) { return rpc('rehearsal_live_get',{p_user:user,p_recording:recording}); },
    liveDraftKey(user,recording,request) { return rpc('rehearsal_live_draft_key',{p_user:user,p_recording:recording,p_request:request}); },
    liveClose(user,recording,cancel=false) { return rpc('rehearsal_live_close',{p_user:user,p_recording:recording,p_cancel:cancel}); },
    liveCancel(user,recording,request) { return rpc('rehearsal_live_cancel',{p_user:user,p_recording:recording,p_request:request}); },
    liveFinish(user,recording,duration,size) { return rpc('rehearsal_stream_finalize',{p_user:user,p_recording:recording,p_duration:duration,p_size:size}); },
    events(user,events) { return rpc('rehearsal_ingest_events',{p_user:user,p_events:events}); },
  };
}
