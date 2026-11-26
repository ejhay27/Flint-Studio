/** Deterministic test compositions. Every scene is plain JSON so a failure is reproducible. */
const base = {
  start: 0, duration: 300, visible: true, locked: false, muted: false, color: '#ffffff',
  x: 960, y: 540, z: 0, scale: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1,
  keys: [], volume: 1, fov: 45, zoom: 1, effects: [], fader: 0,
};
const shape = (id: string, over: Record<string, unknown> = {}) => ({
  ...base, id, name: id, kind: 'shape', shapeType: 'rectangle', start: 0, duration: 300, ...over,
});
const mask = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, shape: 'ellipse', enabled: true, inverted: false, opacity: 1, feather: 0,
  expansion: 0, x: 0, y: 0, scale: 1, rotation: 0, mode: 'alpha', op: 'add',
  points: [{ x: 700, y: 380 }, { x: 1180, y: 380 }, { x: 1180, y: 700 }, { x: 700, y: 700 }],
  closed: true, keys: [], ...over,
});
const glow = { uid: 'glow1', type: 'glow', enabled: true, params: { strength: 1.2, radius: 0.03 }, keys: [] };

export const sceneMaskGlow = {
  name: 'scene-b-mask-glow', width: 1920, height: 1080, fps: 30, duration: 10, transitions: [],
  layers: [
    shape('plate', { color: '#ffffff', masks: [mask('m1')], effects: [glow] }),
  ],
};

export const sceneMaskBeforeAfter = (order: 'before' | 'after') => ({
  name: `scene-b-${order}`, width: 1920, height: 1080, fps: 30, duration: 10, transitions: [],
  layers: [shape('plate', { color: '#ffffff', masks: [mask('m1')], effects: [glow], maskOrder: order })],
});

export const sceneSpatial = {
  name: 'scene-a-spatial', width: 1920, height: 1080, fps: 30, duration: 10, transitions: [],
  layers: [
    shape('back', { x: 860, y: 540, z: -120, color: '#808080', scale: 1.4 }),
    shape('front', { x: 1010, y: 540, z: 120, color: '#ffffff', scale: 1.1 }),
    shape('camera', { kind: 'camera', name: 'Camera', color: '#cccccc' }),
  ],
};

export const sceneTransparent = {
  name: 'scene-h-alpha', width: 1920, height: 1080, fps: 30, duration: 10, transitions: [],
  layers: [
    shape('half', { color: '#ff0000', opacity: 0.5, scale: 1.2 }),
    shape('matted', {
      color: '#00ff00', scale: 0.8,
      trackMatte: { sourceId: 'half', type: 'luminance' },
    }),
  ],
};

export const sceneAnimation30 = {
  name: 'scene-f-timing', width: 1920, height: 1080, fps: 30, duration: 4, transitions: [],
  layers: [
    shape('mover', {
      color: '#ffffff', start: 0, duration: 120,
      keys: [
        { frame: 0, x: 200, y: 540, z: 0, scale: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1 },
        { frame: 60, x: 1720, y: 540, z: 0, scale: 1, rotation: 0, rotationX: 0, rotationY: 0, opacity: 1 },
      ],
    }),
  ],
};

export const encodeScene = (scene: unknown) => Buffer.from(JSON.stringify(scene)).toString('base64');
