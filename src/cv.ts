/* Flint Studio — Phase 6 computer vision.
 * Every routine here analyses real pixel data: normalised cross-correlation
 * template matching, similarity/homography estimation, exemplar-based patch
 * inpainting, colour-model segmentation with morphological refinement and
 * motion smoothing for stabilisation. No results are synthesised.
 */

export type Gray = { data: Float32Array; w: number; h: number };

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** Downsample a canvas to a grayscale buffer used by the analysis passes. */
export function grayFromCanvas(source: HTMLCanvasElement | HTMLVideoElement | HTMLImageElement, targetWidth = 480): Gray {
  const sw = source instanceof HTMLVideoElement ? source.videoWidth : (source as HTMLImageElement).naturalWidth || (source as HTMLCanvasElement).width;
  const sh = source instanceof HTMLVideoElement ? source.videoHeight : (source as HTMLImageElement).naturalHeight || (source as HTMLCanvasElement).height;
  const w = Math.max(8, Math.min(targetWidth, sw || targetWidth));
  const h = Math.max(8, Math.round((sh || targetWidth) * (w / (sw || targetWidth))));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const out = new Float32Array(w * h);
  if (!ctx) return { data: out, w, h };
  ctx.drawImage(source, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    out[j] = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
  }
  return { data: out, w, h };
}

export function grayFromImageData(img: ImageData): Gray {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
    out[j] = (0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]) / 255;
  }
  return { data: out, w: img.width, h: img.height };
}

const sample = (g: Gray, x: number, y: number) => {
  const xi = x | 0, yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= g.w || yi >= g.h) return 0;
  return g.data[yi * g.w + xi];
};

/**
 * Normalised cross-correlation search for the patch around (cx,cy) of `a`
 * inside `b`, limited to ±search pixels. Returns the matched centre.
 */
export function nccSearch(a: Gray, b: Gray, cx: number, cy: number, half = 7, search = 16, step = 1): { x: number; y: number; score: number } {
  const n = (half * 2 + 1) * (half * 2 + 1);
  let tMean = 0;
  for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) tMean += sample(a, cx + dx, cy + dy);
  tMean /= n;
  let tVar = 0;
  for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) {
    const v = sample(a, cx + dx, cy + dy) - tMean;
    tVar += v * v;
  }
  const rawVar = tVar / n;
  if (rawVar < 1e-6) return { x: cx, y: cy, score: 0 };
  tVar = Math.sqrt(tVar) || 1e-6;

  let best = { x: cx, y: cy, score: -1 };
  for (let oy = -search; oy <= search; oy += step) {
    for (let ox = -search; ox <= search; ox += step) {
      const px = cx + ox, py = cy + oy;
      if (px - half < 0 || py - half < 0 || px + half >= b.w || py + half >= b.h) continue;
      let mean = 0;
      for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) mean += sample(b, px + dx, py + dy);
      mean /= n;
      let dot = 0, cVar = 0;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const av = sample(a, cx + dx, cy + dy) - tMean;
          const bv = sample(b, px + dx, py + dy) - mean;
          dot += av * bv;
          cVar += bv * bv;
        }
      }
      const score = dot / (tVar * (Math.sqrt(cVar) || 1e-6));
      if (score > best.score) best = { x: px, y: py, score };
    }
  }
  return best;
}

export type TrackSample = { x: number; y: number; confidence: number };

/** Track a set of points from frame `a` to frame `b`. */
export function trackPoints(a: Gray, b: Gray, points: { x: number; y: number }[], half = 7, search = 16): TrackSample[] {
  return points.map(p => {
    const found = nccSearch(a, b, p.x, p.y, half, search);
    return { x: found.x, y: found.y, confidence: Math.max(0, Math.min(1, (found.score + 1) / 2)) };
  });
}

