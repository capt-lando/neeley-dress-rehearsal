# Project direction

Accepted direction as of October 27, 2026. OpenAI streaming supersedes the earlier Bark/Modal plan.

- **Develop only the web app going forward, locally and on GitHub.** The plugin's final current release is 0.2.1; its development, installation updates, and publishing are paused unless requested again. Preserve that released package and the text coaching bridge. Remove the obsolete local speech panel and packaging source as part of the requested cleanup.
- **Keep Neeley branding and the existing interface.** Pilot first with the Professional Development Center, then interested professors and the speech and debate team. These are intended audiences, not confirmed institutional partnerships.
- **Build three layers.** The student interface; Supabase for identity, private history, analytics and access; and server-funded speech transcription and coaching. Security applies across all three. Students will not need provider keys or speech-model downloads in cloud mode.
- **Use Google and Microsoft login only.** Do not add independent email/password, email-link, phone, or anonymous sign-in. Microsoft login is not a claim of approved TCU SSO; school tenant consent may be needed.
- **Save rehearsals privately.** Store students' recordings, transcripts, and reports in Supabase so they can revisit and delete their own work. Keep presentation content out of usage analytics.
- **Separate analytics from private content.** Collect optional active section time, sessions, completion, and retention. These are usage metrics, not voice biometrics. Do not add voiceprints, emotion profiling, or fingerprinting.
- **One free experience for everyone.** Do not build plans, entitlements, paid tiers, upgrades, or billing. Defer the admin dashboard entirely. Usage data can be collected in Supabase without a dashboard; operational storage and compute limits still apply equally to users.
- **Use managed live transcription.** Stream audio through the authenticated gateway to OpenAI. Use the file API for uploads and GPT for coaching afterward. Remove the retired speech implementation and its dependencies from the codebase; do not start GPU workers or download speech models. Silence never ends a recording: wait for Stop, retaining the existing ten-minute cap.
- **Recover only the signed-in user's work.** Encrypt local live-audio checkpoints with a server-held account-bound key. Refresh restores the saved portion with the microphone stopped. Cancel/restart requires a separate confirmation and stops current work.
- **Start with free Supabase.** Provision other compute/provider accounts only after setup and spending limits are agreed. Keep provider credentials server-side and enforce storage, request, concurrency and spending caps.
- **Verify before retiring the old service.** Confirm actual live transcript deltas, private storage, and cancellation; publish the replacement and stop Modal. Preserve the existing released plugin package.

The implementation checklist is in [Cloud pilot](docs/cloud-pilot.md). Price research and assumptions are in [Cloud costs](docs/cloud-costs.md).
