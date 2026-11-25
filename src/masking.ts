/* Flint Studio — Phase 6 masking engine.
 * All mask maths here operate on real pixels: paths are rasterised to alpha
 * canvases, combined with boolean operations, feathered with a separable box
 * blur and finally multiplied into the layer's rendered pixels.
 */

export type MaskShape = 'rectangle' | 'rounded-rectangle' | 'ellipse' | 'polygon' | 'freehand' | 'bezier' | 'path';
export type MaskOp = 'add' | 'subtract' | 'intersect' | 'exclude' | 'difference';
export type MaskType = 'alpha' | 'luminance';

export type MaskPoint = { x: number; y: number; ix: number; iy: number; ox: number; oy: number };

export type MaskPathKey = {
  frame: number;
  points: MaskPoint[];
  closed?: boolean;
  easing?: string;
  handleIn?: number;
  handleOut?: number;
};

export type Mask = {
  id: string;
  name: string;
  shape: MaskShape;
  enabled: boolean;
  locked?: boolean;
  inverted: boolean;
  mode: MaskOp;
  type: MaskType;
  opacity: number;
  featherX: number;
  featherY: number;
  expansion: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  points: MaskPoint[];
  keys: MaskPathKey[];
  closed: boolean;
  frozen?: boolean;
};

export type CornerPin = {
  enabled: boolean;
  tl: { x: number; y: number };
  tr: { x: number; y: number };
  br: { x: number; y: number };
  bl: { x: number; y: number };
  keys?: { frame: number; tl: { x: number; y: number }; tr: { x: number; y: number }; br: { x: number; y: number }; bl: { x: number; y: number } }[];
};

export type MatteType = 'alpha' | 'alpha-inverted' | 'luminance' | 'luminance-inverted';
export type TrackMatte = { sourceId: string; type: MatteType };

let uid = 0;
const nextId = () => `m${Date.now().toString(36)}${(uid++).toString(36)}`;

const pt = (x: number, y: number): MaskPoint => ({ x, y, ix: 0, iy: 0, ox: 0, oy: 0 });

