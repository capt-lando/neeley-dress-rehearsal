# Hosted pilot backend

This backend supports a **free student pilot**. There are no paid plans or admin application. The website remains on GitHub Pages; Supabase supplies OAuth, private history, usage-event storage, and the authenticated gateway. A separate GPU worker runs Bark. The migration does not enable AI spending automatically.

## Deployment status — October 26–27, 2026

Security migration `202610270002_security_bounds.sql` and the updated `rehearsal-api` Edge Function are deployed to the free Supabase project `cnqpaamclpdzdmyuqhuz`. The gateway daily admission allowance is **$5**, with $0.075 reserved per batch speech request, $0.060 per coaching request, and $0.30 per live transcription session. These are conservative admission estimates, not provider invoice caps. Server-funded Bark 3.0 Plus and OpenAI `gpt-6-luna` are configured. Email/password, phone, and anonymous sign-in remain disabled. GitHub's public build variables select the hosted frontend; verify production sign-in after each deployment.

On October 26, Google owner sign-in, private upload, history, reopen, and playback passed, followed by the full browser transcription/coaching flow with a privately saved 27.7-second fixture. Bark matched its reference including fillers. OpenAI returned a 48/100 rating, five annotations, and three of four target points, correctly marking the invitation missing. Statistics showed two `um`, two `uh`, one filler `like`, and two non-filler uses of `like`. Reopening the completed report returned the same transcript and feedback. This fixture does not validate accuracy across student recordings. Those initial uploads used the Storage SDK directly; the current security update replaces that path with the validated Edge upload gateway described below.

Modal Starter's $30 gross usage budget and $0 net spend limit are verified. The proxy-protected worker passed cold/warm inference and authorization smoke checks; see `cloud/speech-worker/README.md`. Microsoft sign-in configuration remains pending; Google is available.

The current **55 security and 37 pilot pgTAP assertions passed against the linked project in rollback transactions**. They cover cross-user access, upload leases, direct-upload denial, request/event limits, and inert SQL-injection strings. Real browser PDF rubric extraction passed without console errors. All **452 Node tests and 19 worker tests passed**. Eleven bounded deployed smoke checks passed for public configuration (200), unauthenticated private history (401), foreign-origin rejection (403), and allowed-origin preflight (204), including the production origin. Microsoft setup and broader pilot tests remain outstanding.

The product layers are: **1** GitHub Pages UI; **2** Edge gateway plus Modal Bark and external LLM compute; **3** Supabase authentication, private storage/history, and optional usage metrics; **3.5** deferred administration; **4** security controls across all layers. Every student has the same free experience.

## Set up a Supabase project

1. Enable **Google** and **Microsoft / Azure** under Authentication → Providers. Configure each provider's OAuth application and its Supabase callback URL. Disable email/password, phone, anonymous sign-in, and other identity providers. Google/Microsoft sign-in is not an approved TCU single-sign-on integration.
2. Set the Auth site URL and allow only the exact production/local callback URLs used by the website. Configure Google and Microsoft OAuth credentials in Supabase, never in browser code.
3. Link the project with `pnpm exec supabase link --project-ref YOUR_PROJECT_REF`, review the migration, then run `pnpm exec supabase db push`. Do not reset a hosted database.
4. Create an ignored `supabase/.env` from `.env.example` and configure server secrets with `pnpm exec supabase secrets set --env-file supabase/.env`. Never put the service-role key, coaching key, worker token, or Modal proxy credentials in a `VITE_` variable.
5. Run `node supabase/sync-policy.mjs` after editing the canonical coaching prompt. Then deploy with `pnpm exec supabase functions deploy rehearsal-api`. The generated prompt module is tested against the canonical Markdown to prevent drift.
6. Set the website's public Supabase URL and publishable key using the frontend deployment instructions. Public keys identify the project; they do not replace the user's verified OAuth token.

Google is already configured. When requests use only `openid`, email, and profile, Google's Testing exception permits users outside the test-user list without the seven-day authorization expiry; additional scopes void the exception. Organization restrictions still apply. A paid custom domain or published brand is not necessary for this pilot sign-in flow; production branding has separate requirements. [Google audience rules](https://support.google.com/cloud/answer/15549945?hl=en), [Supabase Google guide](https://supabase.com/docs/guides/auth/social-sign-in/auth-google).

