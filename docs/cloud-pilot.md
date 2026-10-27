# Cloud pilot

## Architecture

The GitHub Pages app uses Supabase for Google/Microsoft identity, private recordings, request recovery, and optional usage analytics. The authenticated `rehearsal-api` gateway connects to OpenAI using server-held credentials. Live audio uses `gpt-live-transcribe`, uploaded audio uses `gpt-transcribe`, and coaching uses the server-configured GPT model.

There is one free student experience. Paid tiers and an admin dashboard are outside the pilot. Google sign-in is configured; Microsoft requires its separate OAuth setup and is not a claim of institutionally approved TCU SSO.

| Component | Source | Hosting |
| --- | --- | --- |
| Student interface | `public/`, `lib/hosted-*.mjs` | GitHub Pages |
| Identity, private history, request state | `supabase/migrations/` | Supabase |
| Speech relay and coaching API | `supabase/functions/rehearsal-api/` | Supabase Edge Functions |
| Speech and coaching models | Server-selected OpenAI API models | OpenAI |

## Recording lifecycle

The browser sends small 24 kHz PCM frames over an authenticated WebSocket. The server verifies the account, recording owner, request, sequence, and available budget before contacting OpenAI. The provider key never reaches the browser. Short-lived connections renew within Edge Function limits while the same take continues. Server-side sample and sequence checks prevent replay or exceeding the ten-minute limit.

Voice activity detection is disabled. Silence, partial transcript completion, and connection renewal cannot finish a take. **Stop** finalizes the remaining transcript and saves audio. The ten-minute cap remains an explicit capacity limit. **Analyze** separately requests coaching.

Live audio is also checkpointed in encrypted half-second blocks in IndexedDB. The authenticated manifest binds the block count and exact sample length; authenticated encryption binds every block to its project, owner, recording, request, and position. The decryption key stays in memory and the private backend, expires after 24 hours, and is never persisted in browser storage. Upload reservations for these drafts have the same expiry. Ordinary uploads retain their shorter reservation.

On refresh, the app cancels the old live connection, restores the available audio to the original recording, and reopens it with the microphone stopped. A transcript is marked complete only when all captured audio was transcribed. Existing file or coaching requests are recovered by their original IDs rather than submitted twice. Account switching closes old connections and releases draft keys. Sign-out additionally clears that account's local drafts.

Cancel/restart requires a separate confirmation. Provider connections close before cancellation is acknowledged. Canceled work cannot publish late transcript or coaching results. Acknowledged cancellation clears the local pending marker and draft; uncertain failures retain recovery information for retry.

Uploads automatically process after the client checks file signature, size, decoding, and duration. The server accepts only bounded canonical mono PCM WAV audio and verifies ownership before processing. No client model selection, provider URL, or API credential can override server policy.

## Deployment

1. Configure Google and, when ready, Microsoft OAuth in Supabase. Enable only the supported providers and exact site/local redirect URLs.
2. Apply migrations in order. Historical migrations remain immutable; current behavior is established by the subsequent streaming and encrypted-draft migrations.
3. Configure the server-held OpenAI key, provider/model, allowed origins, storage limits, and budget. Follow `supabase/README.md`.
4. Deploy `rehearsal-api` and verify public configuration, signed-out denial, owner isolation, and allowed-origin handling.
5. Run `pnpm test` and `pnpm build`. Push `main` and verify both the Pages release and database workflow at that commit.
6. Verify the public assets and API configuration agree, including the authenticated WebSocket origin in the content security policy.

Production project: `cnqpaamclpdzdmyuqhuz`. Site: https://capt-lando.github.io/neeley-dress-rehearsal/.

## Verification evidence — October 27, 2026

A direct provider probe sent 27.72 seconds of synthetic speech through a protected temporary Edge Function. Readiness took 1.365 seconds; the first text delta arrived at 2.084 seconds, with 86 deltas before Stop. The function was removed afterward.

A separate 101-second, real-paced integration run used the production client, gateway modules, database, private storage, and OpenAI. A temporary protected test function substituted authentication only for a synthetic user; this was not a full OAuth browser test. Recording continued across two connections. Readiness took 6.622 seconds and the first partial arrived at 7.046 seconds, 424 ms after readiness. Stop-to-save took 8.419 seconds. Reopening private history returned the same 3,232,044-byte WAV and 1,397-character transcript. An eight-second upload completed in 7.826 seconds, and active cancellation was acknowledged in 1.123 seconds. Test records, synthetic identity, and temporary function were deleted.

These are individual observations, not guarantees of latency or recognition accuracy. Initial connection and final save still take time. Live text has no precise provider word timestamps, so playback highlighting is approximate. Filler words can be omitted despite the verbatim prompt.

Automated coverage includes ownership isolation, malformed input, spending/concurrency bounds, exact samples across connection renewal, silent recording until Stop, cancellation, encrypted recovery and tamper rejection, account switching, upload validation, and report evidence validation. Database tests run in rollback transactions and in CI.
