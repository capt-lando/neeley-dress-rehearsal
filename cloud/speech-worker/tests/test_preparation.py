import asyncio
from pathlib import Path
import sys
import unittest

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import create_app
from test_worker import wav

USER = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
REQUEST = "33333333-3333-4333-8333-333333333333"
NEXT = "44444444-4444-4444-8444-444444444444"
KEY = f"{USER}:{REQUEST}"
OTHER_KEY = f"{OTHER}:{NEXT}"
TOKEN = "a" * 43
AUTH = {"Authorization": "Bearer " + TOKEN}


class Runner:
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.finish = asyncio.Event()
        self.cancel_started = asyncio.Event()
        self.cancel_finish = asyncio.Event()
        self.cancel_finish.set()
        self.cancelled = 0
        self.audio_delay = 0

    async def run(self, payload):
        self.calls.append(payload)
        try:
            if not payload:
                self.started.set()
                await self.finish.wait()
                return {"ok": True, "result": {"ready": True}}
            if self.audio_delay:
                await asyncio.sleep(self.audio_delay)
            return {"ok": True, "result": {"text": "Private audio result.",
                    "durationSeconds": 1, "model": "bark-3.0-plus", "chunks": []}}
        except asyncio.CancelledError:
            self.cancelled += 1
            self.cancel_started.set()
            await self.cancel_finish.wait()
            raise

    async def close(self):
        pass


class PreparationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.runner = Runner()
        self.tasks = []
        self.client = self.make_client()

    def make_client(self, **options):
        return httpx.AsyncClient(transport=httpx.ASGITransport(
            app=create_app(token=TOKEN, runner=self.runner, **options)), base_url="http://worker.test")

    async def asyncTearDown(self):
        self.runner.finish.set()
        self.runner.cancel_finish.set()
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.client.aclose()

    def start(self, path="/prepare", key=KEY, **headers):
        task = asyncio.create_task(self.client.post(path, headers=AUTH | {
            "X-Rehearsal-Request": key, "Content-Type": "audio/wav"} | headers,
            content=b"" if path == "/prepare" else wav()))
        self.tasks.append(task)
        return task

    async def joined(self):
        # Observe both request tasks actually waiting, rather than assuming a
        # fixed sleep is long enough for middleware on a loaded test machine.
        async def wait():
            while True:
                waiting = 0
                for task in asyncio.all_tasks():
                    coroutine = task.get_coro()
                    while coroutine is not None:
                        if getattr(coroutine, "__name__", "") == "join_preparation":
                            waiting += 1
                            break
                        coroutine = getattr(coroutine, "cr_await", None)
                if waiting >= 2:
                    return
                await asyncio.sleep(0)
        await asyncio.wait_for(wait(), 5)

    async def started(self):
        await asyncio.wait_for(self.runner.started.wait(), 5)

    async def cancel(self, key):
        return await self.client.post("/cancel", headers=AUTH, json={"requestId": key})

    async def test_simultaneous_prepares_share_only_empty_model_work(self):
        first = self.start()
        await self.started()
        second = self.start(key=OTHER_KEY)
        await self.joined()
        self.assertFalse(second.done())
        self.assertEqual(self.runner.calls, [b""])
        self.runner.finish.set()
        results = await asyncio.wait_for(asyncio.gather(first, second), 2)
        for result in results:
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json(), {"ready": True, "model": "bark-3.0-plus"})
        self.assertEqual(self.runner.calls, [b""])

    async def assert_audio_waits(self, path):
        prepare = self.start()
        await self.started()
        audio = self.start(path, OTHER_KEY)
        await self.joined()
        self.assertFalse(audio.done())
        self.assertEqual(self.runner.calls, [b""])
        self.runner.finish.set()
        first, second = await asyncio.wait_for(asyncio.gather(prepare, audio), 2)
        self.assertEqual(first.json(), {"ready": True, "model": "bark-3.0-plus"})
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["text"], "Private audio result.")
        self.assertEqual(self.runner.calls, [b"", wav()])

    async def test_immediate_upload_waits_for_signin_preparation(self):
        await self.assert_audio_waits("/transcribe")

    async def test_live_audio_waits_for_signin_preparation(self):
        await self.assert_audio_waits("/transcribe-live")

    async def test_cancelled_live_waiter_does_not_cancel_another_users_warmup(self):
        warmup = self.start(key=OTHER_KEY)
        await self.started()
        live = self.start()
        await self.joined()
        self.assertEqual((await self.cancel(KEY)).status_code, 200)
        self.assertEqual((await live).status_code, 409)
        self.assertFalse(warmup.done())
        self.assertEqual(self.runner.cancelled, 0)
        self.runner.finish.set()
        self.assertEqual((await warmup).status_code, 200)

    async def test_cancelled_warmup_keeps_waiting_audio_alive(self):
        warmup = self.start()
        await self.started()
        audio = self.start("/transcribe", OTHER_KEY)
        await self.joined()
        self.assertEqual((await self.cancel(KEY)).status_code, 200)
        self.assertEqual((await warmup).status_code, 409)
        self.assertEqual(self.runner.cancelled, 0)
        self.runner.finish.set()
        self.assertEqual((await audio).status_code, 200)
        self.assertEqual(self.runner.calls, [b"", wav()])

    async def test_last_waiter_cancellation_finishes_cleanup_and_new_user_never_joins_dying_task(self):
        self.runner.cancel_finish.clear()
        warmup = self.start()
        await self.started()
        cancellation = asyncio.create_task(self.cancel(KEY))
        self.tasks.append(cancellation)
        await self.runner.cancel_started.wait()
        self.assertFalse(cancellation.done())
        newcomer = await self.start(key=OTHER_KEY)
        self.assertEqual(newcomer.status_code, 429)
        self.assertEqual(self.runner.calls, [b""])
        self.runner.cancel_finish.set()
        self.assertEqual((await cancellation).status_code, 200)
        self.assertEqual((await warmup).status_code, 409)
        self.runner.finish.set()
        self.assertEqual((await self.start(key=OTHER_KEY)).status_code, 200)

    async def test_expired_or_invalid_deadline_rejected_before_model_load(self):
        await self.client.aclose()
        self.client = self.make_client(wall_clock=lambda: 1_800_000_000)
        for value, status in [("1799999999999", 408), ("1800000000000", 408),
                              ("1800000151000", 400), ("private", 400), ("1", 400)]:
            response = await self.start(**{"X-Rehearsal-Prepare-Expires": value})
            self.assertEqual(response.status_code, status)
        self.assertEqual(self.runner.calls, [])

    async def test_expiring_signin_waiter_does_not_interrupt_live_prepare(self):
        await self.client.aclose()
        self.client = self.make_client(wall_clock=lambda: 1_800_000_000)
        warmup = self.start(**{"X-Rehearsal-Prepare-Expires": "1800000003000"})
        await self.started()
        live = self.start(key=OTHER_KEY)
        await self.joined()
        self.assertEqual((await warmup).status_code, 504)
        self.assertEqual(self.runner.cancelled, 0)
        self.assertFalse(live.done())
        self.runner.finish.set()
        self.assertEqual((await live).status_code, 200)

    async def test_waiting_and_inference_share_one_overall_deadline(self):
        await self.client.aclose()
        self.client = self.make_client(request_timeout=3)
        self.runner.audio_delay = 2
        warmup = self.start()
        await self.started()
        audio = self.start("/transcribe", OTHER_KEY)
        await self.joined()
        await asyncio.sleep(2)
        self.runner.finish.set()
        self.assertEqual((await warmup).status_code, 200)
        self.assertEqual((await audio).status_code, 504)
        self.assertEqual(self.runner.cancelled, 1)

    async def test_bad_prepare_body_cannot_join_warmup(self):
        warmup = self.start()
        await self.started()
        response = await self.client.post("/prepare", headers=AUTH, content=b"x")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.runner.calls, [b""])
        self.runner.finish.set()
        self.assertEqual((await warmup).status_code, 200)


if __name__ == "__main__":
    unittest.main()
