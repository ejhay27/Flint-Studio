import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Minimal DOM stand-in: canvases record which source pixels were copied.
const drawn = [];
globalThis.document = {
  createElement: () => {
    const canvas = { width: 0, height: 0, pixels: null, id: drawn.length };
    canvas.getContext = () => ({ drawImage: src => { canvas.pixels = `frame@${src.currentTime}`; drawn.push(canvas); } });
    return canvas;
  },
};
const dir = mkdtempSync(join(tmpdir(), 'flint-snap-'));
const r = await build({ entryPoints: ['src/mediaFrameProvider.ts'], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
const file = join(dir, 'mfp.mjs');
writeFileSync(file, r.outputFiles[0].text);
const M = await import(file);

const video = (startTime = 0) => {
  const v = {
    currentTime: startTime, readyState: 4, videoWidth: 640, videoHeight: 360, listeners: {},
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn); },
  };
  let target = startTime;
  Object.defineProperty(v, 'currentTime', {
    get: () => target,
    set: x => { setTimeout(() => { target = x; v.listeners.seeked?.forEach(fn => fn()); }, 1); },
  });
  return v;
};

test('two layers sharing one source keep independent snapshots', async () => {
  const shared = video();
  const clips = [
    { id: 'layerA', provider: shared, clip: { start: 0, duration: 90, compFps: 30, inPoint: 1 } },
    { id: 'layerB', provider: shared, clip: { start: 0, duration: 90, compFps: 30, inPoint: 5 } },
  ];
  const out = await M.snapshotMediaForFrame(0, clips);
  assert.equal(out.snapshots.length, 2);
  assert.deepEqual(out.rejected, []);
  const [a, b] = out.snapshots;
  assert.notEqual(a.snapshot.canvas, b.snapshot.canvas, 'separate canvases, not one shared element');
  assert.equal(a.snapshot.canvas.pixels, 'frame@1');
  assert.equal(b.snapshot.canvas.pixels, 'frame@5');
  assert.equal(+a.time.toFixed(3), 1);
  assert.equal(+b.time.toFixed(3), 5);
});

test('snapshots survive subsequent seeks of the shared element', async () => {
  const shared = video();
  const out = await M.snapshotMediaForFrame(30, [
    { id: 'A', provider: shared, clip: { start: 0, duration: 90, compFps: 30, inPoint: 0 } },
    { id: 'B', provider: shared, clip: { start: 0, duration: 90, compFps: 30, inPoint: 2 } },
  ]);
  const a = out.snapshots.find(s => s.id === 'A').snapshot;
  const b = out.snapshots.find(s => s.id === 'B').snapshot;
  assert.equal(a.canvas.pixels, 'frame@1'); // comp frame 30 = 1s, in-point 0
  assert.equal(b.canvas.pixels, 'frame@3'); // 1s + in-point 2
  assert.notEqual(a.canvas.pixels, b.canvas.pixels, 'A was not overwritten by B');
});

test('stale or unavailable frames are rejected, non-live clips skipped', async () => {
  const shared = video();
  let target = 0;
  Object.defineProperty(shared, 'currentTime', {
    get: () => target,
    set: () => { setTimeout(() => { target = 99; shared.listeners.seeked?.forEach(fn => fn()); }, 1); },
  });
  const out = await M.snapshotMediaForFrame(0, [
    { id: 'far', provider: shared, clip: { start: 0, duration: 30, compFps: 30 } },
    { id: 'later', provider: video(), clip: { start: 60, duration: 30, compFps: 30 } },
  ]);
  assert.deepEqual(out.rejected, ['far'], 'wrong footage never silently rendered');
  assert.deepEqual(out.skipped, ['later']);
  assert.equal(out.snapshots.length, 0);
});

test('fractional composition frames snapshot continuously', async () => {
  const shared = video();
  const clip = { start: 0, duration: 60, compFps: 30 };
  const half = await M.snapshotMediaForFrame(0.5, [{ id: 'A', provider: shared, clip }]);
  assert.equal(half.snapshots[0].snapshot.canvas.width, 640);
  assert.equal(+half.snapshots[0].time.toFixed(4), 0.0167);
});