/** Build a fresh mask of the requested primitive, sized in composition pixels. */
export function createMask(shape: MaskShape, width: number, height: number, center?: { x: number; y: number }): Mask {
  const cx = center?.x ?? width / 2;
  const cy = center?.y ?? height / 2;
  const rx = Math.max(24, width * 0.22);
  const ry = Math.max(24, height * 0.22);
  const k = 0.5523;
  let points: MaskPoint[] = [];
  let closed = true;
  let name = 'Mask';
  switch (shape) {
    case 'rectangle':
      name = 'Rectangle mask';
      points = [pt(cx - rx, cy - ry), pt(cx + rx, cy - ry), pt(cx + rx, cy + ry), pt(cx - rx, cy + ry)];
      break;
    case 'rounded-rectangle': {
      name = 'Rounded mask';
      const r = Math.min(rx, ry) * 0.28;
      points = [
        pt(cx - rx + r, cy - ry), pt(cx + rx - r, cy - ry),
        pt(cx + rx, cy - ry + r), pt(cx + rx, cy + ry - r),
        pt(cx + rx - r, cy + ry), pt(cx - rx + r, cy + ry),
        pt(cx - rx, cy + ry - r), pt(cx - rx, cy - ry + r),
      ];
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const isTop = i === 0 || i === 1;
        const isBottom = i === 4 || i === 5;
        const isLeft = i === 6 || i === 7;
        const isRight = i === 2 || i === 3;
        if (isTop) { p.ox = r * 0.55; p.ix = -r * 0.55; }
        if (isBottom) { p.ox = -r * 0.55; p.ix = r * 0.55; }
        if (isLeft) { p.iy = -r * 0.55; p.oy = r * 0.55; }
        if (isRight) { p.iy = r * 0.55; p.oy = -r * 0.55; }
      }
      break;
    }
    case 'ellipse':
      name = 'Ellipse mask';
      points = [
        pt(cx, cy - ry), pt(cx + rx, cy), pt(cx, cy + ry), pt(cx - rx, cy),
      ];
      points[0].ix = -rx * k; points[0].ox = rx * k;
      points[1].iy = -ry * k; points[1].oy = ry * k;
      points[2].ix = rx * k; points[2].ox = -rx * k;
      points[3].iy = ry * k; points[3].oy = -ry * k;
      break;
    case 'polygon': {
      name = 'Polygon mask';
      const sides = 5;
      for (let i = 0; i < sides; i++) {
        const a = -Math.PI / 2 + (i / sides) * Math.PI * 2;
        points.push(pt(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry));
      }
      break;
    }
    case 'freehand':
      name = 'Freehand mask';
      closed = false;
      points = [];
      break;
    case 'bezier':
      name = 'Bézier mask';
      points = [
        pt(cx - rx, cy + ry * 0.4),
        pt(cx, cy - ry),
        pt(cx + rx, cy + ry * 0.4),
      ];
      points[0].ox = rx * 0.5; points[0].oy = -ry * 0.1;
      points[1].ix = -rx * 0.5; points[1].iy = ry * 0.1;
      points[1].ox = rx * 0.5; points[1].oy = ry * 0.1;
      points[2].ix = -rx * 0.5; points[2].iy = -ry * 0.1;
      break;
    case 'path':
    default:
      name = 'Path mask';
      points = [pt(cx - rx, cy - ry), pt(cx + rx, cy - ry), pt(cx + rx, cy + ry), pt(cx - rx, cy + ry)];
      break;
  }
  return {
    id: nextId(), name, shape, enabled: true, inverted: false, mode: 'add', type: 'alpha',
    opacity: 1, featherX: 0, featherY: 0, expansion: 0,
    x: 0, y: 0, scale: 1, rotation: 0, points, keys: [], closed,
  };
}

/* ------------------------------------------------------------------ */
/* Path maths                                                          */
/* ------------------------------------------------------------------ */

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Arc-length positions of each point on a polyline (used for stable resampling). */
function arcPositions(points: MaskPoint[], closed: boolean): number[] {
  const out: number[] = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + dist(points[i - 1], points[i]));
  if (closed && points.length > 1) out.push(out[out.length - 1] + dist(points[points.length - 1], points[0]));
  return out;
}

function lerpPoint(a: MaskPoint, b: MaskPoint, t: number): MaskPoint {
  return {
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    ix: a.ix + (b.ix - a.ix) * t, iy: a.iy + (b.iy - a.iy) * t,
    ox: a.ox + (b.ox - a.ox) * t, oy: a.oy + (b.oy - a.oy) * t,
  };
}

/** Sample a path at a normalised arc position (0..1) — keeps topology stable. */
export function samplePath(points: MaskPoint[], closed: boolean, u: number): MaskPoint {
  if (!points.length) return pt(0, 0);
  if (points.length === 1) return { ...points[0] };
  const pos = arcPositions(points, closed);
  const total = pos[pos.length - 1] || 1;
  const target = Math.max(0, Math.min(1, u)) * total;
  const pts = closed ? [...points, points[0]] : points;
  for (let i = 1; i < pts.length; i++) {
    const seg = pos[i] - pos[i - 1];
    if (target <= pos[i] || i === pts.length - 1) {
      const t = seg > 0 ? Math.max(0, Math.min(1, (target - pos[i - 1]) / seg)) : 0;
      return lerpPoint(pts[i - 1], pts[i], t);
    }
  }
  return { ...points[points.length - 1] };
}

