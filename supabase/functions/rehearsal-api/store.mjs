import { fail } from './api.mjs';

const ERRORS = {
  not_found:['This recording was not found.',404], request_conflict:['This request ID was already used for different data.',409],
  request_busy:['Another request is processing. Please wait for it to finish.',409],
  storage_limit:['Your saved-recording limit is reached. Delete an older recording first.',429],
  daily_limit:['Your pilot usage limit is reached. Try again later.',429],
  budget_exhausted:['The pilot daily AI allowance is unavailable. Please try again another day.',429],
  invalid_request:['The request is invalid.',400],
};
function checked({ data, error }) {
  if (error) {
    const known=ERRORS[error.message];
    throw known?fail(...known):fail('Private storage is temporarily unavailable.',503);
  }
  return data;
}
export function createSupabaseStore(client) {
  const rpc=async(name,args)=>checked(await client.rpc(name,args));
  const recordings=()=>client.from('rehearsal_recordings');
  return {
    async verifyUser(token) { const {data,error}=await client.auth.getUser(token); return error?null:data?.user; },
    async profile(id) {
      checked(await client.from('rehearsal_profiles').upsert({user_id:id},{onConflict:'user_id',ignoreDuplicates:true}));
      return checked(await client.from('rehearsal_profiles').select('user_id').eq('user_id',id).single());
    },
    async list(id) { return checked(await recordings().select('id,title,created_at,duration_seconds,size_bytes,status').eq('user_id',id).order('created_at',{ascending:false}).limit(50)); },
    async owned(user,id) { return checked(await recordings().select('*').eq('user_id',user).eq('id',id).maybeSingle()); },
    async create(user,id,title,duration,size) {
      const result=await rpc('rehearsal_create_recording',{p_user:user,p_id:id,p_title:title,p_duration:duration,p_size:size});
      return Array.isArray(result)?result[0]:result;
    },
    async audio(path) { return checked(await client.storage.from('recordings').download(path)); },
    async signAudio(path,seconds) { return checked(await client.storage.from('recordings').createSignedUrl(path,seconds)).signedUrl; },
    async update(user,id,patch) { checked(await recordings().update({...patch,updated_at:new Date().toISOString()}).eq('user_id',user).eq('id',id)); },
    async remove(user,id) {
      const path=await rpc('rehearsal_prepare_delete',{p_user:user,p_recording:id});
      checked(await client.storage.from('recordings').remove([path]));
      checked(await recordings().delete().eq('user_id',user).eq('id',id));
    },
    reserve(user,recording,request,kind,inputHash,cost) { return rpc('rehearsal_reserve',{p_user:user,p_recording:recording,p_request:request,p_kind:kind,p_hash:inputHash,p_cost:cost}); },
    finish(user,request,ok,response) { return rpc('rehearsal_finish',{p_user:user,p_request:request,p_ok:ok,p_response:response}); },
    events(user,events) { return rpc('rehearsal_ingest_events',{p_user:user,p_events:events}); },
  };
}
