"""The browser sends one canonical mono 16 kHz PCM16 WAV, never a URL."""
import struct

MAX_BYTES = 20 * 1024 * 1024
SAMPLE_RATE = 16_000
WINDOW_SAMPLES = 30 * SAMPLE_RATE


class AudioError(ValueError):
    pass


def decode_wav(payload: bytes):
    if not 44 <= len(payload) <= MAX_BYTES:
        raise AudioError("Use a WAV recording no larger than 20 MiB.")
    expected = (b"RIFF", len(payload) - 8, b"WAVE", b"fmt ", 16,
                1, 1, SAMPLE_RATE, SAMPLE_RATE * 2, 2, 16, b"data", len(payload) - 44)
    if struct.unpack("<4sI4s4sIHHIIHH4sI", payload[:44]) != expected:
        raise AudioError("Upload a mono 16 kHz PCM16 WAV prepared by the app.")
    size = len(payload) - 44
    if size % 2 or not SAMPLE_RATE <= size <= 600 * SAMPLE_RATE * 2:
        raise AudioError("Recordings must be between half a second and 10 minutes.")
    return memoryview(payload)[44:], size / (SAMPLE_RATE * 2)


def windows(sample_count: int):
    """Disjoint windows: never drop or deduplicate a spoken word here."""
    for start in range(0, sample_count, WINDOW_SAMPLES):
        yield start, min(start + WINDOW_SAMPLES, sample_count)