For the pending Microsoft setup, open [App registrations](https://portal.azure.com/#blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/RegisteredApps). Select **New registration**, a Web application, the intended supported account types, and callback `https://cnqpaamclpdzdmyuqhuz.supabase.co/auth/v1/callback`. Follow the [Microsoft guide](https://supabase.com/docs/guides/auth/social-sign-in/auth-azure); enter client secrets directly into Supabase Auth, never the repository.

The Edge platform JWT switch is deliberately off for the public `/config` route and modern publishable keys. **Every private route independently calls Supabase `auth.getUser(token)` first.** It checks the verified subject, an OAuth authentication method, and a Google/Azure identity. Password authentication is rejected even for an account with a linked Google identity. Accounts with another linked OAuth provider are rejected; keep only Google/Azure enabled in this project.

## Request limits

Database-backed admission allows **1,200 requests per minute globally and 120 per minute per verified user**. Global admission precedes token verification; user admission follows it and precedes private work. Each Edge isolate also allows a burst of 60 requests, replenishes 10 tokens per second, and admits at most eight concurrent requests, including no more than two whole-audio operations to limit simultaneous buffer memory. Rate-limit responses use HTTP 429 with `Retry-After`. These controls complement authentication and AI budgets; they do not make free hosting immune to denial of service or platform quota exhaustion. Request/response body reads have byte limits and a 20-second deadline.

## Spending and storage controls

The initial migration starts the daily AI allowance at **zero**. The deployed pilot uses **5,000,000 microusd ($5) per day**, with 75,000 microusd per batch speech request, 60,000 per coaching request, 300,000 per live transcription session, and 10 AI admissions per student per day. A live session reserves once for its bounded session rather than charging each ten-second chunk separately. Existing debits are not reset by a settings change. Reservations are conservative admission estimates, not vendor billing caps: startup, idle time, resource use, and provider behavior can vary. Revisit estimates when models, prices, or resource limits change. Changes are deliberate server-side updates; for example:

```sql
-- Current pilot admission allowance; not a provider billing guarantee.
update rehearsal_private.limits
set daily_budget_microusd = 5000000,
    requests_per_user_day = 10
where singleton;
```

One dollar is 1,000,000 microusd. Each AI operation reserves its configured estimate before calling a provider. All users have the same operational limits. An uncertain network failure stays debited because the upstream service may have billed it. A request ID can be replayed to retrieve its exact completed result, but cannot be reused for different input. Explicit retries after a known failure use a new request ID. Admission is atomic across gateway instances; there is no in-memory billing counter. Modal's separate workspace controls remain **$30 gross usage and $0 net spend**, with no paid upgrade. Storage, authentication, and other infrastructure quotas are separate from the app's admission ledger.

Private storage permits **10 recordings per student and 40 total**, each at most 20 MiB, bounding admitted audio to 800 MiB. Both batch and live recordings upload through authenticated `POST /recordings/:id/audio`. The gateway verifies ownership and canonical mono 16 kHz PCM16 WAV bytes, measures duration (0.5–600 seconds), and checks the reservation **before writing to private Storage**. It records authoritative size/duration. Browser Storage inserts and overwrites are denied; only the server can upload to an exact pending reservation path. Format validation cannot determine whether valid PCM samples contain human speech.

An empty upload reservation has a **one-hour lease**. On subsequent admission, expired pending reservations without a Storage object or active live-session lease release their recording slot; their metadata is retained and hidden from normal history. Late uploads are rejected under the same admission lock. Existing audio and completed recordings are not expired or deleted. New reservations are limited to **40 per user per UTC day, 400 globally per UTC day, and 10,000 retained metadata rows**; expiry and deletion do not replenish the daily counters. Delete saved recordings through the API to remove both object and database rows. A failed deletion remains visible for retry and continues occupying its slot.

Recordings, corrected transcripts, preparation inputs, and reports stay private until the student deletes the recording. Short-lived audio links expire after 60 seconds. Internal idempotency results are also private and cascade-delete with the recording. The usage ledger remains charged after deleting a recording; deleting history must not replenish spent AI allowance. Monitor Supabase's storage/database quotas during the pilot. No automatic purge is enabled: retained metadata and analytics caps stop further admission rather than deleting existing data. Agree on a retention/export policy before broader rollout or raising those caps.

## Usage events

The frontend sends events only after the student opts in. Accepted fields are event/session UUIDs, an allowlisted event name and section, and at most 60 seconds of active time. The gateway supplies identity and receipt time. No transcript, audio, rubric, email, arbitrary URL, free-text property, or biometric inference is accepted in analytics. Events are deduplicated before counting and limited to **120 per user per minute, 1,000 per user per UTC day, 10,000 globally per UTC day, and 100,000 retained events**. Engagement values are client-reported estimates, not billing or research-grade measurements. Analytics have no browser read access or dashboard endpoint in this phase.

## Checks before enabling the hosted UI

Run `pnpm test`; with a local Supabase/Docker stack, also run `pnpm exec supabase start` and `pnpm exec supabase test db`. Linked-project SQL checks must use synthetic fixtures in rollback transactions. Database tests exercise RLS, cross-user access, direct-upload denial, exact-path leases, request/event bounds, budget idempotency, failure accounting, and inert injection payloads. Node tests exercise token verification, CORS, request admission, bounded body reads, canonical WAV validation before storage, upload retries, worker isolation, redacted errors, and no-content analytics.

Then verify the **real hosted integrations**: both OAuth providers; validated gateway upload from the deployed frontend; ownership isolation between two accounts; delete/retry; a real Bark GPU transcription; a real coaching response; and project budget exhaustion. Mocked gateway tests do not prove those external services are configured. Keep the existing public app operational until these checks pass.

Official references: [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [private Storage policies](https://supabase.com/docs/guides/storage/security/access-control), [Edge Function limits](https://supabase.com/docs/guides/functions/limits), [Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google), [Azure OAuth](https://supabase.com/docs/guides/auth/social-login/auth-azure), [database testing](https://supabase.com/docs/guides/database/testing).
