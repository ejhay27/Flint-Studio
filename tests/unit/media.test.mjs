import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'flint-media-'));
const bundle = async (entry, name) => {
  const r = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
  const file = join(dir, name);
  writeFileSync(file, r.outputFiles[0].text);
  return import(file);
};
const M = await bundle('src/mediaFrameProvider.ts', 'mfp.mjs');

test('composition time maps to source time with in-point and rate', () => {
  const clip = { start: 30, duration: 60, compFps: 30, inPoint: 2.5 };
  assert.equal(M.sourceTimeForClip(30, clip), 2.5);
  assert.equal(M.sourceTimeForClip(45, clip), 3.0);
  assert.equal(+M.sourceTimeForClip(44.5, clip).toFixed(4), 2.9833);
  assert.equal(+M.sourceTimeForClip(89.9, clip).toFixed(4), 4.4967);
  assert.equal(M.sourceTimeForClip(29, clip), null, 'before the clip');
  assert.equal(M.sourceTimeForClip(90, clip), null, 'clip end is exclusive');
});

test('fractional composition frames sample media continuously', () => {
  const clip = { start: 0, duration: 90, compFps: 30 };
  const samples = [0, 0.5, 1, 1.5, 2].map(f => M.sourceTimeForClip(f, clip));
  assert.deepEqual(samples.map(v => +v.toFixed(6)), [0, 0.016667, 0.033333, 0.05, 0.066667]);
});

test('rate and clamping respect source duration', () => {
  const clip = { start: 0, duration: 60, compFps: 30, rate: 2, sourceDuration: 3 };
  assert.equal(M.sourceTimeForClip(0, clip), 0);
  assert.equal(M.sourceTimeForClip(15, clip), 1);
  assert.equal(M.sourceTimeForClip(59, clip), 3);
});

test('frame cache evicts least recently used within the byte budget', () => {
  const cache = new M.FrameCache(30, () => 10);
  cache.set(0, { n: 0 });
  cache.set(1, { n: 1 });
  cache.set(2, { n: 2 });
  assert.equal(cache.size, 3);
  cache.get(0);
  cache.set(3, { n: 3 });
  assert.equal(cache.size, 3, 'budget keeps at most 3 entries');
  assert.ok(cache.get(1) === undefined, 'least recently used entry evicted');
  assert.ok(cache.get(0) !== undefined, 'recently used entry kept');
  assert.equal(cache.evictions, 1);
  assert.equal(cache.hits, 2);
});

class FakeVideo {
  constructor(latency = 0) {
    this.currentTime = 0;
    this.readyState = 4;
    this.listeners = {};
    this.latency = latency;
    this.seeks = [];
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn); }
  set currentTimeValue(v) { this.currentTime = v; }
  setCurrentTimeSilently(v) { this._t = v; }
}

test('provider does not resolve a request until the seek completes', async () => {
  const video = new FakeVideo();
  let assigned = null;
  Object.defineProperty(video, 'currentTime', {
    get: () => assigned ?? 0,
    set: v => { assigned = v; setTimeout(() => { video.listeners.seeked?.forEach(fn => fn()); }, 10); },
  });
  const provider = new M.VideoFrameProvider(video, 500);
  let settled = false;
  const p = provider.frameAt(1.5).then(r => { settled = true; return r; });
  assert.equal(settled, false, 'not resolved synchronously');
  await new Promise(r => setTimeout(r, 5));
  assert.equal(settled, false, 'still waiting while the seek is in flight');
  const result = await p;
  assert.equal(result.exact, true);
  assert.equal(result.stale, false);
  assert.equal(+result.time.toFixed(3), 1.5);
  provider.dispose();
});