/** Resample a path to exactly `count` points, preserving its shape. */
export function resamplePath(points: MaskPoint[], closed: boolean, count: number): MaskPoint[] {
  if (count <= 0) return [];
  if (!points.length) return Array.from({ length: count }, () => pt(0, 0));
  if (points.length === count) return points.map(p => ({ ...p }));
  const out: MaskPoint[] = [];
  const span = closed ? count : Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const p = samplePath(points, closed, closed ? i / count : i / span);
    // rotate inherited handles into the sampled tangent direction
    out.push(p);
  }
  return out;
}

export function reverseMaskPath(points: MaskPoint[]): MaskPoint[] {
  return points.slice().reverse().map(p => ({ x: p.x, y: p.y, ix: p.ox, iy: p.oy, ox: p.ix, oy: p.iy }));
}

/** Ramer–Douglas–Peucker simplification on anchor positions. */
export function simplifyPath(points: MaskPoint[], tolerance = 2): MaskPoint[] {
  if (points.length < 4) return points;
  const sq = tolerance * tolerance;
  const sqSegDist = (p: MaskPoint, a: MaskPoint, b: MaskPoint) => {
    let x = a.x, y = a.y;
    let dx = b.x - x, dy = b.y - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b.x; y = b.y; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p.x - x; dy = p.y - y;
    return dx * dx + dy * dy;
  };
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = 0, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(points[i], points[first], points[last]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > sq) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const easeFn = (t: number, easing?: string) => {
  switch ((easing || '').toLowerCase()) {
    case 'hold': return 0;
    case 'ease in': return t * t * t;
    case 'ease out': return 1 - Math.pow(1 - t, 3);
    case 'ease in out': return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    default: return t;
  }
};

/** Interpolate mask geometry at a frame. Never mutates stored keys. */
export function maskPathAt(mask: Mask, frame: number): { points: MaskPoint[]; closed: boolean } {
  const keys = (mask.keys || []).slice().sort((a, b) => a.frame - b.frame);
  if (!keys.length) return { points: mask.points, closed: mask.closed };
  if (frame <= keys[0].frame) return { points: keys[0].points, closed: keys[0].closed ?? mask.closed };
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return { points: last.points, closed: last.closed ?? mask.closed };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      const t = easeFn(Math.max(0, Math.min(1, (frame - a.frame) / Math.max(1, b.frame - a.frame))), a.easing);
      const ca = a.closed ?? mask.closed, cb = b.closed ?? mask.closed;
      if (a.points.length === b.points.length) {
        return { points: a.points.map((p, idx) => lerpPoint(p, b.points[idx], t)), closed: ca };
      }
      // Different topology: resample both to the denser count without altering stored data.
      const count = Math.max(a.points.length, b.points.length);
      const ap = resamplePath(a.points, ca, count);
      const bp = resamplePath(b.points, cb, count);
      return { points: ap.map((p, idx) => lerpPoint(p, bp[idx], t)), closed: ca };
    }
  }
  return { points: mask.points, closed: mask.closed };
}

/** Path2D for a mask in composition space (canvas coordinates). */
export function buildMaskPath(points: MaskPoint[], closed: boolean): Path2D {
  const path = new Path2D();
  if (!points.length) return path;
  path.moveTo(points[0].x, points[0].y);
  const n = points.length;
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (a.ox || a.oy || b.ix || b.iy) path.bezierCurveTo(a.x + a.ox, a.y + a.oy, b.x + b.ix, b.y + b.iy, b.x, b.y);
    else path.lineTo(b.x, b.y);
  }
  if (closed) path.closePath();
  return path;
}

/* ------------------------------------------------------------------ */
/* Rasterisation                                                       */
/* ------------------------------------------------------------------ */

const scratchPool: HTMLCanvasElement[] = [];
function scratchCanvas(w: number, h: number): HTMLCanvasElement {
  const c = scratchPool.pop() || document.createElement('canvas');
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}
function releaseCanvas(c: HTMLCanvasElement) {
  if (scratchPool.length < 6 && !scratchPool.includes(c)) scratchPool.push(c);
}

