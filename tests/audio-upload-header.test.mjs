import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAudioUploadHeader } from '../lib/audio-upload-header.mjs';

function file(prefix, size = 128) {
  const bytes = new Uint8Array(size);
  bytes.set(typeof prefix === 'string' ? new TextEncoder().encode(prefix) : prefix);
  return new Blob([bytes], { type: 'application/octet-stream' });
}

test('accepts supported audio signatures independent of filename or MIME', async () => {
  const cases = [
    ['RIFF\x78\0\0\0WAVE', 'wav'], ['ID3\x04\0\0\0\0\0\0', 'mp3'],
    [[255, 251, 144, 0], 'mp3'], [[255, 241, 80, 128, 1, 127, 252], 'aac'],
    ['\0\0\0\x18ftypM4A \0\0\0\0', 'm4a'], ['OggS\0', 'ogg'], ['fLaC', 'flac'],
    [[26, 69, 223, 163], 'webm'],
  ];
  for (const [prefix, format] of cases) assert.equal(await validateAudioUploadHeader(file(prefix)), format);
});

test('rejects executable, archive, document, and markup bytes even when named as audio', async () => {
  for (const prefix of ['MZ executable', 'PK\x03\x04archive', '%PDF-1.7', '<!DOCTYPE html>', '<script>alert(1)</script>', '#!/bin/sh', 'not audio', 'RIFF\0\0\0\0AVI ']) {
    const blob = file(prefix);
    Object.defineProperty(blob, 'name', { value: 'recording.mp3' });
    await assert.rejects(validateAudioUploadHeader(blob), /not a supported audio recording/);
  }
});

test('rejects truncated and invalid framing headers', async () => {
  for (const blob of [new Blob(), new Blob(['fLaC']), file([255, 255, 255, 255]), file('ID3\x01\0\0\0\0\0\0'), file('ID3\x04\0\0\x80\0\0\0'), file('\0\0\0\x08ftypM4A '), file('OggS\x01')]) {
    await assert.rejects(validateAudioUploadHeader(blob), /supported audio recording/);
  }
});

test('reads at most 64 bytes before native decoding and never reads the complete file', async () => {
  const blob = file('RIFF\x78\0\0\0WAVE', 1024 * 1024);
  const calls = [];
  const guarded = { size: blob.size, arrayBuffer() { throw new Error('whole file read'); }, slice(start, end) { calls.push([start, end]); return blob.slice(start, end); } };
  assert.equal(await validateAudioUploadHeader(guarded), 'wav');
  assert.deepEqual(calls, [[0, 64]]);
});