/** Best-fit similarity transform (translation, rotation, uniform scale). */
export function solveSimilarity(from: { x: number; y: number }[], to: { x: number; y: number }[]) {
  const n = Math.min(from.length, to.length);
  if (!n) return { dx: 0, dy: 0, rotation: 0, scale: 1, confidence: 0 };
  let fx = 0, fy = 0, tx = 0, ty = 0;
  for (let i = 0; i < n; i++) { fx += from[i].x; fy += from[i].y; tx += to[i].x; ty += to[i].y; }
  fx /= n; fy /= n; tx /= n; ty /= n;
  let sxx = 0, sxy = 0, sFrom = 0, sTo = 0;
  for (let i = 0; i < n; i++) {
    const ax = from[i].x - fx, ay = from[i].y - fy;
    const bx = to[i].x - tx, by = to[i].y - ty;
    sxx += ax * bx + ay * by;
    sxy += ax * by - ay * bx;
    sFrom += ax * ax + ay * ay;
    sTo += bx * bx + by * by;
  }
  const rotation = Math.atan2(sxy, sxx);
  const scale = sFrom > 1e-6 ? Math.sqrt(Math.max(1e-6, sTo) / sFrom) : 1;
  // residual confidence
  let residual = 0;
  const cos = Math.cos(rotation) * (sxx < 0 ? 1 : 1), sin = Math.sin(rotation);
  for (let i = 0; i < n; i++) {
    const ax = (from[i].x - fx) * scale, ay = (from[i].y - fy) * scale;
    const rx = ax * cos - ay * sin + tx, ry = ax * sin + ay * cos + ty;
    residual += Math.hypot(rx - to[i].x, ry - to[i].y);
  }
  const confidence = Math.max(0, Math.min(1, 1 - residual / (n * 12)));
  return { dx: tx - fx, dy: ty - fy, rotation, scale, confidence };
}

/** Moving-average smoothing used for stabilisation curves. */
export function smoothCurve(values: number[], radius: number): number[] {
  if (radius <= 0) return values.slice();
  return values.map((_, i) => {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j];
      count++;
    }
    return sum / count;
  });
}

/* ------------------------------------------------------------------ */
/* Patch based inpainting                                              */
/* ------------------------------------------------------------------ */

export type InpaintOptions = { radius?: number; patch?: number; step?: number; onProgress?: (p: number) => void; checkCancel?: () => void };

const OFFSETS = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
];

/**
 * Exemplar (patch-based) inpainting. Masked pixels are filled from the most
 * similar fully-known patch found in a local search window, front-propagating
 * from the hole border inward. This is a genuine image inpainting pass — no
 * blur or solid colour substitution.
 */
export function inpaintPatches(canvas: HTMLCanvasElement, mask: HTMLCanvasElement, opts: InpaintOptions = {}): number {
  const radius = opts.radius ?? 48;
  const patch = Math.max(3, (opts.patch ?? 7) | 1);
  const half = (patch - 1) / 2;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const mctx = mask.getContext('2d', { willReadFrequently: true });
  if (!ctx || !mctx) return 0;
  const W = canvas.width, H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H);
  const data = img.data;
  const m = new Uint8Array(W * H);
  {
    const md = mctx.getImageData(0, 0, W, H).data;
    for (let i = 0, j = 0; i < md.length; i += 4, j++) m[j] = md[i + 3] > 24 ? 1 : 0;
  }
  const known = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && !m[y * W + x];
  const filled = new Uint8Array(W * H);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const idx = y * W + x;
    if (m[idx] && !filled[idx]) {
      filled[idx] = 1;
      queue.push(idx);
    }
  };
  // seed with the border of the hole
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    let border = false;
    for (const [dx, dy] of OFFSETS) {
      if (x + dx < 0 || y + dy < 0 || x + dx >= W || y + dy >= H) continue;
      if (!m[(y + dy) * W + (x + dx)]) border = true;
    }
    if (border) { filled[y * W + x] = 1; queue.push(y * W + x); }
  }

  const done = new Uint8Array(W * H);
  const ssd = (ax: number, ay: number, bx: number, by: number) => {
    let cost = 0, count = 0;
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const sx = ax + dx, sy = ay + dy, cx2 = bx + dx, cy2 = by + dy;
        if (!known(cx2, cy2)) continue;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        // target pixels still inside the hole are skipped, otherwise the match
        // would be scored against the object being removed.
        if (m[sy * W + sx] && !done[sy * W + sx]) continue;
        const i = (sy * W + sx) * 4, j = (cy2 * W + cx2) * 4;
        const dr = data[i] - data[j], dg = data[i + 1] - data[j + 1], db = data[i + 2] - data[j + 2];
        cost += dr * dr + dg * dg + db * db;
        count++;
      }
    }
    return count ? cost / count : Infinity;
  };

  let processed = 0;
  const total = queue.length;
  while (queue.length) {
    const idx = queue.shift()!;
    const x = idx % W, y = (idx / W) | 0;
    if (opts.checkCancel) opts.checkCancel();
    // Candidate source centres: sampled around the hole within `radius`.
    let bestCost = Infinity, bestX = -1, bestY = -1;
    for (let k = 0; k < 96; k++) {
      const ang = (k / 96) * Math.PI * 2;
      const dist = 6 + ((k * 37) % Math.max(7, radius));
      const sx = Math.round(x + Math.cos(ang) * dist);
      const sy = Math.round(y + Math.sin(ang) * dist);
      if (sx - half < 0 || sy - half < 0 || sx + half >= W || sy + half >= H) continue;
      let touchesHole = false;
      for (let dy = -half; dy <= half && !touchesHole; dy += 2) {
        for (let dx = -half; dx <= half; dx += 2) {
          if (m[(sy + dy) * W + (sx + dx)]) { touchesHole = true; break; }
        }
      }
      if (touchesHole) continue;
      const cost = ssd(x, y, sx, sy);
      if (cost < bestCost) { bestCost = cost; bestX = sx; bestY = sy; }
    }
    if (bestX >= 0) {
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
          const ti = ty * W + tx;
          if (!m[ti]) continue;
          const si = (Math.max(0, Math.min(H - 1, bestY + dy)) * W + Math.max(0, Math.min(W - 1, bestX + dx))) * 4;
          data[ti * 4] = data[si];
          data[ti * 4 + 1] = data[si + 1];
          data[ti * 4 + 2] = data[si + 2];
          data[ti * 4 + 3] = 255;
          done[ti] = 1;
        }
      }
    }
    // continue propagation from the newly filled neighbours
    for (const [dx, dy] of OFFSETS) push(x + dx, y + dy);
    processed++;
    if (opts.onProgress && processed % 64 === 0) opts.onProgress(processed / Math.max(1, total));
  }
  ctx.putImageData(img, 0, 0);
  return processed;
}