/** Fast separable box blur of the alpha channel only. */
function blurAlpha(ctx: CanvasRenderingContext2D, w: number, h: number, radiusX: number, radiusY: number) {
  const rx = Math.round(radiusX), ry = Math.round(radiusY);
  if (rx <= 0 && ry <= 0) return;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  if (rx > 0) boxPass(d, w, h, rx, true);
  if (ry > 0) boxPass(d, w, h, ry, false);
  ctx.putImageData(img, 0, 0);
}

function boxPass(d: Uint8ClampedArray, w: number, h: number, radius: number, horizontal: boolean) {
  const r = Math.max(1, radius);
  const len = horizontal ? w : h;
  const outer = horizontal ? h : w;
  const stride = horizontal ? 4 : w * 4;
  const lineStep = horizontal ? w * 4 : 4;

  // Running-sum box blur on the alpha channel of every row / column.
  const acc = new Float32Array(len);
  for (let o = 0; o < outer; o++) {
    const base = o * lineStep;
    for (let i = 0; i < len; i++) acc[i] = d[base + i * stride + 3];
    const out = new Float32Array(len);
    let sum = 0;
    const win = r * 2 + 1;
    for (let i = -r; i <= r; i++) sum += acc[Math.max(0, Math.min(len - 1, i))];
    for (let i = 0; i < len; i++) {
      out[i] = sum / win;
      const add = acc[Math.min(len - 1, i + r + 1)];
      const sub = acc[Math.max(0, i - r)];
      sum += add - sub;
    }
    for (let i = 0; i < len; i++) d[base + i * stride + 3] = out[i];
  }
}

export type MaskRasterOptions = {
  width: number;
  height: number;
  frame: number;
  /** Raster resolution multiplier (0.5 = half-res proxy). */
  scale?: number;
};

/**
 * Rasterise a list of masks into a single alpha canvas.
 * Boolean operations are applied in list order using canvas compositing.
 */
