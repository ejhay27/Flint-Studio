import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'flint-unit-'));
const bundle = async (entry, name) => {
  const r = await build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
  const file = join(dir, name);
  writeFileSync(file, r.outputFiles[0].text);
  return import(file);
};

const R = await bundle('src/renderSettings.ts', 'rs.mjs');
const C = await bundle('src/compositor.ts', 'comp.mjs');
const THREE = await import('three');

test('resolution presets and normalisation', () => {
  let s = R.defaultExportSettings(1920, 1080, 30);
  s = R.applyPreset(s, '2160p');
  assert.deepEqual([s.width, s.height], [3840, 2160]);
  const n = R.normaliseExportSettings({ ...s, startFrame: -10, endFrame: 9e9 }, { width: 1920, height: 1080, fps: 30, duration: 10 });
  assert.equal(n.startFrame, 0);
  assert.equal(n.endFrame, 299);
  const over = R.normaliseExportSettings({ ...s, width: 99999, height: 10 }, { width: 1920, height: 1080, fps: 30, duration: 10 });
  assert.equal(over.width, 4096);
  assert.equal(over.height, 16);
});

test('fractional frame evaluation at 60 fps from a 30 fps composition', () => {
  const settings = { ...R.defaultExportSettings(1920, 1080, 60), startFrame: 0 };
  const frames = [0, 1, 2, 3, 4].map(i => R.exportFrameToCompositionFrame(i, settings, { fps: 30 }));
  assert.deepEqual(frames.map(f => +f.toFixed(3)), [0, 0.5, 1, 1.5, 2]);
  assert.equal(R.compositionFrameStep(60, 30), 0.5);
  assert.equal(R.compositionFrameStep(24, 24), 1);
});

test('frame timestamps are deterministic and independent of playback', () => {
  assert.equal(R.frameTimestamp(0, 30), 0);
  assert.equal(+R.frameTimestamp(30, 30).toFixed(4), 1);
  assert.equal(+R.frameTimestamp(15, 23.976).toFixed(6), +(15 / 23.976).toFixed(6));
});

test('capability report flags impossible requests', () => {
  const s = { ...R.defaultExportSettings(8192, 4320, 30) };
  const bad = R.checkExportCapability(s, { maxTextureSize: 4096, webgl2: false, webCodecs: false, mediaRecorder: false });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 2);
  const ok = R.checkExportCapability({ ...s, width: 1920, height: 1080 }, { maxTextureSize: 4096, webgl2: true, webCodecs: false, mediaRecorder: true });
  assert.equal(ok.ok, true);
});

test('bounded frame queue applies backpressure', () => {
  const q = new R.FrameQueue(2);
  assert.equal(q.push(1), true);
  assert.equal(q.push(2), true);
  assert.equal(q.push(3), false);
  assert.equal(q.size, 2);
  assert.equal(q.shift(), 1);
  assert.equal(q.size, 1);
});

test('corner pin homography maps the frame and rejects outside points', () => {
  const identity = C.pinMatrix({ tl: { x: 0, y: 0 }, tr: { x: 1920, y: 0 }, br: { x: 1920, y: 1080 }, bl: { x: 0, y: 1080 } }, 1920, 1080);
  const apply = (m, u, v) => {
    const x = m[0] * u + m[1] * v + m[2], y = m[3] * u + m[4] * v + m[5], w = m[6] * u + m[7] * v + m[8];
    return [x / w, y / w];
  };
  const p = apply(identity, 0.3, 0.7);
  assert.ok(Math.abs(p[0] - 0.3) < 1e-6 && Math.abs(p[1] - 0.7) < 1e-6);
  const corner = C.pinMatrix({ tl: { x: 0, y: 0 }, tr: { x: 960, y: 0 }, br: { x: 960, y: 540 }, bl: { x: 0, y: 540 } }, 1920, 1080);
  const inside = apply(corner, 0.25, 0.75);
  assert.ok(Math.abs(inside[0] - 0.5) < 1e-6 && Math.abs(inside[1] - 0.5) < 1e-6);
  const outside = apply(corner, 0.9, 0.5);
  assert.ok(outside[0] < 0 || outside[0] > 1 || outside[1] < 0 || outside[1] > 1);
});

test('blend maths matches the shader formulas', () => {
  const b = C.blendPixel([0.5, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 1], 'multiply');
  assert.deepEqual(b.map(v => +v.toFixed(3)), [0.25, 0.25, 0.25, 1]);
  const s = C.blendPixel([0.5, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 1], 'screen');
  assert.deepEqual(s.map(v => +v.toFixed(3)), [0.75, 0.75, 0.75, 1]);
  const n = C.blendPixel([1, 0, 0, 1], [0, 0, 1, 0.5], 'normal');
  assert.deepEqual(n.map(v => +v.toFixed(3)), [0.5, 0, 0.5, 1]);
  assert.equal(C.luminance([128 / 255, 128 / 255, 128 / 255]), 0.5019607843137255);
});

test('render graph scheduling: depth groups, mask order, offscreen frames', () => {
  const calls = [];
  const renderer = {
    capabilities: { isWebGL2: true },
    getContext: () => ({ MAX_TEXTURE_SIZE: 4096, getParameter: () => 4096, getExtension: () => null }),
    getRenderTarget: () => null,
    setRenderTarget() {}, setClearColor() {}, clear() {},
    render(scene) {
      const tags = [];
      scene.traverse(o => { if (o.isMesh && o.visible && o.userData.tag) tags.push(o.userData.tag); });
      calls.push(tags.length ? `scene:${tags.join('+')}` : 'quad');
    },
    readRenderTargetPixels() { this.read = true; },
  };
  const comp = new C.FlintCompositor(renderer);
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(45, 16 / 9, 1, 1000);
  const mk = tag => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial()); m.userData.tag = tag; scene.add(m); return m; };
  const A = mk('A'), B = mk('B');
  const fx = { count: 1, types: [3], params: [new THREE.Vector4(0.01, 1, 0, 0)], colors: [new THREE.Vector3()], key: 'fx:glow' };

  calls.length = 0;
  comp.render({ scene, camera: cam, width: 1920, height: 1080, background: '#000', items: [{ type: 'group', id: 'g', objects: [A, B] }] });
  assert.ok(calls.includes('scene:A+B'), 'group renders both objects in one depth pass');
  assert.equal(comp.stats.groups, 1);

  calls.length = 0;
  comp.render({ scene, camera: cam, width: 1920, height: 1080, background: '#000', items: [{ type: 'layer', id: 'a', objects: [A], mask: { texture: new THREE.Texture() }, effects: fx, maskOrder: 'before' }] });
  assert.equal(calls.filter(c => c === 'quad').length, 4, 'mask pass, effect pass, composite pass, final blit');
  assert.equal(comp.stats.maskBeforeEffects, 1);

  calls.length = 0;
  const layered = comp.render({ scene, camera: cam, width: 3840, height: 2160, background: null, offscreen: true, items: [{ type: 'layer', id: 'a', objects: [A] }] });
  assert.equal(layered, true);
  assert.deepEqual(comp.resultSize, { width: 3840, height: 2160 });
  assert.ok(comp.readPixels());
  comp.dispose();
});
