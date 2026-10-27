import asyncio
from pathlib import Path
import sys
import unittest

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import create_app, ProcessRunner
from test_worker import wav

USER = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
REQUEST = "33333333-3333-4333-8333-333333333333"
NEXT = "44444444-4444-4444-8444-444444444444"
KEY = f"{USER}:{REQUEST}"
TOKEN = "a" * 43
AUTH = {"Authorization": "Bearer " + TOKEN}


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.finish = asyncio.Event()
        self.cancelled = 0

    async def run(self, payload):
        self.calls.append(payload)
        self.started.set()
        try:
            await self.finish.wait()
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        return {"ok": True, "result": {"text": "Test speech.", "durationSeconds": 1,
                "model": "bark-3.0-plus", "chunks": []}}

    async def close(self):
        pass


class CancellationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runner = FakeRunner()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(
            app=create_app(token=TOKEN, runner=self.runner)), base_url="http://worker.test")

    async def asyncTearDown(self):
        await self.client.aclose()

    def speech(self, key=KEY, path="/transcribe"):
        return self.client.post(path, headers=AUTH | {"Content-Type": "audio/wav", "X-Rehearsal-Request": key},
                                content=b"" if path == "/prepare" else wav())

    def cancel(self, key=KEY):
        return self.client.post("/cancel", headers=AUTH, json={"requestId": key})

    async def test_cancel_is_authenticated_and_validated_without_touching_inference(self):
        for headers in [{}, {"Authorization": "Bearer wrong"}, {"Authorization": "Bearer " + "a" * 300}]:
            response = await self.client.post("/cancel", headers=headers, json={"requestId": KEY})
            self.assertEqual(response.status_code, 401)
        for body in [{}, {"requestId": REQUEST}, {"requestId": "private-text"},
                     {"requestId": KEY, "user": USER}, [], {"requestId": None}]:
            response = await self.client.post("/cancel", headers=AUTH, json=body)
            self.assertEqual(response.status_code, 400)
            self.assertNotIn("private-text", response.text)
        response = await self.client.post("/cancel", headers=AUTH, content=b"{}")
        self.assertEqual(response.status_code, 415)
        response = await self.client.post("/cancel?request=ignored", headers=AUTH, json={"requestId": KEY})
        self.assertEqual(response.status_code, 400)
        response = await self.client.post("/cancel", headers=AUTH | {"Content-Type": "application/json"}, content=b" " * 257)
        self.assertEqual(response.status_code, 413)
        async def oversized():
            yield b" " * 128
            yield b" " * 129
        response = await self.client.post("/cancel", headers=AUTH | {"Content-Type": "application/json"}, content=oversized())
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.runner.calls, [])

    async def test_invalid_inference_identity_fails_before_gpu_work(self):
        for key in [REQUEST, "", f"{USER}:invalid", "a" * 1000]:
            response = await self.speech(key)
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.runner.calls, [])

    async def test_cancel_enters_while_busy_and_releases_gate_for_next_request(self):
        running = asyncio.create_task(self.speech())
        await self.runner.started.wait()
        self.assertEqual((await self.speech(f"{USER}:{NEXT}")).status_code, 429)
        cancelled = await asyncio.wait_for(self.cancel(), 2)
        self.assertEqual(cancelled.status_code, 200)
        self.assertEqual(cancelled.json(), {"cancelled": True})
        self.assertEqual(cancelled.headers["Cache-Control"], "no-store")
        self.assertEqual((await running).status_code, 409)
        self.assertEqual(self.runner.cancelled, 1)
        self.runner.finish.set()
        response = await self.speech(f"{USER}:{NEXT}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.runner.cancelled, 1)

    async def test_another_owner_with_the_same_request_id_cannot_stop_running_inference(self):
        running = asyncio.create_task(self.speech())
        await self.runner.started.wait()
        response = await self.cancel(f"{OTHER}:{REQUEST}")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(running.done())
        self.assertEqual(self.runner.cancelled, 0)
        self.runner.finish.set()
        self.assertEqual((await running).status_code, 200)
        self.assertEqual((await self.speech(f"{OTHER}:{REQUEST}")).status_code, 409)
        self.assertEqual((await self.speech(KEY)).status_code, 200)

    async def test_cancel_before_arrival_blocks_all_matching_speech_routes(self):
        for _ in range(2):
            self.assertEqual((await self.cancel()).status_code, 200)
        for path in ["/prepare", "/transcribe-live", "/transcribe"]:
            self.assertEqual((await self.speech(path=path)).status_code, 409)
        self.assertEqual(self.runner.calls, [])
        self.runner.finish.set()
        self.assertEqual((await self.speech(f"{OTHER}:{REQUEST}")).status_code, 200)

    async def test_repeated_late_cancel_does_not_kill_the_next_rehearsal(self):
        running = asyncio.create_task(self.speech())
        await self.runner.started.wait()
        responses = await asyncio.gather(self.cancel(), self.cancel(), self.cancel())
        self.assertTrue(all(response.status_code == 200 for response in responses))
        self.assertEqual((await running).status_code, 409)
        self.assertEqual(self.runner.cancelled, 1)
        self.runner.started.clear()
        next_request = asyncio.create_task(self.speech(f"{USER}:{NEXT}"))
        await self.runner.started.wait()
        self.assertEqual((await self.cancel()).status_code, 200)
        self.assertFalse(next_request.done())
        self.assertEqual(self.runner.cancelled, 1)
        self.runner.finish.set()
        self.assertEqual((await next_request).status_code, 200)

    async def test_cancellation_during_upload_stops_before_inference(self):
        started = asyncio.Event()
        async def upload():
            yield wav()[:44]
            started.set()
            await asyncio.Event().wait()
        running = asyncio.create_task(self.client.post("/transcribe", headers=AUTH | {
            "Content-Type": "audio/wav", "X-Rehearsal-Request": KEY}, content=upload()))
        await started.wait()
        self.assertEqual((await asyncio.wait_for(self.cancel(), 2)).status_code, 200)
        self.assertEqual((await running).status_code, 409)
        self.assertEqual(self.runner.calls, [])

    async def test_tombstones_are_bounded_expire_and_are_not_speech_content(self):
        now = [0]
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(
            token=TOKEN, runner=self.runner, cancellation_limit=1, clock=lambda: now[0])), base_url="http://worker.test")
        async with client:
            self.assertEqual((await client.post("/cancel", headers=AUTH, json={"requestId": KEY})).status_code, 200)
            self.assertEqual((await client.post("/cancel", headers=AUTH, json={"requestId": KEY})).status_code, 200)
            self.assertEqual((await client.post("/cancel", headers=AUTH, json={"requestId": f"{USER}:{NEXT}"})).status_code, 429)
            now[0] = 601
            self.assertEqual((await client.post("/cancel", headers=AUTH, json={"requestId": f"{USER}:{NEXT}"})).status_code, 200)

    async def test_cancel_endpoint_kills_the_actual_subprocess_before_acknowledging(self):
        runner = ProcessRunner([sys.executable, "-c", "import time; time.sleep(30)"])
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(token=TOKEN, runner=runner)), base_url="http://worker.test")
        async with client:
            running = asyncio.create_task(client.post("/transcribe", headers=AUTH | {
                "Content-Type": "audio/wav", "X-Rehearsal-Request": KEY}, content=wav(600)))
            async with asyncio.timeout(5):
                while runner.process is None:
                    await asyncio.sleep(0.01)
            process = runner.process
            response = await asyncio.wait_for(client.post("/cancel", headers=AUTH, json={"requestId": KEY}), 5)
            self.assertEqual(response.status_code, 200)
            self.assertIsNone(runner.process)
            self.assertIsNotNone(process.returncode)
            self.assertEqual((await running).status_code, 409)
        await runner.close()


if __name__ == "__main__":
    unittest.main()