export function rasterizeMasks(masks: Mask[], opts: MaskRasterOptions): HTMLCanvasElement | null {
  const active = (masks || []).filter(m => m && m.enabled && m.opacity > 0);
  if (!active.length) return null;
  const res = Math.max(0.25, Math.min(1, opts.scale ?? 0.5));
  const w = Math.max(8, Math.round(opts.width * res));
  const h = Math.max(8, Math.round(opts.height * res));
  const out = scratchCanvas(w, h);
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const k = w / opts.width;

  let first = true;
  for (const mask of active) {
    const { points, closed } = maskPathAt(mask, opts.frame);
    if (points.length < 2) continue;
    const layer = scratchCanvas(w, h);
    const lctx = layer.getContext('2d');
    if (!lctx) continue;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, w, h);

    // Build path in composition space then transform about the mask origin.
    const path = buildMaskPath(points, closed);
    const cx = (mask.x || 0) * k, cy = (mask.y || 0) * k;
    const sc = mask.scale || 1;
    const rot = ((mask.rotation || 0) * Math.PI) / 180;
    lctx.save();
    // mask rotation/scale pivot on the mask's own centre
    let px = 0, py = 0;
    for (const p of points) { px += p.x; py += p.y; }
    px = (px / points.length) * k;
    py = (py / points.length) * k;
    lctx.translate(px + cx, py + cy);
    lctx.rotate(rot);
    lctx.scale(sc, sc);
    lctx.translate(-px, -py);
    lctx.fillStyle = '#fff';
    lctx.lineJoin = 'round';
    const expand = mask.expansion * k;
    if (expand > 0) {
      lctx.lineWidth = Math.max(0.1, expand * 2);
      lctx.strokeStyle = '#fff';
      lctx.stroke(path);
    }
    lctx.fill(path);
    if (expand < 0) {
      lctx.globalCompositeOperation = 'destination-out';
      lctx.lineWidth = Math.max(0.1, -expand * 2);
      lctx.strokeStyle = '#fff';
      lctx.stroke(path);
      lctx.globalCompositeOperation = 'source-over';
    }
    lctx.restore();
    lctx.setTransform(1, 0, 0, 1, 0, 0);

    const fx = Math.max(0, (mask.featherX || 0) * k);
    const fy = Math.max(0, (mask.featherY || 0) * k);
    if (fx > 0.4 || fy > 0.4) blurAlpha(lctx, w, h, fx * 0.55, fy * 0.55);

    // opacity
    if (mask.inverted) {
      const inv = scratchCanvas(w, h);
      const ictx = inv.getContext('2d');
      if (ictx) {
        ictx.setTransform(1, 0, 0, 1, 0, 0);
        ictx.clearRect(0, 0, w, h);
        ictx.fillStyle = '#fff';
        ictx.fillRect(0, 0, w, h);
        ictx.globalCompositeOperation = 'destination-out';
        ictx.drawImage(layer, 0, 0);
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.globalCompositeOperation = 'copy';
        lctx.drawImage(inv, 0, 0);
        lctx.globalCompositeOperation = 'source-over';
      }
      releaseCanvas(inv);
    }
    if (mask.opacity < 1) {
      lctx.globalCompositeOperation = 'destination-in';
      lctx.globalAlpha = 1;
      lctx.fillStyle = `rgba(255,255,255,${Math.max(0, Math.min(1, mask.opacity))})`;
      lctx.fillRect(0, 0, w, h);
      lctx.globalCompositeOperation = 'source-over';
    }

    const skip = first && (mask.mode === 'subtract' || mask.mode === 'intersect');
    first = false;
    if (!skip) {
      if (mask.mode === 'exclude' || mask.mode === 'difference') {
        // Symmetric difference implemented explicitly: (A ∪ B) − (A ∩ B)
        const union = scratchCanvas(w, h);
        const uctx = union.getContext('2d');
        const inter = scratchCanvas(w, h);
        const ictx = inter.getContext('2d');
        if (uctx && ictx) {
          uctx.setTransform(1, 0, 0, 1, 0, 0); uctx.clearRect(0, 0, w, h);
          uctx.drawImage(out, 0, 0); uctx.drawImage(layer, 0, 0);
          ictx.setTransform(1, 0, 0, 1, 0, 0); ictx.clearRect(0, 0, w, h);
          ictx.drawImage(layer, 0, 0);
          ictx.globalCompositeOperation = 'destination-in';
          ictx.drawImage(out, 0, 0);
          uctx.globalCompositeOperation = 'destination-out';
          uctx.drawImage(inter, 0, 0);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.globalCompositeOperation = 'copy';
          ctx.drawImage(union, 0, 0);
        }
        releaseCanvas(union); releaseCanvas(inter);
      } else {
        if (mask.mode === 'subtract') ctx.globalCompositeOperation = 'destination-out';
        else if (mask.mode === 'intersect') ctx.globalCompositeOperation = 'destination-in';
        else ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(layer, 0, 0);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    releaseCanvas(layer);
  }

  return out;
}

/** Multiply a rendered layer canvas by a mask canvas (real pixel alpha). */
export function applyMaskCanvas(layer: HTMLCanvasElement, mask: HTMLCanvasElement) {
  const ctx = layer.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0, layer.width, layer.height);
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

/** Convert a rendered matte canvas into the alpha used for track mattes. */
export function buildMatteCanvas(source: HTMLCanvasElement, type: MatteType): HTMLCanvasElement {
  const w = source.width, h = source.height;
  const out = scratchCanvas(w, h);
  const ctx = out.getContext('2d');
  if (!ctx) return source;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0);
  const lum = type === 'luminance' || type === 'luminance-inverted';
  if (lum) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(d[i + 3] * l);
    }
    ctx.putImageData(img, 0, 0);
  }
  if (type === 'alpha-inverted' || type === 'luminance-inverted') {
    const inv = scratchCanvas(w, h);
    const ictx = inv.getContext('2d');
    if (ictx) {
      ictx.setTransform(1, 0, 0, 1, 0, 0);
      ictx.clearRect(0, 0, w, h);
      ictx.fillStyle = '#fff';
      ictx.fillRect(0, 0, w, h);
      ictx.globalCompositeOperation = 'destination-out';
      ictx.drawImage(out, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(inv, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      releaseCanvas(inv);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Corner pin (projective transform)                                   */
/* ------------------------------------------------------------------ */

export type Pt = { x: number; y: number };

/** Solve the homography mapping 4 source points to 4 destination points. */
export function homography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    if (Math.abs(A[pivot][col]) < 1e-12) continue;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    const pv = A[col][col];
    for (let j = col; j < n; j++) A[col][j] /= pv;
    b[col] /= pv;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = A[row][col];
      if (!f) continue;
      for (let j = col; j < n; j++) A[row][j] -= f * A[col][j];
      b[row] -= f * b[col];
    }
  }
  return [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], 1];
}

