import asyncio
import io
import json
from pathlib import Path
import struct
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from audio import AudioError, MAX_BYTES, decode_wav, windows


def wav(seconds=1, sample=b"\x00\x01"):
    pcm = sample * int(seconds * 16_000)
    return struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", len(pcm) + 36,
                       b"WAVE", b"fmt ", 16, 1, 1, 16_000, 32_000, 2, 16,
                       b"data", len(pcm)) + pcm


class AudioTests(unittest.TestCase):
    def test_canonical_wav_and_duration(self):
        pcm, duration = decode_wav(wav(0.5))
        self.assertEqual((len(pcm), duration), (16_000, 0.5))

    def test_rejects_truncation_metadata_wrong_encoding_and_duration(self):
        valid = wav()
        invalid = [b"", valid[:-1], valid + b"metadata", wav(0.49), wav(600.01)]
        for offset in [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]:
            changed = bytearray(valid)
            changed[offset] ^= 1
            invalid.append(changed)
        for payload in invalid:
            with self.subTest(size=len(payload)):
                with self.assertRaises(AudioError):
                    decode_wav(payload)

    def test_ten_minutes_has_no_gaps_overlap_or_oversized_windows(self):
        pcm, duration = decode_wav(wav(600))
        spans = list(windows(len(pcm) // 2))
        self.assertEqual(duration, 600)
        self.assertEqual(len(spans), 20)
        self.assertEqual(spans[0][0], 0)
        self.assertEqual(spans[-1][1], 9_600_000)
        for index, (start, end) in enumerate(spans):
            self.assertEqual(end - start, 480_000)
            if index:
                self.assertEqual(spans[index - 1][1], start)
        self.assertEqual(list(windows(480_001)), [(0, 480_000), (480_000, 480_001)])

    def test_live_accepts_one_sample_to_ten_seconds_only(self):
        for seconds in [1 / 16_000, 0.49, 10]:
            self.assertEqual(decode_wav(wav(seconds), live=True)[1], seconds)
        for seconds in [0, 10 + 1 / 16_000]:
            with self.assertRaises(AudioError):
                decode_wav(wav(seconds), live=True)


class EndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import httpx
        from server import create_app
        self.requests = []
        outer = self
        class FakeRunner:
            async def run(self, payload):
                outer.requests.append(payload)
                if not payload:
                    return {"ok": True, "result": {"ready": True, "model": "bark-3.0-plus"}}
                return {"ok": True, "result": {"text": "Um, I, I think so. Uh.",
                        "durationSeconds": 1, "chunks": [], "model": "bark-3.0-plus"}}
            async def close(self):
                pass
        self.runner = FakeRunner()
        self.token = "a" * 43
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(
            app=create_app(token=self.token, runner=self.runner)), base_url="http://worker.test")
        self.headers = {"Authorization": "Bearer " + self.token, "Content-Type": "audio/wav"}

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_authorization_before_audio_or_inference(self):
        for token in [None, "Bearer wrong", "Bearer " + "a" * 300]:
            headers = {"Content-Type": "audio/wav"}
            if token:
                headers["Authorization"] = token
            for path in ["/transcribe", "/transcribe-live", "/prepare"]:
                response = await self.client.post(path, headers=headers, content=wav())
                self.assertEqual(response.status_code, 401)
        self.assertEqual(self.requests, [])

    async def test_exact_output_preserves_fillers_and_no_caching(self):
        response = await self.client.post("/transcribe", headers=self.headers, content=wav())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "Um, I, I think so. Uh.")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertNotIn("access-control-allow-origin", response.headers)
        self.assertEqual(len(self.requests), 1)

    async def test_prepare_requires_empty_body_and_sends_control_frame(self):
        for body in [b"", b""]:
            response = await self.client.post("/prepare", headers=self.headers, content=body)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"ready": True, "model": "bark-3.0-plus"})
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(self.requests, [b"", b""])
        self.requests.clear()
        for path, body in [("/prepare", b"x"), ("/prepare?url=ignored", b"")]:
            response = await self.client.post(path, headers=self.headers, content=body)
            self.assertEqual(response.status_code, 400)
        async def streamed_body():
            yield b"x"
        response = await self.client.post("/prepare", headers=self.headers, content=streamed_body())
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.requests, [])

    async def test_live_small_tail_is_padded_but_reports_original_duration(self):
        for seconds in [1 / 16_000, 0.2, 10]:
            response = await self.client.post("/transcribe-live", headers=self.headers, content=wav(seconds))
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["durationSeconds"], seconds)
            self.assertEqual(decode_wav(self.requests[-1])[1], max(seconds, 0.5))
            self.assertEqual(response.json()["text"], "Um, I, I think so. Uh.")
        before = len(self.requests)
        for body, status in [(wav(0), 422), (wav(10.1), 413), (wav(1)[:-1], 422)]:
            response = await self.client.post("/transcribe-live", headers=self.headers, content=body)
            self.assertEqual(response.status_code, status)
        self.assertEqual(len(self.requests), before)

    async def test_only_live_no_speech_is_empty_success(self):
        async def no_speech(_):
            return {"ok": False, "status": 422, "code": "no_speech"}
        self.runner.run = no_speech
        response = await self.client.post("/transcribe-live", headers=self.headers, content=wav(0.2))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "")
        self.assertEqual(response.json()["durationSeconds"], 0.2)
        self.assertEqual((await self.client.post("/transcribe", headers=self.headers, content=wav())).status_code, 422)
        async def invalid(_):
            return {"ok": False, "status": 422, "code": "invalid_audio"}
        self.runner.run = invalid
        self.assertEqual((await self.client.post("/transcribe-live", headers=self.headers, content=wav())).status_code, 422)

    async def test_prepare_timeout_and_failure_are_safe(self):
        async def timeout(_):
            raise TimeoutError("private details")
        self.runner.run = timeout
        response = await self.client.post("/prepare", headers=self.headers)
        self.assertEqual(response.status_code, 504)
        self.assertNotIn("private", response.text)

    async def test_rejects_urls_compression_bad_type_and_length(self):
        cases = [
            ("/transcribe?url=https://internal/", {}, wav(), 400),
            ("/transcribe", {"Content-Encoding": "gzip"}, wav(), 400),
            ("/transcribe", {"Content-Type": "application/json"}, b'{}', 415),
            ("/transcribe", {"Content-Length": str(MAX_BYTES + 1)}, b"", 413),
            ("/transcribe", {"Content-Length": "x"}, b"", 413),
            ("/transcribe", {}, b"", 422),
            ("/transcribe", {}, wav()[:-1], 422),
        ]
        for path, headers, payload, expected in cases:
            response = await self.client.post(path, headers=self.headers | headers, content=payload)
            self.assertEqual(response.status_code, expected)
        self.assertEqual(self.requests, [])

    async def test_size_limit_applies_even_without_content_length(self):
        async def chunks():
            yield b"x" * (MAX_BYTES // 2)
            yield b"x" * (MAX_BYTES // 2 + 1)
        response = await self.client.post("/transcribe", headers=self.headers, content=chunks())
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.requests, [])

    async def test_engine_failures_do_not_echo_private_content(self):
        async def fail(_):
            raise RuntimeError("private transcript or secret")
        self.runner.run = fail
        response = await self.client.post("/transcribe", headers=self.headers, content=wav())
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private", response.text)

    async def test_parallel_request_is_rejected_without_inference(self):
        started, finish = asyncio.Event(), asyncio.Event()
        async def slow(_):
            started.set()
            await finish.wait()
            return {"ok": False, "status": 422}
        self.runner.run = slow
        first = asyncio.create_task(self.client.post("/transcribe", headers=self.headers, content=wav()))
        await started.wait()
        for path in ["/transcribe", "/transcribe-live", "/prepare"]:
            second = await self.client.post(path, headers=self.headers, content=wav() if path != "/prepare" else b"")
            self.assertEqual(second.status_code, 429)
        finish.set()
        self.assertEqual((await first).status_code, 422)

    async def test_no_docs_and_missing_secret_fails_closed(self):
        from server import create_app
        for token in ["", "short", " " * 43]:
            with self.assertRaises(RuntimeError):
                create_app(token=token)
        self.assertEqual((await self.client.get("/docs")).status_code, 404)


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_hung_inference_is_killed(self):
        from server import ProcessRunner
        runner = ProcessRunner([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.1)
        with self.assertRaises(TimeoutError):
            await runner.run(wav())
        self.assertIsNone(runner.process)

    async def test_oversized_protocol_response_is_rejected_and_process_killed(self):
        from server import ProcessRunner
        code = "import sys,struct; sys.stdout.buffer.write(struct.pack('!I',9999999)); sys.stdout.buffer.flush()"
        runner = ProcessRunner([sys.executable, "-c", code])
        with self.assertRaises(ValueError):
            await runner.run(wav())
        self.assertIsNone(runner.process)

    async def test_cancel_kills_inference(self):
        from server import ProcessRunner
        runner = ProcessRunner([sys.executable, "-c", "import time; time.sleep(30)"])
        task = asyncio.create_task(runner.run(wav()))
        await asyncio.sleep(0.1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIsNone(runner.process)


class ProtocolTests(unittest.TestCase):
    def test_prepare_and_audio_share_one_model_and_silence_has_distinct_code(self):
        import inference
        constructed = []
        class FakeBark:
            def __init__(self):
                constructed.append(self)
            def transcribe(self, _):
                raise inference.NoSpeechError("No speech")
        payload = wav()
        source = io.BytesIO(struct.pack("!III", 0, 0, len(payload)) + payload)
        target = io.BytesIO()
        with patch.object(inference, "Bark", FakeBark), patch.object(sys, "stdin", SimpleNamespace(buffer=source)), patch.object(sys, "stdout", SimpleNamespace(buffer=target)):
            inference.main()
        target.seek(0)
        messages = []
        while prefix := target.read(4):
            messages.append(json.loads(target.read(struct.unpack("!I", prefix)[0])))
        self.assertEqual(len(constructed), 1)
        self.assertEqual(len(messages), 3)
        self.assertTrue(messages[0]["result"]["ready"])
        self.assertTrue(messages[1]["result"]["ready"])
        self.assertEqual(messages[2]["code"], "no_speech")


if __name__ == "__main__":
    unittest.main()
