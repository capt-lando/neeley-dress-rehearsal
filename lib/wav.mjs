import { MAX_RECORDING_SECONDS, MAX_RECORDING_BYTES } from './recording-limits.mjs';

// Decode only the mono 16 kHz PCM WAV produced by the recorder. No browser or Node dependencies.
export function decodeRecording(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 44 || buffer.byteLength > MAX_RECORDING_BYTES) {
    throw new Error('Use a recording of up to 15 minutes and 30 MB.');
  }
  const view = new DataView(buffer);
  const label = at => String.fromCharCode(...new Uint8Array(buffer, at, 4));
  if (label(0) !== 'RIFF' || label(8) !== 'WAVE') throw new Error('The recording is not a readable WAV file.');
  let format, data;
  for (let at = 12; at + 8 <= buffer.byteLength;) {
    const size = view.getUint32(at + 4, true);
    if (at + 8 + size > buffer.byteLength) throw new Error('The recording is incomplete.');
    if (label(at) === 'fmt ' && size >= 16) {
      format = { encoding: view.getUint16(at + 8, true), channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    }
    if (label(at) === 'data') data = { offset: at + 8, size };
    at += 8 + size + (size % 2);
  }
  if (!format || !data || format.encoding !== 1 || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16 || data.size % 2) {
    throw new Error('Record or upload audio through the app so it can prepare a compatible recording.');
  }
  const length = data.size / 2;
  const durationSeconds = length / format.rate;
  if (durationSeconds < 0.5 || durationSeconds > MAX_RECORDING_SECONDS) throw new Error('Use a recording between half a second and 15 minutes.');
  const samples = new Float32Array(length);
  let energy = 0;
  for (let i = 0; i < length; i++) { samples[i] = view.getInt16(data.offset + i * 2, true) / 32768; energy += samples[i] ** 2; }
  if (Math.sqrt(energy / length) < 0.0001) throw new Error('This recording is silent. Check your microphone and try again.');
  return { samples, durationSeconds };
}