test('a frame whose interval contains the request is accepted (valid PT difference)', async () => {
  const video = new FakeVideo();
  let target = 0;
  Object.defineProperty(video, 'currentTime', {
    get: () => target,
    set: v => { setTimeout(() => { target = v - 0.01; video.listeners.seeked?.forEach(fn => fn()); }, 5); },
  });
  const provider = new M.VideoFrameProvider(video, 500);
  provider.frameDuration = 1 / 30;
  const result = await provider.frameAt(2);
  assert.equal(result.exact, true, 'requested time inside the returned interval');
  assert.equal(result.stale, false);
  provider.dispose();
});

test('provider flags a stale frame instead of returning the wrong one as exact', async () => {
  const video = new FakeVideo();
  let target = 0;
  Object.defineProperty(video, 'currentTime', {
    get: () => target,
    set: v => { setTimeout(() => { target = v - 0.5; video.listeners.seeked?.forEach(fn => fn()); }, 5); },
  });
  const provider = new M.VideoFrameProvider(video, 500);
  const result = await provider.frameAt(2);
  assert.equal(result.exact, false);
  assert.equal(result.stale, true);
  assert.equal(M.frameClassFor({ start: 2, end: 2.033 }, 2.0), 'exact');
  assert.equal(M.frameClassFor({ start: 2, end: 2.033 }, 1.99), 'future', 'frame is ahead of the request');
  assert.equal(M.frameClassFor({ start: 2, end: 2.033 }, 2.1), 'stale', 'frame is behind the request');
  provider.dispose();
});

test('provider rejects unready media, times out and cancels on dispose', async () => {
  const notReady = new FakeVideo();
  notReady.readyState = 0;
  const p1 = new M.VideoFrameProvider(notReady, 100);
  await assert.rejects(() => p1.frameAt(1), /not ready/);
  p1.dispose();

  const stuck = new FakeVideo();
  Object.defineProperty(stuck, 'currentTime', { get: () => 0, set: () => {} });
  const p2 = new M.VideoFrameProvider(stuck, 60);
  await assert.rejects(() => p2.frameAt(1), /Timed out/);
  p2.dispose();

  const p3 = new M.VideoFrameProvider(stuck, 200);
  const pending = p3.frameAt(1);
  p3.dispose();
  await assert.rejects(() => pending, /disposed/);
});

test('awaitMediaForFrame resolves every active clip at its own source time', async () => {
  const make = () => {
    const v = new FakeVideo();
    let target = 0;
    Object.defineProperty(v, 'currentTime', {
      get: () => target,
      set: x => { setTimeout(() => { target = x; v.listeners.seeked?.forEach(fn => fn()); }, 1); },
    });
    return v;
  };
  const shared = make();
  const clips = [
    { id: 'A', provider: shared, clip: { start: 0, duration: 30, compFps: 30, inPoint: 1 } },
    { id: 'B', provider: shared, clip: { start: 0, duration: 30, compFps: 30, inPoint: 4 } },
    { id: 'C', provider: shared, clip: { start: 20, duration: 5, compFps: 30 } },
  ];
  const out = await M.awaitMediaForFrame(0, clips);
  assert.deepEqual(out.resolved.map(r => [r.id, +r.time.toFixed(4), r.exact, r.stale]), [
    ['A', 1, true, false],
    ['B', 4, true, false],
  ]);
  assert.deepEqual(out.skipped, ['C'], 'clip not live at this composition time');
});

test('awaitMediaForFrame honours fractional composition frames and trimming', async () => {
  const v = new FakeVideo();
  let target = 0;
  Object.defineProperty(v, 'currentTime', {
    get: () => target,
    set: x => { setTimeout(() => { target = x; v.listeners.seeked?.forEach(fn => fn()); }, 1); },
  });
  const clip = { start: 0, duration: 30, compFps: 30, inPoint: 2 };
  for (const frame of [0, 0.5, 1, 1.5]) {
    const out = await M.awaitMediaForFrame(frame, [{ id: 'A', provider: v, clip }]);
    assert.equal(+out.resolved[0].time.toFixed(4), +(2 + frame / 30).toFixed(4));
    assert.equal(out.resolved[0].exact, true);
  }
});
