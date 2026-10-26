# Speech models

Updated October 26, 2026. Speech recognition runs locally in a browser worker, with no speech API key or backend. Hugging Face supplies public weights; recordings are not uploaded for transcription.

## Bark 3.0 choices

| Setting | Browser export | Model download |
| --- | --- | --- |
| Default: Bark 3.0 Plus | velddev/Underdog-Bark-3.0-Plus-sherpa-onnx | About 703 MB |
| Bark 3.0 Standard | ai-ecoverse/Underdog-Bark-3.0-ONNX | About 524 MB with graphics acceleration; 911 MB on CPU |
| Bark 3.0 Clean | velddev/Underdog-Bark-3.0-Clean-sherpa-onnx | About 703 MB |
| Bark 3.0 Pro | No compatible public browser export verified | Unavailable in this app |

Plus and Standard aim to preserve fillers and repetitions. Clean deliberately edits them out and is unsuitable for measuring filler frequency; settings show this limitation. Pro is visibly disabled rather than mapped to a different model. All enabled options are English speech recognition, not Suno Bark text-to-speech.

The official 163–180 MB downloads use the publisher's compressed native runtime. These browser exports are larger and have different quantization, memory requirements, and performance. Runtime/config/tokenizer files add overhead; download size is not peak memory. Models are fetched only when needed, not bundled with the website or plugin. Browser caching is best effort and may be denied or evicted.

Sources: [official Standard](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0), [official Plus](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Plus), [Standard ONNX](https://huggingface.co/ai-ecoverse/Underdog-Bark-3.0-ONNX), [Plus ONNX](https://huggingface.co/velddev/Underdog-Bark-3.0-Plus-sherpa-onnx), [Clean ONNX](https://huggingface.co/velddev/Underdog-Bark-3.0-Clean-sherpa-onnx).

## Implementation

`lib/speech-models.mjs` pins each export to an immutable revision. `lib/bark-loader.mjs` retrieves and caches those files; only registered models are accepted. ONNX Runtime Web is pinned to `1.31.0-dev.20260914-8d85527a0`. The engine uses the Parakeet feature extractor from Transformers.js 4.3.1 and a bounded greedy token-and-duration decoder. Standard has a fused decoder/joiner; Plus and Clean have separate prediction and joiner graphs. The decoder retains repeated tokens and commits recurrent states only on nonblank output.

The encoder attempts WebGPU, with a single-thread WebAssembly fallback. No cross-origin isolation headers are required. A failure releases sessions and retries CPU once. Cancellation terminates the worker. Model switches discard the previous engine and transcript but preserve the recording.

Live drafts use windows of at most 30 seconds: the first batch contains 30 seconds, and each later full batch contains 28 new seconds plus two seconds of overlap. Results appear when each batch finishes processing; the window length does not guarantee a display delay. Model preparation is separate from recording, pause excludes audio, and Stop flushes remaining audio even when it is shorter than a full window. If the live path fails, the recording remains available for complete-take transcription. Uploaded, restored, and retried takes are split internally at quiet points into disjoint windows of at most 30 seconds; their text is joined without removing repetitions. Digitally silent input is skipped. Follow-along highlighting is approximate, not measured word alignment.

## Browser verification

An October 26 check of the new 30-second cadence captured 113.49 seconds through a prerecorded microphone source using actual Plus weights in this Windows browser. Three full windows each contained 480,000 samples at 16 kHz and processed in 2.689, 1.633, and 1.357 seconds on WebGPU. Stop immediately dispatched the remaining 29.49-second window, including overlap, which completed in 1.686 seconds. The queue drained to zero; pause/resume, browser autosave, and replay worked without retranscription or console errors. Model download, loading, and warmup took 38.759 seconds separately. These are device-specific synthetic checks, not guaranteed latency or an accuracy benchmark.

The remaining measurements below were recorded before the change to 30-second live windows. They preserve the earlier eight-second batch and complete-take test results; they are not measurements of the new live cadence.

Real browser tests on this Windows machine used controlled synthesized audio and actual downloaded model weights. Standard WebGPU transcribed an eight-second excerpt in 4.95 seconds on its first inference. A warm 27.72-second filler recording took 2.86 seconds and matched every word, including um/uh and repeated words. A 57.67-second presentation took 3.94 seconds, retained its ending, negation and numbers, but made minor word errors such as brake/break.

Plus WebGPU transcribed the same eight-second excerpt in 3.75 seconds after model loading. Its warm 27.72-second filler recording took 2.09 seconds and matched every word. A complete 57.67-second take took 3.78 seconds, with accurate spoken content but some awkward currency formatting. Plus also transcribed eight seconds on the single-thread CPU fallback in 5.85 seconds after loading. First-use download and initialization were measured separately and depend on connection/cache/device. These small synthetic checks establish a working path, not universal speed or accuracy on student speech.

The production website also transcribed the filler sample with Clean (removing fillers) and then Plus (retaining them) after a model switch, without losing the saved recording. A prerecorded microphone source exercised actual capture, live model warmup, eight-second batches, pause/resume, and Stop. This verifies the recording pipeline without claiming physical microphone permission in the embedded Codex host.

Students can correct the transcript before coaching. Counts are detected transcript occurrences, not every audible sound. Repetitions are not stutter diagnoses, and omitted talking points do not prove someone forgot a script.

An October 26 endurance run lasted 26 minutes 53 seconds and captured 25 minutes 11 seconds across three takes (10 minutes, 10 minutes, and 5 minutes 11 seconds). All 189 live batches completed, the queue drained, each take saved, and replay worked. Both ten-minute takes stopped and flushed automatically; a 25-second pause was excluded from the third recording. Tests used a prerecorded microphone source and actual model weights in the Windows browser, not a physical-microphone permission test.

The longer filler test exposed a real accuracy limit: across 21 complete repeated passages, Plus omitted seven audible fillers and inserted one extra “um,” while preserving each “I, I” repetition. A separate raw-output check confirmed omissions could already be present in the model output before overlap merging. Warm eight-second requests in that diagnostic took 0.237–0.372 seconds. These device-specific results do not promise every filler will be detected. Invalid, silent, too-short, and over-limit uploads were also checked; a 599-second take survived cancellation, retry, and restoration.

## Attribution

Bark is post-trained and compressed by Conway Research, based on NVIDIA Corporation's parakeet-tdt-0.6b-v3 and Moondream's parakeet-ultra, under CC BY 4.0. Browser exports are by ai-ecoverse and velddev. Attribution appears beneath the title, in settings, and in the footer. See `MODEL-NOTICE.txt` for source links, modifications, revisions, and license information. The adapted inference code includes the Apache 2.0 license in `LICENSES/Apache-2.0.txt`; both notices ship with the website and plugin.

## Coaching

The website sends text directly to the user's selected OpenAI, Anthropic, Google, DeepSeek, or Meta API using a key held in tab memory. Speech recognition requires no second key. The paused Codex plugin edition uses its conversation for coaching. Speech-model selection does not change coaching providers, prompt inputs, evidence validation, or account billing.