export function applyH(h: number[], x: number, y: number): Pt {
  const d = h[6] * x + h[7] * y + h[8];
  const s = Math.abs(d) < 1e-9 ? 1e-9 : d;
  return { x: (h[0] * x + h[1] * y + h[2]) / s, y: (h[3] * x + h[4] * y + h[5]) / s };
}

export function invertH(h: number[]): number[] {
  // Adjugate of the 3x3 matrix (sufficient for projective inversion).
  const a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], gg = h[7], i = h[8];
  const A = e * i - f * gg, B = -(d * i - f * g), C = d * gg - e * g;
  const D = -(b * i - c * gg), E = a * i - c * g, F = -(a * gg - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C || 1e-9;
  return [A / det, D / det, G / det, B / det, E / det, H / det, C / det, F / det, I / det];
}

export function cornerPinAt(pin: CornerPin, frame: number): { tl: Pt; tr: Pt; br: Pt; bl: Pt } {
  const keys = (pin.keys || []).slice().sort((a, b) => a.frame - b.frame);
  if (!keys.length) return { tl: pin.tl, tr: pin.tr, br: pin.br, bl: pin.bl };
  const first = keys[0], last = keys[keys.length - 1];
  if (frame <= first.frame) return { tl: first.tl, tr: first.tr, br: first.br, bl: first.bl };
  if (frame >= last.frame) return { tl: last.tl, tr: last.tr, br: last.br, bl: last.bl };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      const t = (frame - a.frame) / Math.max(1, b.frame - a.frame);
      const mix = (p: Pt, q: Pt) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      return { tl: mix(a.tl, b.tl), tr: mix(a.tr, b.tr), br: mix(a.br, b.br), bl: mix(a.bl, b.bl) };
    }
  }
  return { tl: pin.tl, tr: pin.tr, br: pin.br, bl: pin.bl };
}

/**
 * Warp a rendered canvas through a projective transform using a triangle mesh.
 * Each cell is split into two triangles; the affine matrix of every triangle is
 * derived from the exact homography of its three corners.
 */
export function warpProjective(src: HTMLCanvasElement, dst: HTMLCanvasElement, corners: { tl: Pt; tr: Pt; br: Pt; bl: Pt }, grid = 18) {
  const ctx = dst.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, dst.width, dst.height);
  const W = src.width, H = src.height;
  const srcQuad = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const dstQuad = [corners.tl, corners.tr, corners.br, corners.bl];
  const h = homography(srcQuad, dstQuad);
  const at = (u: number, v: number) => applyH(h, u * W, v * H);
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const u0 = i / grid, u1 = (i + 1) / grid, v0 = j / grid, v1 = (j + 1) / grid;
      const p00 = at(u0, v0), p10 = at(u1, v0), p11 = at(u1, v1), p01 = at(u0, v1);
      drawTriangle(ctx, src, { x: u0 * W, y: v0 * H }, { x: u1 * W, y: v0 * H }, { x: u1 * W, y: v1 * H }, p00, p10, p11);
      drawTriangle(ctx, src, { x: u0 * W, y: v0 * H }, { x: u1 * W, y: v1 * H }, { x: u0 * W, y: v1 * H }, p00, p11, p01);
    }
  }
}

