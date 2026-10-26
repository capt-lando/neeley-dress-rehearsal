# Hosted pilot backend

This backend supports a **free student pilot**. There are no paid plans or admin application. The website remains on GitHub Pages; Supabase supplies OAuth, private history, usage-event storage, and the authenticated gateway. A separate GPU worker runs Bark. The migration does not enable AI spending automatically.

## Deployment status — October 26, 2026

The migration and `rehearsal-api` Edge Function are deployed to the free Supabase project `cnqpaamclpdzdmyuqhuz`. The daily AI budget is **zero**. The gateway has allowed origins configured, with no Bark worker credentials or coaching provider key. Email/password, phone, and anonymous sign-in are disabled; Google/Microsoft OAuth registrations and credentials remain outstanding. The GitHub Pages frontend has **not** switched to cloud mode.

All **35 pgTAP assertions passed against the linked project** in a rollback transaction before migration deployment. A follow-up query confirmed that test fixtures, bucket, and schemas did not persist. Deployed smoke checks passed for public configuration (200), unauthenticated private history (401), foreign-origin rejection (403), and allowed-origin preflight (204). Real OAuth, SDK uploads, and funded speech/coaching remain unverified and must pass before launch.

The product layers are: **1** GitHub Pages UI; **2** Edge gateway plus Modal Bark and external LLM compute; **3** Supabase authentication, private storage/history, and optional usage metrics; **3.5** deferred administration; **4** security controls across all layers. Every student has the same free experience.

## Set up a Supabase project

1. Enable **Google** and **Microsoft / Azure** under Authentication → Providers. Configure each provider's OAuth application and its Supabase callback URL. Disable email/password, phone, anonymous sign-in, and other identity providers. Google/Microsoft sign-in is not an approved TCU single-sign-on integration.
2. Set the Auth site URL and allow only the exact production/local callback URLs used by the website. Configure Google and Microsoft OAuth credentials in Supabase, never in browser code.
3. Link the project with `pnpm exec supabase link --project-ref YOUR_PROJECT_REF`, review the migration, then run `pnpm exec supabase db push`. Do not reset a hosted database.
4. Create an ignored `supabase/.env` from `.env.example` and configure server secrets with `pnpm exec supabase secrets set --env-file supabase/.env`. Never put the service-role key, coaching key, worker token, or Modal proxy credentials in a `VITE_` variable.
5. Run `node supabase/sync-policy.mjs` after editing the canonical coaching prompt. Then deploy with `pnpm exec supabase functions deploy rehearsal-api`. The generated prompt module is tested against the canonical Markdown to prevent drift.
6. Set the website's public Supabase URL and publishable key using the frontend deployment instructions. Public keys identify the project; they do not replace the user's verified OAuth token.

For the pending OAuth setup, open [Google's OAuth client creation page](https://console.cloud.google.com/auth/clients/create) and [Microsoft's App registrations page](https://portal.azure.com/#blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/RegisteredApps). Register a Web application with callback `https://cnqpaamclpdzdmyuqhuz.supabase.co/auth/v1/callback`. Google's branding/audience setup may be required first; Microsoft requires selecting **New registration** and supported account types. Follow the [Google guide](https://supabase.com/docs/guides/auth/social-sign-in/auth-google) and [Microsoft guide](https://supabase.com/docs/guides/auth/social-sign-in/auth-azure); enter client secrets directly into Supabase Auth, never the repository.

The Edge platform JWT switch is deliberately off for the public `/config` route and modern publishable keys. **Every private route independently calls Supabase `auth.getUser(token)` first.** It checks the verified subject, an OAuth authentication method, and a Google/Azure identity. Password authentication is rejected even for an account with a linked Google identity. Accounts with another linked OAuth provider are rejected; keep only Google/Azure enabled in this project.

## Spending and storage controls

The migration starts the daily AI allowance at **zero**. Transcription and coaching remain unavailable until the owner deliberately sets a nonzero allowance in the Supabase SQL editor:

```sql
-- Example only: a $2 daily admission allowance, not a provider billing guarantee.
update rehearsal_private.limits
set daily_budget_microusd = 2000000,
    requests_per_user_day = 10
where singleton;
```

One dollar is 1,000,000 microusd. Each speech/coaching request reserves its configured conservative maximum before calling a provider. All users have the same operational limits. An uncertain network failure stays debited because the upstream service may have billed it. A request ID can be replayed to retrieve its exact completed result, but cannot be reused for different input. Explicit retries after a known failure use a new request ID. Admission is atomic across gateway instances; there is no in-memory billing counter. Configure reservations to cover the selected model's maximum context/output and the worker's runtime; GPU cold starts, storage, authentication, and other vendor infrastructure costs are separate.

Private storage initially permits **10 recordings per student and 40 total**, each at most 20 MiB. This bounds admitted audio to 800 MiB before the free plan's storage ceiling; pending uploads also occupy slots. Storage RLS requires an exact, owned, pending upload path. The bucket enforces the size ceiling; the gateway checks actual byte size against the reservation because Storage's upload-permission probe does not yet include measured size. Existing objects cannot be overwritten through the browser. The gateway validates canonical mono 16 kHz PCM16 WAV bytes and a maximum 600-second duration before speech inference. Delete through the API to remove both the object and database rows; a failed deletion remains visible in history for retry and continues occupying its slot.

Recordings, corrected transcripts, preparation inputs, and reports stay private until the student deletes the recording. Short-lived audio links expire after 60 seconds. Internal idempotency results are also private and cascade-delete with the recording. The usage ledger remains charged after deleting a recording; deleting history must not replenish spent AI allowance. Monitor Supabase's storage/database quotas during the pilot. A scheduled retention policy for old request-result caches and usage events should be agreed before a wider rollout; no automatic content-retention claim is made here.

## Usage events

The frontend sends events only after the student opts in. Accepted fields are event/session UUIDs, an allowlisted event name and section, and at most 60 seconds of active time. The gateway supplies identity and receipt time. No transcript, audio, rubric, email, arbitrary URL, free-text property, or biometric inference is accepted in analytics. Events are deduplicated and bounded to 120 per user per minute. Engagement values are client-reported estimates, not billing or research-grade measurements. Analytics have no browser read access or dashboard endpoint in this phase.

## Checks before enabling the hosted UI

Run `pnpm test`, `pnpm exec supabase start`, and `pnpm exec supabase test db`. The database tests exercise RLS, cross-user history, private upload permission probes, orphan-path rejection, budget idempotency, failure accounting, and storage limits. Node tests exercise token verification boundaries, CORS, request schemas, worker isolation, actual audio-size validation, redacted errors, and no-content analytics.

Then verify the **real hosted integrations**: both OAuth providers; Storage upload using the production SDK; ownership isolation between two accounts; delete/retry; a real Bark GPU transcription; a real coaching response; and project budget exhaustion. Mocked gateway tests do not prove those external services are configured. Keep the existing public app operational until these checks pass.

Official references: [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [private Storage policies](https://supabase.com/docs/guides/storage/security/access-control), [Edge Function limits](https://supabase.com/docs/guides/functions/limits), [Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google), [Azure OAuth](https://supabase.com/docs/guides/auth/social-login/auth-azure), [database testing](https://supabase.com/docs/guides/database/testing).
