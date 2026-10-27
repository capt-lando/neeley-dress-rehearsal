"""Server-to-server Bark endpoint. Audio is held in RAM, never written to disk."""
import asyncio
import hmac
import json
import os
from pathlib import Path
import re
import struct
import sys
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from audio import AudioError, LIVE_MAX_BYTES, MAX_BYTES, SAMPLE_RATE, decode_wav

INFERENCE_SECONDS = 120
UPLOAD_SECONDS = 20
MAX_RESPONSE_BYTES = 512 * 1024
REQUEST_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
CANCELLATION_SECONDS = 600
MAX_CANCELLATIONS = 4096


class ProcessRunner:
    def __init__(self, command=None, timeout=INFERENCE_SECONDS):
        self.command = command or [sys.executable, str(Path(__file__).with_name("inference.py"))]
        self.timeout = timeout
        self.process = None

    async def close(self):
        process, self.process = self.process, None
        if process is not None:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            # Drain/close the pipes as well as reaping the process. A canceled
            # ten-minute upload can still have bytes buffered on stdin.
            await process.communicate()

    async def run(self, payload):
        try:
            async with asyncio.timeout(self.timeout):
                if self.process is None or self.process.returncode is not None:
                    await self.close()
                    self.process = await asyncio.create_subprocess_exec(
                        *self.command, stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                self.process.stdin.write(struct.pack("!I", len(payload)) + payload)
                await self.process.stdin.drain()
                size = struct.unpack("!I", await self.process.stdout.readexactly(4))[0]
                if not 1 <= size <= MAX_RESPONSE_BYTES:
                    raise ValueError("Invalid worker response size.")
                return json.loads(await self.process.stdout.readexactly(size))
        except BaseException:
            # A timeout/cancel actually kills inference, rather than leaving a GPU thread running.
            await self.close()
            raise


def create_app(*, token=None, runner=None, upload_timeout=UPLOAD_SECONDS,
               cancellation_limit=MAX_CANCELLATIONS, clock=time.monotonic,
               request_timeout=INFERENCE_SECONDS, wall_clock=time.time):
    secret = token if token is not None else os.environ.get("BARK_WORKER_TOKEN", "")
    if not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", secret):
        raise RuntimeError("Set BARK_WORKER_TOKEN to a random URL-safe secret of at least 43 characters.")
    engine = runner or ProcessRunner()
    gate = asyncio.Lock()
    cancellations = {}
    requests = {}
    preparation = None
    preparation_waiters = set()

    def prune_cancellations():
        now = clock()
        for key, expires in list(cancellations.items()):
            if expires <= now:
                del cancellations[key]

    def authorize(request):
        supplied = request.headers.get("authorization", "")
        if len(supplied) > 256 or not hmac.compare_digest(supplied.encode(), ("Bearer " + secret).encode()):
            raise HTTPException(401, "Unauthorized.", headers={"WWW-Authenticate": "Bearer"})
        if request.query_params or request.headers.get("content-encoding", "identity") != "identity":
            raise HTTPException(400, "Send the request body without query parameters or compression.")

    def request_key(value, *, required=False):
        if value is None and not required:
            # Rollout compatibility for the previously deployed authenticated gateway.
            return None
        if not isinstance(value, str) or not REQUEST_ID.fullmatch(value):
            raise HTTPException(400, "Use a valid rehearsal request identifier.")
        return value.lower()

    @asynccontextmanager
    async def lifespan(_):
        yield
        pending = list(requests)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if preparation is not None:
            preparation.cancel()
            await asyncio.gather(preparation, return_exceptions=True)
        await engine.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def private_responses(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    async def handle(request: Request, *, live=False, prepare=False):
        authorize(request)
        key = request_key(request.headers.get("x-rehearsal-request"))
        expires = request.headers.get("x-rehearsal-prepare-expires")
        deadline = None
        if expires is not None:
            if not prepare or not re.fullmatch(r"[0-9]{13}", expires):
                raise HTTPException(400, "Use a valid preparation deadline.")
            deadline = int(expires) / 1000
            remaining = deadline - wall_clock()
            if remaining <= 0:
                raise HTTPException(408, "This preparation request expired.")
            if remaining > 150:
                raise HTTPException(400, "Use a bounded preparation deadline.")
        prune_cancellations()
        if key in cancellations:
            raise HTTPException(409, "This speech request was canceled.")
        if not prepare and request.headers.get("content-type", "").split(";", 1)[0].strip().lower() not in {"audio/wav", "audio/x-wav", "application/octet-stream"}:
            raise HTTPException(415, "Send a WAV audio body.")
        limit = 0 if prepare else LIVE_MAX_BYTES if live else MAX_BYTES
        length = request.headers.get("content-length")
        if length is not None and (not length.isdecimal() or len(length) > 9 or int(length) > limit):
            if prepare:
                raise HTTPException(400, "Send an empty preparation request.")
            raise HTTPException(413, "The recording is too large.")
        if gate.locked() and preparation is None:
            raise HTTPException(429, "Speech worker is busy. Try again shortly.", headers={"Retry-After": "5"})

        async def read_payload():
            payload = bytearray()
            async with asyncio.timeout(upload_timeout):
                async for piece in request.stream():
                    if len(payload) + len(piece) > limit:
                        if prepare:
                            raise HTTPException(400, "Send an empty preparation request.")
                        raise HTTPException(413, "The recording is too large.")
                    payload.extend(piece)
            return payload

        async def operation():
            payload = bytearray()
            try:
                if prepare:
                    payload = await read_payload()
                    await prepare_model()
                    return JSONResponse({"ready": True, "model": "bark-3.0-plus"})
                # Sign-in preparation is shared, but audio inference never is.
                # Hold the request's own cancellation scope while waiting.
                if preparation is not None:
                    await join_preparation(preparation)
                if gate.locked():
                    raise HTTPException(429, "Speech worker is busy. Try again shortly.", headers={"Retry-After": "5"})
                async with gate:
                    payload = await read_payload()
                    duration = decode_wav(payload, live=live)[1]
                    if live and len(payload) < 44 + SAMPLE_RATE:
                        # The model receives at least 0.5 seconds; keep the real tail duration below.
                        payload.extend(b"\0" * (44 + SAMPLE_RATE - len(payload)))
                        struct.pack_into("<I", payload, 4, len(payload) - 8)
                        struct.pack_into("<I", payload, 40, len(payload) - 44)
                    message = await engine.run(bytes(payload))
                if message.get("ok") is not True:
                    if live and message.get("code") == "no_speech":
                        return JSONResponse({"text": "", "durationSeconds": duration,
                                             "chunks": [], "model": "bark-3.0-plus"})
                    status = 422 if message.get("status") == 422 else 503
                    detail = "No usable speech was detected. Try another recording." if status == 422 else "Speech recognition is temporarily unavailable."
                    raise HTTPException(status, detail)
                result = message["result"]
                if live:
                    result = result | {"durationSeconds": duration}
                return JSONResponse(result)
            except AudioError as error:
                raise HTTPException(422, str(error)) from None
            except TimeoutError:
                raise HTTPException(504, "Speech recognition timed out. Try again shortly.") from None
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(503, "Speech recognition is temporarily unavailable.") from None
            finally:
                payload.clear()

        async def bounded_operation():
            # Preparation waiting, upload, and inference share one deadline;
            # joining a warmup must not grant a second full inference timeout.
            timeout = request_timeout if deadline is None else min(request_timeout, max(0, deadline - wall_clock()))
            try:
                async with asyncio.timeout(timeout):
                    return await operation()
            except TimeoutError:
                raise HTTPException(504, "Speech recognition timed out. Try again shortly.") from None

        # No await separates the cancellation check and operation registration.
        if key in cancellations:
            raise HTTPException(409, "This speech request was canceled.")
        task = asyncio.create_task(bounded_operation())
        requests[task] = key
        try:
            return await task
        except asyncio.CancelledError:
            if key in cancellations:
                raise HTTPException(409, "This speech request was canceled.") from None
            raise
        finally:
            requests.pop(task, None)

    async def join_preparation(task):
        if task.cancelling():
            raise HTTPException(429, "Speech worker is busy. Try again shortly.", headers={"Retry-After": "5"})
        waiter = asyncio.current_task()
        preparation_waiters.add(waiter)
        try:
            await asyncio.shield(task)
        finally:
            preparation_waiters.discard(waiter)
            # One canceled user must not discard another user's model warmup.
            # If everybody leaves, stop the actual work before acknowledging.
            if not preparation_waiters and not task.done():
                if not task.cancelling():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def prepare_model():
        nonlocal preparation
        if preparation is None:
            if gate.locked():
                raise HTTPException(429, "Speech worker is busy. Try again shortly.", headers={"Retry-After": "5"})
            # An unlocked asyncio.Lock acquires immediately. Register the shared
            # task before yielding, so two arrivals cannot create two warmups.
            await gate.acquire()

            async def run():
                nonlocal preparation
                try:
                    message = await engine.run(b"")
                    if message.get("ok") is not True or message.get("result", {}).get("ready") is not True:
                        raise HTTPException(503, "Speech recognition is temporarily unavailable.")
                finally:
                    preparation = None
                    gate.release()

            preparation = asyncio.create_task(run())
        await join_preparation(preparation)

    @app.post("/cancel")
    async def cancel(request: Request):
        # This control route deliberately does not acquire the inference gate.
        authorize(request)
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise HTTPException(415, "Send the cancellation request as JSON.")
        length = request.headers.get("content-length")
        if length is not None and (not length.isdecimal() or len(length) > 3 or int(length) > 256):
            raise HTTPException(413, "The cancellation request is too large.")
        payload = bytearray()
        try:
            async with asyncio.timeout(min(upload_timeout, 5)):
                async for piece in request.stream():
                    if len(payload) + len(piece) > 256:
                        raise HTTPException(413, "The cancellation request is too large.")
                    payload.extend(piece)
            body = json.loads(payload)
            if not isinstance(body, dict) or set(body) != {"requestId"}:
                raise ValueError()
            key = request_key(body["requestId"], required=True)
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(400, "Send a valid cancellation request.") from None
        except TimeoutError:
            raise HTTPException(408, "The cancellation request timed out.") from None
        finally:
            payload.clear()
        prune_cancellations()
        if key not in cancellations and len(cancellations) >= cancellation_limit:
            raise HTTPException(429, "Cancellation capacity is temporarily unavailable.", headers={"Retry-After": "5"})
        cancellations[key] = clock() + CANCELLATION_SECONDS
        current = [task for task, owner in list(requests.items()) if owner == key]
        for task in current:
            # Repeated control calls must not interrupt the first kill/pipe cleanup.
            if not task.cancelling():
                task.cancel()
        for task in current:
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                pass
            except Exception:
                # The request handler sanitizes failures; cancellation is still acknowledged.
                pass
        return JSONResponse({"cancelled": True})

    @app.post("/prepare")
    async def prepare(request: Request):
        return await handle(request, prepare=True)

    @app.post("/transcribe-live")
    async def transcribe_live(request: Request):
        return await handle(request, live=True)

    @app.post("/transcribe")
    async def transcribe(request: Request):
        return await handle(request)

    return app
