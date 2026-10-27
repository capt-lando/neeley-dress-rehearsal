# Speech and coaching costs

Rates checked October 27, 2026. Provider prices can change. These estimates exclude coaching, storage, network charges, and taxes.

| Speech API | Per audio minute | Ten-minute take |
| --- | --- | --- |
| OpenAI `gpt-live-transcribe` | $0.017 | $0.17 |
| OpenAI `gpt-transcribe` for uploads | $0.0045 | $0.045 |

Sources: [live transcription](https://developers.openai.com/api/docs/guides/realtime-transcription), [live model](https://developers.openai.com/api/docs/models/gpt-live-transcribe), [file model](https://developers.openai.com/api/docs/models/gpt-transcribe).

Both use the existing server-held OpenAI API account. GPT coaching is a separate text request after **Analyze**. Chat messages also use the configured coaching model. Actual coaching cost depends on input, output, and any reasoning tokens; recording duration alone does not determine it.

The pilot reserves $0.30 per live take and $0.075 per upload against its existing $5 daily admission allowance. Coaching and chat have their own configured reserves. Reservations bound admission and are not invoices. Per-user limits, a ten-minute audio cap, storage quotas, and atomic request ownership remain in force. The user's coding-agent credits are separate from this application's API budget.

Streaming sends small audio frames immediately and reuses the same take through connection renewals. It does not wait for a ten-second batch. There is no separately allocated GPU, model-weight download, or idle-worker charge. OpenAI still bills audio processing, including audio sent before cancellation.

The real 101-second integration run, its short upload, and cancellation checks used approximately $0.0295 of speech processing at the published rates. See [verification evidence](cloud-pilot.md) for measured readiness, first text, and final-save timings. These tests used synthetic speech and do not establish accuracy across speakers or devices.

Measure representative consented rehearsal audio before making broader speed or accuracy claims. Counts of fillers and repetitions depend on the transcript; a verbatim prompt does not guarantee every sound is preserved.
