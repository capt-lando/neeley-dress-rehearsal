// A cheap first barrier per Edge isolate. The database is the cross-instance
// authority; this guard prevents floods from turning every request into SQL.
export function createRequestLimit({ now = Date.now, burst = 60, perSecond = 10, concurrent = 8 } = {}) {
  let tokens = burst, updated = now(), active = 0;
  return () => {
    const current = now();
    tokens = Math.min(burst, tokens + Math.max(0, current - updated) * perSecond / 1000);
    updated = current;
    if (active >= concurrent || tokens < 1) {
      throw Object.assign(new Error('Too many requests. Wait a moment, then try again.'), { safe: true, status: 429, retryAfter: active >= concurrent ? 2 : 1 });
    }
    tokens--; active++;
    let released = false;
    return () => { if (!released) { released = true; active--; } };
  };
}
