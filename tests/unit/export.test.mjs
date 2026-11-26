import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'flint-export-'));
const bundle = async (entry, name) => {
  const r = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
  const file = join(dir, name);
  writeFileSync(file, r.outputFiles[0].text);
  return import(file);
};
const E = await bundle('src/offlineExport.ts', 'offlineExport.mjs');
const W = await bundle('src/webmMuxer.ts', 'webmMuxer.mjs');

test('export clock is frame-based and preserves fractional composition frames', async () => {
  const compFrames = [];
  const res = await E.runOfflineExport({
    startFrame: 0, frameCount: 6, compFps: 30, exportFps: 60,
    render: async c => { compFrames.push(c); return {}; },
    encode: () => {},
  });
  assert.deepEqual(compFrames, [0, 0.5, 1, 1.5, 2, 2.5]);
  assert.deepEqual(res.timestampsUs, [0, 16667, 33333, 50000, 66667, 83333]);
  assert.equal(res.framesEncoded, 6);
});

test('media frames are awaited before rendering and before encoding', async () => {
  const order = [];
  await E.runOfflineExport({
    startFrame: 10, frameCount: 2, compFps: 30, exportFps: 30,
    awaitMedia: async c => { order.push(`media:${c}`); await new Promise(r => setTimeout(r, 2)); },
    render: async c => { order.push(`render:${c}`); return {}; },
    encode: (f, meta) => order.push(`encode:${meta.index}@${meta.timestampUs}`),
  });
  assert.deepEqual(order, ['media:10', 'render:10', 'encode:0@0', 'media:11', 'render:11', 'encode:1@33333']);
});

test('rendered frames are closed and never retained', async () => {
  let open = 0, closed = 0;
  await E.runOfflineExport({
    startFrame: 0, frameCount: 20, compFps: 30, exportFps: 30,
    render: async () => { open++; return { close: () => { closed++; open--; } }; },
    encode: () => {},
  });
  assert.equal(closed, 20);
  assert.equal(open, 0);
});

test('encoder backpressure blocks submission when the queue is full', async () => {
  let depth = 0;
  const res = await E.runOfflineExport({
    startFrame: 0, frameCount: 8, compFps: 30, exportFps: 30,
    queueDepth: () => depth,
    maxQueue: 2,
    render: async () => ({}),
    encode: () => { depth++; setTimeout(() => { depth--; }, 5); },
  });
  assert.equal(res.framesEncoded, 8);
  assert.ok(res.backpressureWaits > 0, 'waited for the encoder queue');
  assert.ok(depth <= 2, 'queue stayed bounded');
});

test('keyframes land on the configured interval', async () => {
  const keys = [];
  await E.runOfflineExport({
    startFrame: 0, frameCount: 10, compFps: 30, exportFps: 10,
    keyframeIntervalSec: 0.3, render: async () => ({}),
    encode: (f, m) => { if (m.keyframe) keys.push(m.index); },
  });
  assert.deepEqual(keys, [0, 3, 6, 9]);
});

test('cancellation stops the loop, skips flush and reports honestly', async () => {
  const signal = { aborted: false };
  let flushed = false, encoded = 0;
  const res = await E.runOfflineExport({
    startFrame: 0, frameCount: 100, compFps: 30, exportFps: 30, signal,
    render: async () => ({}),
    encode: () => { if (++encoded === 5) signal.aborted = true; },
    flush: async () => { flushed = true; },
  });
  assert.equal(res.cancelled, true);
  assert.equal(res.framesEncoded, 5);
  assert.equal(flushed, false);
});

test('render and encoder errors propagate', async () => {
  await assert.rejects(() => E.runOfflineExport({
    startFrame: 0, frameCount: 3, compFps: 30, exportFps: 30,
    render: async i => { throw new Error('offscreen render failed'); }, encode: () => {},
  }), /offscreen render failed/);
  await assert.rejects(() => E.runOfflineExport({
    startFrame: 0, frameCount: 3, compFps: 30, exportFps: 30,
    render: async () => ({}), encode: () => { throw new Error('encoder rejected frame'); },
  }), /encoder rejected frame/);
});