function drawTriangle(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, s0: Pt, s1: Pt, s2: Pt, d0: Pt, d1: Pt, d2: Pt) {
  const denom = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(denom) < 1e-9) return;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / denom;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / denom;
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / denom;
  const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / denom;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;
  ctx.save();
  // Expand the clip triangle by ~1px about its centroid to hide seams between cells.
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  const grow = 1 + 2 / Math.max(4, Math.max(Math.hypot(d1.x - d0.x, d1.y - d0.y), Math.hypot(d2.x - d0.x, d2.y - d0.y)));
  const ex = (p: Pt) => ({ x: cx + (p.x - cx) * grow, y: cy + (p.y - cy) * grow });
  const q0 = ex(d0), q1 = ex(d1), q2 = ex(d2);
  ctx.beginPath();
  ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.lineTo(q2.x, q2.y); ctx.closePath();
  ctx.clip();
  // expand the clip slightly to avoid hairline seams between triangles
  ctx.setTransform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* ------------------------------------------------------------------ */
/* Editing helpers (topology-safe)                                     */
/* ------------------------------------------------------------------ */

/** Add a point to every keyframe so animation topology stays consistent. */
export function insertPointEverywhere(mask: Mask, index: number, point: MaskPoint): Mask {
  const keys = mask.keys.map(k => {
    const pts = k.points.slice();
    const at = Math.max(0, Math.min(pts.length, index));
    pts.splice(at, 0, { ...point });
    return { ...k, points: pts };
  });
  const points = mask.points.slice();
  points.splice(Math.max(0, Math.min(points.length, index)), 0, { ...point });
  return { ...mask, points, keys };
}

export function removePointEverywhere(mask: Mask, index: number): Mask {
  const filter = (pts: MaskPoint[]) => pts.filter((_, i) => i !== index);
  return { ...mask, points: filter(mask.points), keys: mask.keys.map(k => ({ ...k, points: filter(k.points) })) };
}

/** Resample every key to a common point count (used after heavy edits). */
export function normalizeTopology(mask: Mask): Mask {
  const counts = [mask.points.length, ...mask.keys.map(k => k.points.length)];
  const target = Math.max(...counts, 0);
  if (!target) return mask;
  return {
    ...mask,
    points: resamplePath(mask.points, mask.closed, target),
    keys: mask.keys.map(k => ({ ...k, points: resamplePath(k.points, k.closed ?? mask.closed, target) })),
  };
}

export function bakeMaskKey(mask: Mask, frame: number): Mask {
  const { points, closed } = maskPathAt(mask, frame);
  const keys = mask.keys.filter(k => k.frame !== frame);
  keys.push({ frame, points: points.map(p => ({ ...p })), closed });
  return { ...mask, keys: keys.sort((a, b) => a.frame - b.frame) };
}

export function cloneMask(mask: Mask): Mask {
  return {
    ...mask,
    id: nextId(),
    name: `${mask.name} copy`,
    points: mask.points.map(p => ({ ...p })),
    keys: mask.keys.map(k => ({ ...k, points: k.points.map(p => ({ ...p })) })),
  };
}

export function resetMask(mask: Mask, width: number, height: number): Mask {
  const fresh = createMask(mask.shape, width, height);
  return { ...fresh, id: mask.id, name: mask.name, mode: mask.mode, type: mask.type, keys: [] };
}

export function maskCentroid(points: MaskPoint[]): { x: number; y: number } {
  if (!points.length) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}
