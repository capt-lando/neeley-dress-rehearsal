# Bark cloud speech worker

This separate service runs **Bark 3.0 Plus** on a CUDA GPU. Students do not download weights or supply a speech key. It does not use ElevenLabs. The existing browser speech implementation remains available until cloud deployment has passed real inference tests.

## Contract

`POST /transcribe` accepts a raw canonical RIFF WAV: mono, 16 kHz, PCM16, 0.5–600 seconds, at most 20 MiB. The app already produces this format. Send `Content-Type: audio/wav` and `Authorization: Bearer <BARK_WORKER_TOKEN>`. No multipart forms, URLs, compressed bodies, or user-selected models are accepted.

Success: `{ "text": "...", "durationSeconds": 123.4, "chunks": [], "model": "bark-3.0-plus" }`. Error statuses include 401 (authorization), 413 (size), 415 (type), 422 (audio/no speech), 429 (busy), 503 (unavailable), and 504 (timeout). The caller must check HTTP status; errors never contain upstream stack traces or transcript text.

Thirty-second disjoint windows bound inference memory. Text is joined without filler removal or repetition deduplication. Plus can still miss audible fillers; it is not a perfect verbatim detector. The model is reused across requests, and the processor/config are loaded only from pinned local files. No remote code selection or runtime downloads are accepted. The reviewed publisher loader is SHA-256 checked; only its weight-decoding function is used.

## Deploy when a compute account is ready

The provided Modal adapter is optional; it is configured for one L4 worker, two CPU cores, 8 GiB RAM, and ten seconds of idle retention. Do not deploy before setting a provider budget. Model build/loading and idle retention are billable as well as inference. The 120-second process deadline includes first model load; cold-start behavior must be measured before launch.

1. Use Python 3.11 and install `modal==1.6.2` in a dedicated environment; sign in to the chosen Modal account.
2. Create a Modal secret named `neeley-bark-worker`, containing `BARK_WORKER_TOKEN`. Generate a random URL-safe value with at least 32 random bytes (43 characters). Store that same value only in backend secrets.
3. From this directory run `modal deploy modal_app.py`. This builds dependencies and downloads fixed public model assets; it creates billable cloud infrastructure.
4. Create a Modal proxy-auth token. Proxy authentication is required and rejects unauthorized requests before a GPU container boots. Store its key/secret in the backend as `BARK_WORKER_MODAL_KEY` and `BARK_WORKER_MODAL_SECRET`.
5. Set backend `BARK_WORKER_URL` to the deployed HTTPS URL ending in `/transcribe`, plus `BARK_WORKER_TOKEN`. The gateway sends `Modal-Key` and `Modal-Secret` headers as well as Bearer authorization. None of these secrets belongs in frontend configuration or GitHub source.
6. Test real recordings, fillers, cancellation, ten-minute inputs, cold start, peak concurrency, and actual billed time. The worker code and non-GPU tests are a foundation, **not evidence that a GPU deployment has passed validation**.

For another GPU host: install `requirements.txt`, run `python models.py` during image build, set `BARK_WORKER_TOKEN`, then run `uvicorn server:create_app --factory --host 127.0.0.1 --port 8000 --no-access-log`. Put it behind a TLS reverse proxy that rejects unauthorized/oversized traffic, limits request rates, and has a finite request timeout. Do not expose the bare development server publicly. Use one Uvicorn worker per GPU; multiple processes duplicate model memory and bypass the local concurrency gate.

## Data handling and limits

Audio stays in RAM in this service; there are no audio temporary files. It is released after each request. The isolated inference process is killed on timeout or cancellation so GPU work cannot continue indefinitely. Uploads time out after 20 seconds; inference after 120. The service does not log recordings, transcripts, keys, or provider responses; child-process output is suppressed. Deployment-platform metadata/log retention still follows the chosen host's configuration.

Supabase owns private saved rehearsal storage and retention. This worker stores neither rehearsal history nor analytics. Server authentication, per-user quotas, daily spending caps and job ownership must be enforced at the gateway; a shared worker credential is not student authorization. Never send it to a browser. A canceled browser request may still finish at the gateway, so use server job cancellation and measured usage accounting rather than promising zero charge after cancel.

## Tests without models or a GPU

In a dedicated Python environment, install `requirements-test.txt`, then run `python -m unittest discover -s tests -v` from this directory (or `python -m unittest discover -s cloud/speech-worker/tests -v` from the repository root). Tests cover strict WAV limits, complete segmentation, authorization, request size/type, safe errors, concurrency, timeout and real subprocess cancellation. They do not download weights or test CUDA accuracy. Direct runtime dependencies and model/config revisions are pinned; transitive dependency resolution and the base OS are not a reproducible lockfile yet.

## Attribution

Bark 3.0 Plus is post-trained and compressed by Conway Research, derived from NVIDIA Corporation's [parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) through Moondream's [parakeet-ultra](https://huggingface.co/moondream/parakeet-ultra), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). [Original Plus model and source](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Plus). The image includes the publisher's NOTICE. This integration adds fixed revisions, offline processor reuse, bounded segmentation, authentication, and request/process limits; it does not alter model weights.
