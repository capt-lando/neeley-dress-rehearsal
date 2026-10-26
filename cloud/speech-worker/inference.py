"""Persistent isolated GPU process. stdin/stdout are a bounded binary protocol."""
import contextlib
import importlib.util
import json
import os
import struct
import sys

from audio import AudioError, MAX_BYTES, SAMPLE_RATE, decode_wav, windows
from models import MODEL_ROOT, verify_loader

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


class Bark:
    def __init__(self):
        import torch
        from transformers import AutoProcessor, GenerationConfig, ParakeetForTDT, ParakeetTDTConfig
        if not torch.cuda.is_available():
            raise RuntimeError("A CUDA GPU is required.")
        path = MODEL_ROOT / "bark" / "bark_loader.py"
        verify_loader(path)
        spec = importlib.util.spec_from_file_location("pinned_bark_loader", path)
        loader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(loader)
        state, config = loader.load_state_dict(MODEL_ROOT / "bark" / "model.bark")
        model = ParakeetForTDT(ParakeetTDTConfig.from_dict(config))
        missing, unexpected = model.load_state_dict(state, strict=False)
        if unexpected or any("num_batches_tracked" not in key for key in missing):
            raise RuntimeError("The model weights do not match their architecture.")
        model.generation_config = GenerationConfig.from_pretrained(
            MODEL_ROOT / "processor", local_files_only=True)
        self.processor = AutoProcessor.from_pretrained(
            MODEL_ROOT / "processor", local_files_only=True, trust_remote_code=False)
        self.model = model.eval().to(device="cuda", dtype=torch.float32)

    def transcribe(self, payload):
        import numpy as np
        import torch
        pcm, duration = decode_wav(payload)
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
        texts = []
        for start, end in windows(len(samples)):
            section = samples[start:end]
            if np.sqrt(np.mean(section ** 2)) < 0.0001:
                continue
            # Keep the publisher's evaluated 0.25-second leading silence.
            padded = np.concatenate([np.zeros(4000, np.float32), section])
            inputs = self.processor([padded], sampling_rate=SAMPLE_RATE,
                                    return_tensors="pt", padding=True)
            inputs = {key: value.to("cuda") for key, value in inputs.items()}
            with torch.inference_mode():
                output = self.model.generate(**inputs)
            ids = output.sequences if hasattr(output, "sequences") else output
            text = self.processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
            if text:
                texts.append(text)
        text = " ".join(texts)
        if not text:
            raise AudioError("No speech was detected. Try another recording.")
        if len(text) > 60_000:
            raise AudioError("The transcript exceeds the rehearsal limit.")
        return {"text": text, "durationSeconds": duration, "chunks": [], "model": "bark-3.0-plus"}


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            raise EOFError
        data.extend(chunk)
    return bytes(data)


def main():
    source, target = sys.stdin.buffer, sys.stdout.buffer
    model = None
    while True:
        try:
            size = struct.unpack("!I", read_exact(source, 4))[0]
            if not 44 <= size <= MAX_BYTES:
                return
            payload = read_exact(source, size)
        except EOFError:
            return
        try:
            # Vendor libraries cannot put messages or transcription into protocol output.
            with contextlib.redirect_stdout(sys.stderr):
                model = model or Bark()
                result = {"ok": True, "result": model.transcribe(payload)}
        except AudioError as error:
            result = {"ok": False, "status": 422, "error": str(error)}
        except Exception:
            result = {"ok": False, "status": 503, "error": "Speech recognition is temporarily unavailable."}
        finally:
            del payload
        encoded = json.dumps(result).encode("utf-8")
        target.write(struct.pack("!I", len(encoded)) + encoded)
        target.flush()


if __name__ == "__main__":
    main()
