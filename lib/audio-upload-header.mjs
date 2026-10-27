const UNSUPPORTED = 'This is not a supported audio recording. Choose a WAV, MP3, M4A, AAC, OGG, FLAC, or WebM file.';

/** A bounded format preflight, followed by the browser decoder and server WAV validation. */
export async function validateAudioUploadHeader(file) {
  if (!file || !Number.isFinite(file.size) || file.size < 10 || typeof file.slice !== 'function') throw new Error(UNSUPPORTED);
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (bytes.length < 10 || bytes.length > 64) throw new Error(UNSUPPORTED);
  const at = (offset, value) => [...value].every((letter, index) => bytes[offset + index] === letter.charCodeAt(0));
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav';
  if (at(0, 'ID3') && bytes[3] >= 2 && bytes[3] <= 4 && bytes[4] !== 255 && [...bytes.slice(6, 10)].every(value => value < 128)) return 'mp3';
  if (bytes[0] === 255 && (bytes[1] & 224) === 224) {
    const version = (bytes[1] >> 3) & 3, layer = (bytes[1] >> 1) & 3;
    const bitrate = bytes[2] >> 4, sampleRate = (bytes[2] >> 2) & 3;
    if (version !== 1 && layer !== 0 && bitrate > 0 && bitrate < 15 && sampleRate !== 3 && (bytes[3] & 3) !== 2) return 'mp3';
    if ((bytes[1] & 246) === 240 && ((bytes[2] >> 2) & 15) < 13) return 'aac';
  }
  if (at(4, 'ftyp') && bytes.length >= 16) {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (boxSize >= 16 && boxSize <= file.size) return 'm4a';
  }
  if (at(0, 'OggS') && bytes[4] === 0) return 'ogg';
  if (at(0, 'fLaC')) return 'flac';
  if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return 'webm';
  throw new Error(UNSUPPORTED);
}
