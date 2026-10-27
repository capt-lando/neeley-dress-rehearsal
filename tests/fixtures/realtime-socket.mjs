/** Deterministic browser WebSocket double for the authenticated PCM protocol. */
export function createRealtimeSocketFixture({ text = 'Um, practice helps.', maxSamples = 24_000 * 110,
  onStart, onAudio, onFinish, autoReady = true, autoAck = true, autoComplete = true } = {}) {
  const sockets = [];
  let transcript = '', consumedSamples = 0;
  const append = (prefix, suffix) => [prefix, suffix].filter(Boolean).join(' ');
  class WebSocketImpl {
    constructor(url) {
      this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.listeners = new Map();
      this.messages = []; this.frames = []; this.samples = 0; this.pending = Promise.resolve();
      sockets.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.emit('open', {}); } });
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    emit(type, event) { for (const listener of [...(this.listeners.get(type) || [])]) listener(event); }
    serverMessage(message) { if (this.readyState === 1) this.emit('message', { data: JSON.stringify(message) }); }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3; this.closeCode = code; this.closeReason = reason;
      queueMicrotask(() => this.emit('close', { code, reason }));
    }
    send(data) {
      if (this.readyState !== 1) throw new Error('WebSocket is closed.');
      if (typeof data === 'string') {
        const message = JSON.parse(data); this.messages.push(message);
        if (message.type === 'start') {
          this.start = message;
          this.pending = this.pending.then(async () => {
            await onStart?.(message, this);
            if (autoReady) this.serverMessage({ type: 'ready', segmentIndex: message.segmentIndex,
              sampleRate: 24_000, maxSamples, transcript });
          }).catch(error => this.serverMessage({ type: 'error', message: error.message }));
        } else if (message.type === 'finish') {
          this.pending = this.pending.then(async () => {
            const segmentText = await (onFinish ? onFinish(this) : typeof text === 'function' ? text(this.start.segmentIndex) : text);
            if (!autoComplete || this.readyState !== 1) return;
            consumedSamples += this.samples;
            transcript = append(transcript, segmentText || '');
            this.serverMessage({ type: 'segment_complete', text: segmentText || '', transcript,
              nextSequence: this.start.segmentIndex + 1, samples: this.samples, consumedSamples });
          }).catch(error => this.serverMessage({ type: 'error', message: error.message }));
        }
      } else {
        const frame = data instanceof ArrayBuffer ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        this.frames.push(frame); this.samples += frame.byteLength / 2;
        const samples = this.samples;
        queueMicrotask(() => { if (autoAck) this.serverMessage({ type: 'audio_ack', samples }); });
        this.pending = this.pending.then(async () => {
          const partial = await onAudio?.(frame, this);
          if (typeof partial === 'string') this.serverMessage({ type: 'transcript', text: append(transcript, partial), final: false });
        }).catch(error => this.serverMessage({ type: 'error', message: error.message }));
      }
    }
  }
  return { WebSocketImpl, sockets, get transcript() { return transcript; }, get consumedSamples() { return consumedSamples; } };
}
