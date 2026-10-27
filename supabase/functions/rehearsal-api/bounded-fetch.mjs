// Database/auth/storage calls also need a deadline: otherwise a stalled lookup
// can retain an isolate admission slot after its HTTP or socket client leaves.
// The timeout signal stays attached to the response body after headers arrive.
export function createBoundedFetch({fetchImpl=fetch,timeoutMs=20000}={}) {
  return (input,init={})=>{
    const signals=[AbortSignal.timeout(timeoutMs)];
    if(input instanceof Request)signals.push(input.signal);
    if(init.signal)signals.push(init.signal);
    return fetchImpl(input,{...init,signal:AbortSignal.any(signals)});
  };
}
