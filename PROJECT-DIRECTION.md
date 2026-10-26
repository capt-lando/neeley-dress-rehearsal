# Project direction

Accepted direction as of October 26, 2026. The cloud pilot supersedes the earlier static-only restriction.

- **Develop only the web app going forward, locally and on GitHub.** The plugin's final current release is 0.2.1; its development, installation updates, and publishing are paused unless requested again. Keep the existing plugin files and release available, but exclude plugin packaging from website deployments.
- **Keep Neeley branding and the existing interface.** Pilot first with the Professional Development Center, then interested professors and the speech and debate team. These are intended audiences, not confirmed institutional partnerships.
- **Build three layers.** The student interface; Supabase for identity, private history, analytics and access; and server-funded speech transcription and coaching. Security applies across all three. Students will not need provider keys or speech-model downloads in cloud mode.
- **Use Google and Microsoft login only.** Do not add independent email/password, email-link, phone, or anonymous sign-in. Microsoft login is not a claim of approved TCU SSO; school tenant consent may be needed.
- **Save rehearsals privately.** Store students' recordings, transcripts, and reports in Supabase so they can revisit and delete their own work. Keep presentation content out of usage analytics.
- **Separate analytics from private content.** Collect optional active section time, sessions, completion, and retention. These are usage metrics, not voice biometrics. Do not add voiceprints, emotion profiling, or fingerprinting.
- **One free experience for everyone.** Do not build plans, entitlements, paid tiers, upgrades, or billing. Defer the admin dashboard entirely. Usage data can be collected in Supabase without a dashboard; operational storage and compute limits still apply equally to users.
- **Own the speech service.** Start with complete-take Bark 3.0 Plus inference on separate cloud compute, preserving fillers. Live coaching remains a future phase.
- **Start with free Supabase.** Provision other compute/provider accounts only after setup and spending limits are agreed. Keep provider credentials server-side and enforce storage, request, concurrency and spending caps.
- **Preserve a working rollout.** Keep local mode operational until OAuth, private storage isolation, and actual cloud speech/coaching pass end-to-end checks. Publishing cloud-capable code does not mean those services are enabled.

The implementation checklist is in [Cloud pilot](docs/cloud-pilot.md). Price research and assumptions are in [Cloud costs](docs/cloud-costs.md).
