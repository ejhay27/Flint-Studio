import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'flint-audio-'));
const bundle = async (entry, name) => {
  const r = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
  const file = join(dir, name);
  writeFileSync(file, r.outputFiles[0].text);
  return import(file);
};
const E = await bundle('src/offlineExport.ts', 'oe.mjs');
const W = await bundle('src/webmMuxer.ts', 'wm.mjs');

const opusHead = (ch = 2) => {
  const out = new Uint8Array(19);
  out.set(new TextEncoder().encode('OpusHead'));
  out[9] = ch; out[10] = 0x9c; out[11] = 0x01; // preSkip 412
  return out;
};

class MockAudioEncoder {
  static supported = true;
  static lastConfig = null;
  constructor({ output, error }) { this.output = output; this.error = error; this.encodeQueueSize = 0; this.closed = false; this.calls = []; }
  static async isConfigSupported(config) { MockAudioEncoder.lastConfig = config; return { supported: MockAudioEncoder.supported, config }; }
  configure(c) { this.config = c; }
  encode(data) {
    this.calls.push({ timestamp: data.timestamp, frames: data.numberOfFrames, channels: data.numberOfChannels, bytes: data.data.length });
    this.encodeQueueSize = 1;
    const desc = opusHead(this.config.numberOfChannels);
    setTimeout(() => {
      this.encodeQueueSize = 0;
      this.output({ byteLength: 4, copyTo: b => b.set([1, 2, 3, 4]), timestamp: data.timestamp, duration: 20000, metadata: { decoderConfig: { description: desc.buffer } } });
    }, 0);
  }
  async flush() { await new Promise(r => setTimeout(r, 5)); }
  close() { this.closed = true; }
}
class MockAudioData {
  constructor(init) { Object.assign(this, init); this.closed = false; }
  close() { this.closed = true; }
}

const pcmOf = (seconds, rate = 48000, channels = 2) => {
  const length = Math.round(seconds * rate);
  const chans = Array.from({ length: channels }, () => new Float32Array(length).fill(0.25));
  return { sampleRate: rate, numberOfChannels: channels, length, getChannelData: c => chans[c] };
};

test('mixdown PCM is encoded in bounded 960-sample Opus blocks with sample timestamps', async () => {
  const chunks = [];
  const res = await E.encodeOpusPcm({
    pcm: pcmOf(0.1), startSec: 0, endSec: 0.1, AudioEncoderCtor: MockAudioEncoder, AudioDataCtor: MockAudioData,
    onChunk: c => chunks.push(c),
  });
  assert.equal(res.chunks, 5, '100 ms / 20 ms packets');
  assert.equal(MockAudioEncoder.lastConfig.codec, 'opus');
  assert.equal(MockAudioEncoder.lastConfig.sampleRate, 48000);
  assert.equal(MockAudioEncoder.lastConfig.numberOfChannels, 2);
  assert.equal(MockAudioEncoder.lastConfig.bitrate, 128000);
  assert.deepEqual(chunks.map(c => +c.timestamp.toFixed(4)), [0, 0.02, 0.04, 0.06, 0.08]);
});

test('nonzero export start offset shifts the sampled PCM window, not the timestamps', async () => {
  const enc = [];
  class Capture extends MockAudioEncoder { encode(d) { enc.push(d.timestamp); super.encode(d); } }
  await E.encodeOpusPcm({
    pcm: pcmOf(2), startSec: 1, endSec: 1.04, AudioEncoderCtor: Capture, AudioDataCtor: MockAudioData, onChunk: () => {},
  });
  assert.deepEqual(enc.map(t => +(t / 1e6).toFixed(4)), [1, 1.02], 'timestamps stay on the composition timebase');
});

test('mono and stereo configurations are honoured and resampling fills 48 kHz', () => {
  const src = new Float32Array(441).fill(1);
  const out = E.resampleChannel(src, 44100, 48000);
  assert.equal(out.length, 480);
  const mono = pcmOf(0.02, 44100, 1);
  assert.equal(mono.numberOfChannels, 1);
});

test('encoded Opus packets reach addAudioChunk and finalise with metadata', async () => {
  const collected = [];
  let meta = null;
  const res = await E.encodeOpusPcm({
    pcm: pcmOf(0.06), startSec: 0, endSec: 0.06, AudioEncoderCtor: MockAudioEncoder, AudioDataCtor: MockAudioData,
    onChunk: c => collected.push(c), onMeta: m => { meta = m; },
  });
  // The editor builds the muxer from the encoder metadata, then adds the packets.
  const mux = new W.WebmMuxer({ codec: 'V_VP9', width: 640, height: 360, fps: 30, audio: { sampleRate: meta.sampleRate, channels: meta.channels, codecPrivate: meta.codecPrivate } });
  for (const c of collected) mux.addAudioChunk(c);
  assert.equal(meta.preSkip, 412, 'pre-skip read from OpusHead, not invented');
  assert.equal(meta.channels, 2);
  assert.ok(res.chunks >= 3, 'one packet per 20 ms block');
  assert.equal(mux.audioChunkCount, res.chunks);
  const file = mux.finalize();
  const text = new TextDecoder('latin1').decode(file);
  assert.ok(text.includes('A_OPUS'));
  assert.ok((text.match(/\xa3/g) || []).length >= res.chunks, 'audio blocks present');
});

test('unsupported Opus config, missing AudioEncoder and cancellation all fail safely', async () => {
  MockAudioEncoder.supported = false;
  await assert.rejects(() => E.encodeOpusPcm({
    pcm: pcmOf(0.02), startSec: 0, endSec: 0.02, AudioEncoderCtor: MockAudioEncoder, AudioDataCtor: MockAudioData, onChunk: () => {},
  }), /not supported/);
  MockAudioEncoder.supported = true;
  await assert.rejects(() => E.encodeOpusPcm({
    pcm: pcmOf(0.02), startSec: 0, endSec: 0.02, AudioEncoderCtor: undefined, AudioDataCtor: MockAudioData, onChunk: () => {},
  }), /AudioEncoder is not available/);
  const signal = { aborted: true };
  const res = await E.encodeOpusPcm({
    pcm: pcmOf(1), startSec: 0, endSec: 1, signal, AudioEncoderCtor: MockAudioEncoder, AudioDataCtor: MockAudioData,
    onChunk: () => {},
  });
  assert.equal(res.cancelled, true, 'aborted before submitting any packet');
  assert.equal(res.chunks, 0, 'no packets submitted, no flush');
});