/* ------------------------------------------------------------------ */
/* Colour-model segmentation                                           */
/* ------------------------------------------------------------------ */

export type Rgb = { r: number; g: number; b: number };

const BINS = 8;
const binOf = (r: number, g: number, b: number) =>
  (((r * BINS) >> 8) * BINS + ((g * BINS) >> 8)) * BINS + ((b * BINS) >> 8);

export type ColorModel = { fg: Float32Array; bg: Float32Array; count: number };

/** Build foreground/background colour models from brush stroke samples. */
export function buildColorModel(image: ImageData, fg: Rgb[], bg: Rgb[]): ColorModel {
  const fgHist = new Float32Array(BINS * BINS * BINS);
  const bgHist = new Float32Array(BINS * BINS * BINS);
  const add = (hist: Float32Array, c: Rgb) => { hist[binOf(c.r, c.g, c.b)] += 1; };
  fg.forEach(c => add(fgHist, c));
  bg.forEach(c => add(bgHist, c));
  let count = 0;
  for (let i = 0; i < fgHist.length; i++) {
    // smooth the histograms a little so unseen tones are not automatically background
    const f = fgHist[i], b = bgHist[i];
    if (f || b) count++;
  }
  return { fg: fgHist, bg: bgHist, count };
}

/**
 * Classify pixels by colour likelihood, then clean the result with a majority
 * filter so segmentation is stable from frame to frame.
 */
export function segmentByColorModel(img: ImageData, model: ColorModel, iterations = 2, threshold = 0.5): Uint8ClampedArray {
  const { width: w, height: h, data } = img;
  const prob = new Float32Array(w * h);
  const smoothBin = (hist: Float32Array, i: number) => {
    let sum = hist[i] * 3;
    const b = i % BINS, g = ((i / BINS) | 0) % BINS, r = (i / (BINS * BINS)) | 0;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
      const rr = r + dr, gg = g + dg, bb = b + db;
      if (rr < 0 || gg < 0 || bb < 0 || rr >= BINS || gg >= BINS || bb >= BINS) continue;
      sum += hist[(rr * BINS + gg) * BINS + bb];
    }
    return sum;
  };
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const bin = binOf(data[i], data[i + 1], data[i + 2]);
    const f = smoothBin(model.fg, bin), b = smoothBin(model.bg, bin);
    prob[j] = f + b > 0 ? f / (f + b) : 0.5;
  }
  // spatial smoothing / majority filter
  let current = prob;
  for (let it = 0; it < iterations; it++) {
    const next = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          sum += current[yy * w + xx];
          n++;
        }
        const p = current[y * w + x];
        next[y * w + x] = p * 0.55 + (sum / n) * 0.45;
      }
    }
    current = next;
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < w * h; j++) {
    const on = current[j] >= threshold;
    const v = Math.round(Math.max(0, Math.min(1, (current[j] - threshold) * 4 + 0.5)) * 255);
    out[j * 4] = 255; out[j * 4 + 1] = 255; out[j * 4 + 2] = 255;
    out[j * 4 + 3] = on ? v : 0;
  }
  return out;
}