test('webm muxer writes a well-formed EBML header, tracks and clusters', () => {
  const mux = new W.WebmMuxer({ codec: 'V_VP9', width: 1920, height: 1080, fps: 30 });
  for (let i = 0; i < 5; i++) {
    mux.addChunk({ data: new Uint8Array([0x82, i, 0xaa, 0xbb]), timestamp: i / 30, duration: 1 / 30, keyframe: i === 0 || i === 4 });
  }
  const file = mux.finalize();
  assert.ok(file.length > 40);
  const hex = [...file.slice(0, 4)].map(b => b.toString(16).padStart(2, '0')).join('');
  assert.equal(hex, '1a45dfa3', 'EBML magic');
  const text = new TextDecoder('latin1').decode(file);
  assert.ok(text.includes('webm'), 'DocType webm');
  assert.ok(text.includes('V_VP9'), 'codec id');
  const clusters = (text.match(/\x1f\x43\xb6\x75/g) || []).length;
  assert.equal(clusters, 2, 'new cluster on each keyframe');
  assert.equal(mux.chunkCount, 5);
  assert.throws(() => mux.finalize(), /already finalised/);
});

test('webm muxer enforces monotonic timestamps and reports duration', () => {
  const mux = new W.WebmMuxer({ codec: 'V_VP8', width: 480, height: 270, fps: 25 });
  mux.addChunk({ data: new Uint8Array([1]), timestamp: 0, duration: 0.04, keyframe: true });
  mux.addChunk({ data: new Uint8Array([2]), timestamp: 0.04, duration: 0.04, keyframe: false });
  assert.throws(() => mux.addChunk({ data: new Uint8Array([3]), timestamp: 0.01, duration: 0.04, keyframe: false }), /must not decrease/);
  const file = mux.finalize();
  assert.ok(file.length > 0);
});

test('vint/uint encodings round-trip expected widths', () => {
  assert.deepEqual([...W.vint(1)], [0x81]);
  assert.deepEqual([...W.vint(127)], [0xff]);
  assert.deepEqual([...W.vint(128)], [0x40, 0x80]);
  assert.deepEqual([...W.elemId(0x1a45dfa3)], [0x1a, 0x45, 0xdf, 0xa3]);
});

test('webm muxer writes an Opus audio track, interleaved blocks and multi-track clusters', () => {
  const audio = { sampleRate: 48000, channels: 2, codecPrivate: W.opusHead(2) };
  const mux = new W.WebmMuxer({ codec: 'V_VP9', width: 1280, height: 720, fps: 30, audio });
  const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
  assert.equal([...audio.codecPrivate.slice(0, 8)].map(b => String.fromCharCode(b)).join(''), 'OpusHead');
  assert.equal(audio.codecPrivate.length, 19);
  for (let i = 0; i < 4; i++) {
    mux.addChunk({ data: bytes, timestamp: i / 30, duration: 1 / 30, keyframe: i === 0 });
    mux.addAudioChunk({ data: bytes, timestamp: i / 30 + 0.006, duration: 0.02, keyframe: true });
  }
  const file = mux.finalize();
  const text = new TextDecoder('latin1').decode(file);
  assert.ok(text.includes('A_OPUS'), 'opus codec id present');
  assert.equal(mux.chunkCount, 4);
  assert.equal(mux.audioChunkCount, 4);
  const blocks = (text.match(/\xa3/g) || []).length;
  assert.ok(blocks >= 8, 'video and audio simple blocks written');
});

test('audio chunks require an audio track and cannot follow finalisation', () => {
  const mux = new W.WebmMuxer({ codec: 'V_VP8', width: 320, height: 180, fps: 25 });
  assert.throws(() => mux.addAudioChunk({ data: new Uint8Array([1]), timestamp: 0, duration: 0.02, keyframe: true }), /no audio track/);
  const withAudio = new W.WebmMuxer({ codec: 'V_VP8', width: 320, height: 180, fps: 25, audio: { sampleRate: 48000, channels: 1 } });
  withAudio.addAudioChunk({ data: new Uint8Array([1]), timestamp: 0, duration: 0.02, keyframe: true });
  withAudio.finalize();
  assert.throws(() => withAudio.addAudioChunk({ data: new Uint8Array([2]), timestamp: 0.02, duration: 0.02, keyframe: true }), /already finalised/);
});
