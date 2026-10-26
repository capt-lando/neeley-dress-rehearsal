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

Live drafts retain eight seconds of new audio with two seconds of overlap. Results appear when each batch finishes, not necessarily every eight seconds. Model preparation is separate from recording, pause excludes audio, and Stop flushes remaining audio. If the live path fails, the recording remains available for complete-take transcription. Uploaded, restored, and retried takes are split internally at quiet points into disjoint windows of at most 30 seconds; their text is joined without removing repetitions. Digitally silent input is skipped. Follow-along highlighting is approximate, not measured word alignment.

## Browser verification

Real browser tests on this Windows machine used controlled synthesized audio and actual downloaded model weights. Standard WebGPU transcribed an eight-second excerpt in 4.95 seconds on its first inference. A warm 27.72-second filler recording took 2.86 seconds and matched every word, including um/uh and repeated words. A 57.67-second presentation took 3.94 seconds, retained its ending, negation and numbers, but made minor word errors such as brake/break.

Plus WebGPU transcribed the same eight-second excerpt in 3.75 seconds after model loading. Its warm 27.72-second filler recording took 2.09 seconds and matched every word. A complete 57.67-second take took 3.78 seconds, with accurate spoken content but some awkward currency formatting. Plus also transcribed eight seconds on the single-thread CPU fallback in 5.85 seconds after loading. First-use download and initialization were measured separately and depend on connection/cache/device. These small synthetic checks establish a working path, not universal speed or accuracy on student speech.

The production website also transcribed the filler sample with Clean (removing fillers) and then Plus (retaining them) after a model switch, without losing the saved recording. A prerecorded microphone source exercised actual capture, live model warmup, eight-second batches, pause/resume, and Stop. This verifies the recording pipeline without claiming physical microphone permission in the embedded Codex host.

Students can correct the transcript before coaching. Counts are detected transcript occurrences, not every audible sound. Repetitions are not stutter diagnoses, and omitted talking points do not prove someone forgot a script.

## Attribution

Bark is post-trained and compressed by Conway Research, based on NVIDIA Corporation's parakeet-tdt-0.6b-v3 and Moondream's parakeet-ultra, under CC BY 4.0. Browser exports are by ai-ecoverse and velddev. Attribution appears in settings and the footer. See `MODEL-NOTICE.txt` for source links, modifications, revisions, and license information. The adapted inference code includes the Apache 2.0 license in `LICENSES/Apache-2.0.txt`; both notices ship with the website and plugin.

## Coaching

The website still sends text directly to the user's selected OpenAI, Anthropic, or Google API using a key held in tab memory. Speech recognition requires no second key. The Codex plugin uses the current conversation for coaching. Speech-model selection does not change coaching providers, prompt inputs, evidence validation, or account billing.
