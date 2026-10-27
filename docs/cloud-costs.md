# Cloud AI research and pilot cost assumptions

Verified October 26, 2026. Figures are USD, illustrative, and subject to provider changes. No GPU account or paid API was provisioned by this research.

## What to build first

Keep the Neeley web interface on GitHub Pages. Use Supabase for authenticated student accounts, private rehearsals, event data, job records and usage limits. A separate GPU worker runs our Bark 3.0 Plus transcription service; a server-funded language-model API produces the existing coaching report. Real-time spoken coaching and general-purpose voice generation are future work.

Supabase Edge Functions have 256 MB RAM and two seconds of CPU time per request, so they can coordinate inference but cannot run Bark. [Supabase limits](https://supabase.com/docs/guides/functions/limits)

ElevenLabs provides voice generation, transcription and voice agents. Its relevant product here is Scribe batch/realtime speech recognition, with capabilities such as word timestamps and speaker labels. Building our own hosted Bark transcription pipeline covers this app's current need; it does not mean training or reproducing all of ElevenLabs. Their listed batch speech-to-text rate is $0.22 per audio hour, approximately 1.83 cents for five minutes, subject to plan conditions. This is a comparison only; the app does not integrate ElevenLabs. [Transcription documentation](https://elevenlabs.io/docs/overview/capabilities/speech-to-text), [API pricing](https://elevenlabs.io/pricing/api?price.section=speech_to_text)

## Selected demo provider and illustrative alternatives

The current Neeley cloud demo is configured for **OpenAI `gpt-6-luna`**, with a successful real synthetic coaching request. The prices below compare alternatives; they are not prices for the selected demo model. Measure its actual billed tokens and current provider rates before estimating demo coaching costs.

One rehearsal example uses **10,000 input tokens and 3,000 output tokens**, including the coaching instructions, script, rubric and report. These are assumptions; duration alone does not determine token cost. Thinking tokens, retries and unusually long rubrics can increase it.

| Model | Input / output per million tokens | Example coaching request |
| --- | --- | --- |
| DeepSeek Flash, off-peak | $0.15 / $0.60 | $0.0033 |
| DeepSeek Flash, peak | $0.30 / $1.20 | $0.0066 |
| Gemini 3.1 Flash-Lite | $0.25 / $1.50 | $0.0070 |
| Gemini 3.5 Flash-Lite | $0.30 / $2.50 | $0.0105 |

These are API usage charges; a key itself is a credential, not purchased usage. Evaluate report quality, evidence fidelity and provider data terms before choosing the cheapest candidate. Google lists paid-tier content as not used to improve products, unlike its free tier. Do not treat developer testing allowances as a funded student service. [DeepSeek official pricing](https://api-docs.deepseek.com/quick_start/pricing/), [Gemini official pricing](https://ai.google.dev/gemini-api/docs/pricing)

## Bark hosting calculation

Use **Modal Starter only** for the demo, with its current $30/month included compute allowance. Set the Workspace usage budget to **$30 before credits** and the separate spend limit to **$0 after credits**. Verify both in Usage & Billing before running workloads; no paid-plan upgrade is needed. Credits cover our compute worker, not external OpenAI coaching. [Modal budgets](https://modal.com/docs/guide/budgets), [Starter pricing](https://modal.com/pricing)

Modal lists L4 at $0.000222/GPU-second, CPU at $0.0000131/physical-core-second, and RAM at $0.00000222/GiB-second. Model startup and warm idle retention are billable; default idle retention is 60 seconds. Our optional adapter requests two CPU cores, 8 GiB RAM and sixty seconds of idle retention, with at most one worker and zero minimum containers. [Modal pricing](https://modal.com/pricing)

`speech cost = billable seconds × (0.000222 + CPU cores × 0.0000131 + RAM GiB × 0.00000222)`

At the adapter's resource allocation, **30–90 total billable seconds** cost approximately **$0.0080–$0.0239**. Adding the illustrative Gemini 3.1 Flash-Lite coaching call gives roughly **1.5–3.1 cents per rehearsal**, not an estimate for the selected OpenAI demo. This is a scenario, not measured GPU throughput: actual billable seconds include model loading, inference, idle retention and retries. It excludes Supabase base charges, storage, bandwidth, taxes and failed-job overhead. A server benchmark is required before quoting a pilot price.

Start with completed takes and a small PDC cohort. Record billable inference duration, provider token usage, error rates and coaching completion per job without logging speech content. Use a hard daily spending ceiling and per-user quotas. Owned infrastructure still needs concurrency limits and abuse protection. Expand to professors and speech/debate only after costs, transcription and coaching quality are measured.

## October 27 latency and provider review

The reported Modal request was `POST /prepare`, with zero live containers and one waiting for an L4 GPU. That is allocation delay before our model code runs. Preparing on sign-in can overlap that delay with the user's preparation time; it cannot guarantee available GPU capacity. Modal supports an ordered GPU fallback list. A T4 fallback offers another scheduling option at a lower per-second GPU rate, but must be measured for inference speed and transcript fidelity. Keeping an idle worker alive longer or permanently would increase cost. [GPU fallbacks](https://modal.com/docs/examples/gpu_fallbacks), [cold starts](https://modal.com/docs/guide/cold-start)

The current live implementation collects ten-second audio blocks and transcribes them sequentially. This imposes about ten seconds of initial collection delay even with a ready worker. Eight concurrent HTTP inputs allow control/cancellation requests through; the worker still admits one audio inference at a time. It is not a true streaming decoder. Uploaded recordings use sequential thirty-second windows. Model weights are already expanded during the image build, loaded with memory mapping, and reused across requests; there is no runtime model download.

Historical measurements should not be mixed into one benchmark. The older 27.72-second synthetic fixture took 61.22 seconds cold and 1.276 seconds warm. A later separate sixty-second synthetic test recorded 5.654 seconds enqueue-to-start plus 12.865 seconds execution, or 18.519 seconds total. Those are single observations, not latency guarantees or measurements of the currently stuck call. Browser-local tests on this computer recorded 1.707 seconds of warm WebGPU inference for sixty seconds of audio, versus 29.825 seconds on the single-thread CPU fallback. The browser model is about 703 MB; initial download, device capability, and battery use remain tradeoffs. These synthetic fixtures do not establish accuracy or speed on every student's device.

### Managed transcription comparison

Official rates checked October 27, 2026. Costs below are for ten minutes of audio, excluding coaching, storage, taxes, and optional features. Promotional rates and account/plan conditions may change.

| Service | Uploaded audio | Live audio | Rehearsal-specific considerations |
| --- | --- | --- | --- |
| Deepgram Nova-3, English | $0.043 | $0.048 promotional; $0.077 regular | Batch and streaming; word timings; explicitly enable `filler_words=true` to retain uh/um. |
| ElevenLabs Scribe v2 / v2 Realtime | $0.0367 | $0.065 | Batch and streaming; word timings; retain verbatim output rather than enabling `no_verbatim`. |
| OpenAI gpt-transcribe / gpt-live-transcribe | $0.045 | $0.17 | Current live model has no word timestamps; would need a separate timing method for precise speech analytics. |
| Groq Whisper large-v3-turbo | $0.0067 | No native streaming transcription in the inspected file API | Low-cost uploads; ten-second minimum billing per request; filler retention needs evaluation. |

Sources: [Deepgram pricing](https://deepgram.com/pricing), [Deepgram fillers](https://developers.deepgram.com/docs/filler-words), [ElevenLabs pricing](https://elevenlabs.io/pricing/api?price.section=speech_to_text), [ElevenLabs streaming](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies), [OpenAI file model](https://developers.openai.com/api/docs/models/gpt-transcribe), [OpenAI live transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [Groq speech API and pricing](https://console.groq.com/docs/speech-to-text).

A managed streaming service can receive small audio frames and return partial words while the user speaks, without our app acquiring and loading a dedicated GPU. Published model latency is not end-to-end latency for this app. Ten-second storage/recovery blocks could remain independent of the streaming transcript connection. OpenAI also documents direct speech-to-speech models, which can avoid a serial transcription, text generation, and speech synthesis pipeline; this does not establish ChatGPT's exact current internal deployment. [OpenAI voice architecture](https://developers.openai.com/api/docs/guides/realtime)

Recommendation: compare Deepgram Nova-3 and ElevenLabs Scribe on representative consented rehearsal audio, measuring first partial text, final completion time, words/fillers/repetitions, and actual billed usage. Keep provider changes explicit: no managed transcription provider has been enabled by this review. Native Apple apps can also use Apple's on-device SpeechAnalyzer/SpeechTranscriber, but that native framework is not a portable website replacement. [Apple speech APIs](https://developer.apple.com/videos/play/wwdc2025/277/)
