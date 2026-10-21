# Model choices

Updated October 21, 2026 for the English-only static browser app. There is no hosted speech API and no Hugging Face token requirement. Hugging Face supplies public model files; the student's browser performs inference locally.

## English speech recognition

| Setting | Public ONNX model | Parameters | q8 weight download | Intended use |
| --- | --- | --- | --- | --- |
| Default: Whisper Base | `onnx-community/whisper-base.en` | 74 million | About 77 MB | Smaller download and lower resource use on ordinary student laptops. |
| Optional: Whisper Small | `onnx-community/whisper-small.en` | 244 million | About 249 MB | More capacity for difficult speech, with more memory and processing time. |

Sizes are the combined quantized encoder and merged decoder, not peak memory or the full first-use network transfer. Base's files are 23,201,320 + 53,692,803 bytes; Small's are 92,326,170 + 156,750,076 bytes. Tokenizer, configuration, and runtime files add overhead. [Base files](https://huggingface.co/onnx-community/whisper-base.en/tree/main/onnx), [Small files](https://huggingface.co/onnx-community/whisper-small.en/tree/main/onnx)

These are established Whisper models, not newly released 2026 speech architectures. The choice prioritizes a supported browser implementation, English recognition, manageable downloads, and transcript timing over release date. Small is an option, not a promise of sufficient performance on every computer.

## Browser execution

The app pins `@huggingface/transformers` **4.3.1** and Vite **8.3.4**. A dedicated worker loads `dtype: 'q8'`, tries WebGPU, and falls back to WebAssembly if graphics acceleration fails. WebAssembly uses one thread, so the static site does not require COOP/COEP headers that GitHub Pages cannot configure. Transformers.js is designed to run supported models directly in the browser. [Official Transformers.js documentation](https://huggingface.co/docs/transformers.js/index)

Recordings are resampled to 16 kHz locally. While recording, `lib/live-transcription.mjs` queues eight seconds of new audio per batch with two seconds of overlap. Model preparation runs independently of capture; one recognition job runs at a time, and the model stays loaded between batches. The overlap is joined using limited text matching, which is approximate and can affect boundary words. Paused audio is excluded. Stop flushes any remaining short batch while the complete audio saves separately; a successful final transcript is reused by Replay and Analyze.

Eight-second batches do not guarantee results every eight seconds. First-use downloads and warmup add delay; recognition can lag behind capture, and Small has run slower than real time in local testing. The app displays draft and backlog status instead of treating a partial transcript as complete. Cancellation or failure preserves audio for a whole-take retry. Uploaded, reopened, or retried complete takes use the worker's 30-second chunks with a 5-second stride. Segment timestamps are requested, but follow-along word highlighting remains approximate rather than a measured word-by-word alignment. The ten-minute recording cap is an application limit, not a processing-speed guarantee.

Both models are English-only. Do not pass `language` or `task` options to them: the pinned Whisper implementation rejects those options for English-only models. No automatic language detection or translation is offered. Word timestamps are a separate, more expensive feature and are not enabled here. [Whisper implementation](https://github.com/huggingface/transformers.js/blob/4.3.1/packages/transformers/src/models/whisper/modeling_whisper.js), [ASR pipeline](https://github.com/huggingface/transformers.js/blob/4.3.1/packages/transformers/src/pipelines/automatic-speech-recognition.js)

The browser may cache downloaded models across visits. That cache can be cleared or evicted; internet is required when files are missing. Audio never goes to Hugging Face or a coaching provider. This differs from the old Hugging Face Inference Providers design, which required a token and paid hosted inference. Legacy Nemotron/Qwen speech adapters remain only with the old server/reference tests.

## Why not the newest speech architecture?

Recent hosted ASR models do not automatically have a stable, compact browser export. Moonshine offers smaller local models, but its current Transformers.js pipeline does not provide the same chunking/timestamp path used here. New community streaming exports have different compatibility and validation needs. Switching solely for a newer release date would require new browser testing and a representative accuracy comparison. [Moonshine ONNX model](https://huggingface.co/onnx-community/moonshine-base-ONNX), [supported ASR implementations](https://github.com/huggingface/transformers.js/blob/4.3.1/packages/transformers/src/pipelines/automatic-speech-recognition.js)

## Coaching providers

Students select one provider and enter their own API key. The static app calls that provider directly from the browser; it has no proxy or embedded owner credential. The key exists only in tab memory, never in the prompt or persistent browser storage. Chat subscriptions and API billing are separate products.

| Provider | Default model | API |
| --- | --- | --- |
| OpenAI | `gpt-6-luna` | Responses, with `store: false` |
| Anthropic | `claude-haiku-5-5` | Messages |
| Google | `gemini-3.8-flash` | Gemini `generateContent` |

Defaults follow the providers' current model catalogs; account access and availability can change. [OpenAI model](https://developers.openai.com/api/docs/models/gpt-6-luna), [Claude models](https://platform.claude.com/docs/en/models/overview), [Gemini model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)

Anonymous CORS preflight requests checked on October 20, 2026 allowed the required browser request headers for all three endpoints. This confirms the preflight configuration at that time, not an authenticated coaching result. Anthropic additionally requires its direct-browser-access opt-in header; Google receives the key in a header, never a URL. Direct browser keys belong to the student and remain readable by the running page, so an app-owner key must never be bundled. [OpenAI SDK browser guidance](https://github.com/openai/openai-node), [Anthropic client](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts), [Google JavaScript SDK](https://github.com/googleapis/js-genai)

## Accuracy boundaries and verification

A real browser test using Whisper Base with WebGPU recovered all 42 words from one clean, synthesized English sample lasting 19.83 seconds. It used no API key and made no audio upload. This verifies an actual browser transcription path; it is not a student-speech benchmark or a measurement of filler accuracy. Local reporting and the prompt preview were also checked with script and talking points together. Real microphone recordings, longer takes, and authenticated coaching remain practical checks.

General speech recognition can normalize away fillers, repetitions, and false starts. Neither option has been validated here for filler recall on student presentations. Counts mean detected transcript occurrences, not every sound in the recording. Students can correct the transcript before requesting coaching. Count “like” separately because many uses are grammatical; mark repetitions as possible repetitions, not a stutter diagnosis. Missed points cannot prove someone forgot their script.

For an accuracy evaluation, compare both models on the same representative English recordings. Measure transcript errors, filler recall and false positives, transcription time after the initial download, and peak resource use. Do not infer verbatim accuracy from a general word-error-rate benchmark.
