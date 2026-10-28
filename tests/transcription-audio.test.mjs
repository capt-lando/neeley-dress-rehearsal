import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { splitTranscriptionAudio, MAX_TRANSCRIPTION_FILE_BYTES } from '../supabase/functions/rehearsal-api/transcription-audio.mjs';

const RATE = 16000, HEADER = 44;
function wav(samples) {
  const buffer = new ArrayBuffer(HEADER + samples * 2), bytes = Buffer.from(buffer);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24); bytes.writeUInt32LE(RATE * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  // A byte pattern with nonzero samples detects lost, duplicated, reordered,
  // or rewritten PCM without relying on the helper's split-selection logic.
  for (let at = HEADER; at < bytes.length; at++) bytes[at] = (at * 37 + (at >>> 8)) & 255;
  return buffer;
}
function assertParts(original, parts) {
  assert.ok(parts.length >= 1 && parts.length <= 2);
  for (const part of parts) {
    assert.ok(part instanceof ArrayBuffer);
    assert.ok(part.byteLength <= 25_000_000);
    const bytes = Buffer.from(part);
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
    assert.deepEqual(bytes.subarray(8, 40), Buffer.from(original, 8, 32));
    assert.equal(bytes.readUInt32LE(40), bytes.length - HEADER);
    assert.equal((bytes.length - HEADER) % 2, 0);
  }
  assert.deepEqual(Buffer.concat(parts.map(part => Buffer.from(part, HEADER))), Buffer.from(original, HEADER));
}

test('half-second, ten-minute and exact 25 MB files remain unchanged without copying', () => {
  assert.equal(MAX_TRANSCRIPTION_FILE_BYTES, 25_000_000);
  for (const samples of [RATE / 2, 600 * RATE, (25_000_000 - HEADER) / 2]) {
    const original = wav(samples), parts = splitTranscriptionAudio(original);
    assert.equal(parts.length, 1); assert.equal(parts[0], original); assertParts(original, parts);
  }
});

test('the first aligned sample over the provider limit splits into two valid files', () => {
  const original = wav((25_000_000 - HEADER) / 2 + 1), parts = splitTranscriptionAudio(original);
  assert.equal(original.byteLength, 25_000_002); assert.equal(parts.length, 2);
  assertParts(original, parts);
});

test('fifteen minutes preserves the entire final tail and every PCM byte in order', () => {
  const original = wav(900 * RATE), before = Buffer.from(original).subarray(-32).toString('hex');
  const parts = splitTranscriptionAudio(original);
  assert.equal(original.byteLength, 28_800_044); assert.equal(parts.length, 2);
  assertParts(original, parts);
  assert.equal(Buffer.from(parts[1]).subarray(-32).toString('hex'), before);
  assert.equal(parts.reduce((count, part) => count + (part.byteLength - HEADER) / 2, 0), 900 * RATE);
});

test('a nearby quiet pause is preferred and the input stays untouched', () => {
  const original = wav(900 * RATE), pcm = new DataView(original);
  // Keep all search windows loud except a 100 ms pause centered at 602 s.
  for (let sample = 594 * RATE; sample < 606 * RATE; sample++) pcm.setInt16(HEADER + sample * 2, 10000, true);
  for (let sample = 602 * RATE - 800; sample < 602 * RATE + 800; sample++) pcm.setInt16(HEADER + sample * 2, 0, true);
  const digest = () => createHash('sha256').update(Buffer.from(original)).digest('hex');
  const before = digest();
  const parts = splitTranscriptionAudio(original);
  assert.equal((parts[0].byteLength - HEADER) / 2, 602 * RATE);
  assertParts(original, parts); assert.equal(digest(), before);
});

test('continuous loud audio falls back to ten minutes without exceeding two files', () => {
  const original = wav(900 * RATE), pcm = new DataView(original);
  for (let sample = 594 * RATE; sample < 606 * RATE; sample++) pcm.setInt16(HEADER + sample * 2, -32768, true);
  const parts = splitTranscriptionAudio(original);
  assert.equal((parts[0].byteLength - HEADER) / 2, 600 * RATE);
  assert.equal((parts[1].byteLength - HEADER) / 2, 300 * RATE);
  assertParts(original, parts);
});

test('unsupported input is rejected instead of producing misleading WAV headers', () => {
  assert.throws(() => splitTranscriptionAudio(new Uint8Array(44)), RangeError);
  assert.throws(() => splitTranscriptionAudio(new ArrayBuffer(43)), RangeError);
  assert.throws(() => splitTranscriptionAudio(wav(900 * RATE + 1)), RangeError);
  const odd = new ArrayBuffer(16045); assert.throws(() => splitTranscriptionAudio(odd), RangeError);
  for (const [offset, value, width] of [[20, 3, 2], [22, 2, 2], [24, 48000, 4], [28, 64000, 4], [32, 4, 2], [34, 8, 2], [4, 12, 4], [40, 100, 4]]) {
    const input = wav(RATE), view = new DataView(input);
    width === 4 ? view.setUint32(offset, value, true) : view.setUint16(offset, value, true);
    assert.throws(() => splitTranscriptionAudio(input), TypeError);
  }
});
