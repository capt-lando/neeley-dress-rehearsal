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
from audio import AudioError, MAX_BYTES, decode_wav

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

    @app.post("/transcribe")
    async def transcribe(request: Request):
        supplied = request.headers.get("authorization", "")
        if len(supplied) > 256 or not hmac.compare_digest(supplied.encode(), ("Bearer " + secret).encode()):
            raise HTTPException(401, "Unauthorized.", headers={"WWW-Authenticate": "Bearer"})
        if request.query_params or request.headers.get("content-encoding", "identity") != "identity":
            raise HTTPException(400, "Send the WAV body without query parameters or compression.")
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() not in {"audio/wav", "audio/x-wav", "application/octet-stream"}:
            raise HTTPException(415, "Send a WAV audio body.")
        length = request.headers.get("content-length")
        if length is not None and (not length.isdecimal() or len(length) > 9 or int(length) > MAX_BYTES):
            raise HTTPException(413, "The recording is too large.")
        if gate.locked():
            raise HTTPException(429, "Speech worker is busy. Try again shortly.", headers={"Retry-After": "5"})
        async with gate:
            payload = bytearray()
            try:
                async with asyncio.timeout(upload_timeout):
                    async for piece in request.stream():
                        if len(payload) + len(piece) > MAX_BYTES:
                            raise HTTPException(413, "The recording is too large.")
                        payload.extend(piece)
                decode_wav(payload)
                message = await engine.run(bytes(payload))
                if message.get("ok") is not True:
                    status = 422 if message.get("status") == 422 else 503
                    detail = "No usable speech was detected. Try another recording." if status == 422 else "Speech recognition is temporarily unavailable."
                    raise HTTPException(status, detail)
                return JSONResponse(message["result"])
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

    return app
