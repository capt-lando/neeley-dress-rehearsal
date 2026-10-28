import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRecording } from '../lib/wav.mjs';

function wav(samples) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 44; i < bytes.length; i += 2) bytes.writeInt16LE(8192, i);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('canonical WAV decoding accepts exactly fifteen minutes and rejects one extra sample', () => {
  const result = decodeRecording(wav(900 * 16000));
  assert.equal(result.durationSeconds, 900);
  assert.equal(result.samples.length, 14_400_000);
  assert.equal(result.samples[0], 0.25); assert.equal(result.samples.at(-1), 0.25);
  assert.throws(() => decodeRecording(wav(900 * 16000 + 1)), /15 minutes/);
  assert.throws(() => decodeRecording(new ArrayBuffer(30 * 1024 * 1024 + 1)), /30 MB/);
});
