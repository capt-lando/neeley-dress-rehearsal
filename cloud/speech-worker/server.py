"""Server-to-server Bark endpoint. Audio is held in RAM, never written to disk."""
import asyncio
import hmac
import json
import os
from pathlib import Path
import re
import struct
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from audio import AudioError, LIVE_MAX_BYTES, MAX_BYTES, SAMPLE_RATE, decode_wav

INFERENCE_SECONDS = 120
UPLOAD_SECONDS = 20
MAX_RESPONSE_BYTES = 512 * 1024


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
            await process.wait()

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


def create_app(*, token=None, runner=None, upload_timeout=UPLOAD_SECONDS):
    secret = token if token is not None else os.environ.get("BARK_WORKER_TOKEN", "")
    if not isinstance(secret, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", secret):
        raise RuntimeError("Set BARK_WORKER_TOKEN to a random URL-safe secret of at least 43 characters.")
    engine = runner or ProcessRunner()
    gate = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(_):
        yield
        await engine.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def private_responses(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    async def handle(request: Request, *, live=False, prepare=False):
        supplied = request.headers.get("authorization", "")
        if len(supplied) > 256 or not hmac.compare_digest(supplied.encode(), ("Bearer " + secret).encode()):
            raise HTTPException(401, "Unauthorized.", headers={"WWW-Authenticate": "Bearer"})
        if request.query_params or request.headers.get("content-encoding", "identity") != "identity":
            raise HTTPException(400, "Send the WAV body without query parameters or compression.")
        if not prepare and request.headers.get("content-type", "").split(";", 1)[0].strip().lower() not in {"audio/wav", "audio/x-wav", "application/octet-stream"}:
            raise HTTPException(415, "Send a WAV audio body.")
        limit = 0 if prepare else LIVE_MAX_BYTES if live else MAX_BYTES
        length = request.headers.get("content-length")
        if length is not None and (not length.isdecimal() or len(length) > 9 or int(length) > limit):
            if prepare:
                raise HTTPException(400, "Send an empty preparation request.")
            raise HTTPException(413, "The recording is too large.")
        if gate.locked():
            raise HTTPException(429, "Speech worker is busy. Try again shortly.", headers={"Retry-After": "5"})
        async with gate:
            payload = bytearray()
            try:
                async with asyncio.timeout(upload_timeout):
                    async for piece in request.stream():
                        if len(payload) + len(piece) > limit:
                            if prepare:
                                raise HTTPException(400, "Send an empty preparation request.")
                            raise HTTPException(413, "The recording is too large.")
                        payload.extend(piece)
                duration = None if prepare else decode_wav(payload, live=live)[1]
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
                if prepare:
                    if result.get("ready") is not True:
                        raise HTTPException(503, "Speech recognition is temporarily unavailable.")
                    return JSONResponse({"ready": True, "model": "bark-3.0-plus"})
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