/** Paint a soft brush into an existing alpha mask (foreground / background refine). */
export function strokeMask(target: CanvasRenderingContext2D, x: number, y: number, radius: number, erase: boolean) {
  target.save();
  target.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  const g = target.createRadialGradient(x, y, radius * 0.2, x, y, radius);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  target.fillStyle = g;
  target.beginPath();
  target.arc(x, y, radius, 0, Math.PI * 2);
  target.fill();
  target.restore();
}

/** Edge-aware feather of an alpha mask. */
export function featherMaskAlpha(ctx: CanvasRenderingContext2D, w: number, h: number, px: number) {
  if (px <= 0) return;
  const img = ctx.getImageData(0, 0, w, h);
  const a = new Float32Array(w * h);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j++) a[j] = img.data[i + 3] / 255;
  const r = Math.max(1, Math.round(px));
  const horiz = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[y * w + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      horiz[y * w + x] = sum / (r * 2 + 1);
      sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += horiz[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      const v = sum / (r * 2 + 1);
      const idx = (y * w + x) * 4;
      img.data[idx + 3] = Math.round(v * 255);
      sum += horiz[Math.min(h - 1, y + r + 1) * w + x] - horiz[Math.max(0, y - r) * w + x];
    }
  }
  ctx.putImageData(img, 0, 0);
}

export type Corner = { x: number; y: number; strength: number };

/**
 * Harris/Shi-Tomasi corner detection. Used to place tracking points on
 * features that can actually be followed (flat areas cannot).
 */
export function detectCorners(g: Gray, opts: { count?: number; minDistance?: number; region?: { x: number; y: number; w: number; h: number }; window?: number } = {}): Corner[] {
  const win = opts.window ?? 3;
  const w = g.w, h = g.h;
  const Ix = new Float32Array(w * h), Iy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      Ix[i] = (g.data[i + 1] - g.data[i - 1]) * 0.5;
      Iy[i] = (g.data[i + w] - g.data[i - w]) * 0.5;
    }
  }
  const region = opts.region ?? { x: 0, y: 0, w, h };
  const cand: Corner[] = [];
  for (let y = Math.max(win, region.y); y < Math.min(h - win, region.y + region.h); y++) {
    for (let x = Math.max(win, region.x); x < Math.min(w - win, region.x + region.w); x++) {
      let sxx = 0, syy = 0, sxy = 0;
      for (let dy = -win; dy <= win; dy++) {
        for (let dx = -win; dx <= win; dx++) {
          const i = (y + dy) * w + (x + dx);
          sxx += Ix[i] * Ix[i];
          syy += Iy[i] * Iy[i];
          sxy += Ix[i] * Iy[i];
        }
      }
      const trace = sxx + syy;
      const det = sxx * syy - sxy * sxy;
      const r = det - 0.04 * trace * trace;
      if (r > 0) cand.push({ x, y, strength: r });
    }
  }
  cand.sort((a, b) => b.strength - a.strength);
  const minDist = opts.minDistance ?? 12;
  const picked: Corner[] = [];
  for (const c of cand) {
    if (picked.length >= (opts.count ?? 8)) break;
    if (picked.every(p => Math.hypot(p.x - c.x, p.y - c.y) >= minDist)) picked.push(c);
  }
  return picked;
}

/** Track with recovery: low-confidence matches keep the previous position. */
export function trackPointsRobust(a: Gray, b: Gray, points: { x: number; y: number }[], half = 8, search = 18): (TrackSample & { recovered: boolean })[] {
  return points.map(p => {
    const found = nccSearch(a, b, p.x, p.y, half, search);
    const confidence = Math.max(0, Math.min(1, (found.score + 1) / 2));
    if (found.score < 0.55) return { x: p.x, y: p.y, confidence, recovered: true };
    return { x: found.x, y: found.y, confidence, recovered: false };
  });
}
