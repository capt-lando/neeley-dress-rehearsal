const HEADER_BYTES = 44, SAMPLE_BYTES = 2, SAMPLE_RATE = 16000;
const MAX_SAMPLES = 900 * SAMPLE_RATE;
const TARGET_SAMPLE = 600 * SAMPLE_RATE;
const QUIET_WINDOW_SAMPLES = SAMPLE_RATE / 10;
const SEARCH_SAMPLES = 5 * SAMPLE_RATE;
const QUIET_ENERGY = QUIET_WINDOW_SAMPLES * 256 ** 2;
export const MAX_TRANSCRIPTION_FILE_BYTES = 25_000_000;

function canonicalSamples(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_BYTES + SAMPLE_RATE ||
      buffer.byteLength > HEADER_BYTES + MAX_SAMPLES * SAMPLE_BYTES || (buffer.byteLength - HEADER_BYTES) % SAMPLE_BYTES) {
    throw new RangeError('Use canonical WAV audio between half a second and fifteen minutes.');
  }
  const view = new DataView(buffer);
  const label = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (label(0) !== 'RIFF' || view.getUint32(4, true) !== buffer.byteLength - 8 ||
      label(8) !== 'WAVE' || label(12) !== 'fmt ' || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== SAMPLE_RATE || view.getUint32(28, true) !== SAMPLE_RATE * SAMPLE_BYTES ||
      view.getUint16(32, true) !== SAMPLE_BYTES || view.getUint16(34, true) !== 16 ||
      label(36) !== 'data' || view.getUint32(40, true) !== buffer.byteLength - HEADER_BYTES) {
    throw new TypeError('Transcription splitting requires canonical mono 16 kHz PCM16 WAV audio.');
  }
  return (buffer.byteLength - HEADER_BYTES) / SAMPLE_BYTES;
}

function splitSample(buffer) {
  const view = new DataView(buffer);
  const quiet = center => {
    let energy = 0;
    const start = center - QUIET_WINDOW_SAMPLES / 2;
    for (let sample = start; sample < start + QUIET_WINDOW_SAMPLES; sample++) {
      energy += view.getInt16(HEADER_BYTES + sample * SAMPLE_BYTES, true) ** 2;
      if (energy > QUIET_ENERGY) return false;
    }
    return true;
  };
  // Prefer the nearest quiet 100 ms around ten minutes. Work is bounded to
  // 101 windows within +/- five seconds; continuous speech uses ten minutes.
  if (quiet(TARGET_SAMPLE)) return TARGET_SAMPLE;
  for (let distance = QUIET_WINDOW_SAMPLES; distance <= SEARCH_SAMPLES; distance += QUIET_WINDOW_SAMPLES) {
    if (quiet(TARGET_SAMPLE - distance)) return TARGET_SAMPLE - distance;
    if (quiet(TARGET_SAMPLE + distance)) return TARGET_SAMPLE + distance;
  }
  return TARGET_SAMPLE;
}

/**
 * Split already validated canonical recording audio for a 25 MB file API.
 * At most two files, with no PCM overlap/drop. This does no provider work.
 * Files within the limit retain their original ArrayBuffer without a copy.
 */
export function splitTranscriptionAudio(buffer) {
  const samples = canonicalSamples(buffer);
  if (buffer.byteLength <= MAX_TRANSCRIPTION_FILE_BYTES) return [buffer];
  const boundary = splitSample(buffer);
  const part = (start, end) => {
    const dataBytes = (end - start) * SAMPLE_BYTES;
    const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
    bytes.set(new Uint8Array(buffer, 0, HEADER_BYTES));
    bytes.set(new Uint8Array(buffer, HEADER_BYTES + start * SAMPLE_BYTES, dataBytes), HEADER_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, bytes.byteLength - 8, true);
    view.setUint32(40, dataBytes, true);
    return bytes.buffer;
  };
  return [part(0, boundary), part(boundary, samples)];
}
