# Cloud AI research and pilot cost assumptions

Verified October 26, 2026. Figures are USD, illustrative, and subject to provider changes. No GPU account or paid API was provisioned by this research.

## What to build first

Keep the Neeley web interface on GitHub Pages. Use Supabase for authenticated student accounts, private rehearsals, event data, job records and usage limits. A separate GPU worker runs our Bark 3.0 Plus transcription service; a server-funded language-model API produces the existing coaching report. Real-time spoken coaching and general-purpose voice generation are future work.

Supabase Edge Functions have 256 MB RAM and two seconds of CPU time per request, so they can coordinate inference but cannot run Bark. [Supabase limits](https://supabase.com/docs/guides/functions/limits)

ElevenLabs provides voice generation, transcription and voice agents. Its relevant product here is Scribe batch/realtime speech recognition, with capabilities such as word timestamps and speaker labels. Building our own hosted Bark transcription pipeline covers this app's current need; it does not mean training or reproducing all of ElevenLabs. Their listed batch speech-to-text rate is $0.22 per audio hour, approximately 1.83 cents for five minutes, subject to plan conditions. This is a comparison only; the app does not integrate ElevenLabs. [Transcription documentation](https://elevenlabs.io/docs/overview/capabilities/speech-to-text), [API pricing](https://elevenlabs.io/pricing/api?price.section=speech_to_text)

## Coaching candidates

One rehearsal example uses **10,000 input tokens and 3,000 output tokens**, including the coaching instructions, script, rubric and report. These are assumptions; duration alone does not determine token cost. Thinking tokens, retries and unusually long rubrics can increase it.

| Model | Input / output per million tokens | Example coaching request |
| --- | --- | --- |
| DeepSeek Flash, off-peak | $0.15 / $0.60 | $0.0033 |
| DeepSeek Flash, peak | $0.30 / $1.20 | $0.0066 |
| Gemini 3.1 Flash-Lite | $0.25 / $1.50 | $0.0070 |
| Gemini 3.5 Flash-Lite | $0.30 / $2.50 | $0.0105 |

These are API usage charges; a key itself is a credential, not purchased usage. Evaluate report quality, evidence fidelity and provider data terms before choosing the cheapest candidate. Google lists paid-tier content as not used to improve products, unlike its free tier. Do not treat developer testing allowances as a funded student service. [DeepSeek official pricing](https://api-docs.deepseek.com/quick_start/pricing/), [Gemini official pricing](https://ai.google.dev/gemini-api/docs/pricing)

## Bark hosting calculation

Modal lists L4 at $0.000222/GPU-second, CPU at $0.0000131/physical-core-second, and RAM at $0.00000222/GiB-second. Model startup and warm idle retention are billable; default idle retention is 60 seconds. Our optional adapter requests two CPU cores, 8 GiB RAM and ten seconds of idle retention, with at most one worker. [Modal pricing](https://modal.com/pricing)

`speech cost = billable seconds × (0.000222 + CPU cores × 0.0000131 + RAM GiB × 0.00000222)`

At the adapter's resource allocation, **30–90 total billable seconds** cost approximately **$0.0080–$0.0239**. Adding the example Gemini 3.1 Flash-Lite coaching call gives roughly **1.5–3.1 cents per rehearsal**. This is a scenario, not measured GPU throughput: actual billable seconds include model loading, inference, idle retention and retries. It excludes Supabase base charges, storage, bandwidth, taxes and failed-job overhead. A server benchmark is required before quoting a pilot price.

Start with completed takes and a small PDC cohort. Record billable inference duration, provider token usage, error rates and coaching completion per job without logging speech content. Use a hard daily spending ceiling and per-user quotas. Owned infrastructure still needs concurrency limits and abuse protection. Expand to professors and speech/debate only after costs, transcription and coaching quality are measured.
