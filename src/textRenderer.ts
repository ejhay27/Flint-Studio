import { TextAnimation, progressFor } from './typography';

export type CharTransform = { x?: number; y?: number; rotation?: number; scale?: number; color?: string; size?: number };

export type TextLayerLike = {
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontItalic?: boolean;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  letterSpacing?: number;
  lineSpacing?: number;
  kerning?: number;
  baselineShift?: number;
  color: string;
  strokeText?: string;
  strokeTextWidth?: number;
  textBackground?: string;
  textPadding?: number;
  textRadius?: number;
  textShadow?: boolean;
  textShadowColor?: string;
  textGlow?: number;
  textInnerShadow?: number;
  textBlendMode?: string;
  textAnimations?: TextAnimation[];
  textFillMode?: 'solid' | 'linear' | 'radial';
  gradientStart?: string;
  gradientEnd?: string;
  gradientMid?: string;
  gradientAngle?: number;
  underline?: boolean;
  strikethrough?: boolean;
  textBoxWidth?: number;
  textCurve?: number;
  textPath?: string;
  textVertical?: boolean;
  textWarp?: 'none' | 'wave' | 'bulge' | 'arch';
  textWarpAmount?: number;
  textPerspective?: number;
  charTransforms?: Record<string, CharTransform>;
  wordTransforms?: Record<string, CharTransform>;
};

type Slot = { ch: string; x: number; y: number; rot: number; scale: number; line: number; word: number; char: number };

/* ------------------------------------------------------------------ */
/* Whole-layer animation evaluation (position / scale / opacity)      */
/* ------------------------------------------------------------------ */

export function evaluateText(layer: TextLayerLike, x: number, y: number, scale: number, rotation: number, opacity: number, frame: number, fps: number) {
  let px = x, py = y, sc = scale, rot = rotation, alpha = opacity, rotationX = 0, rotationY = 0, blur = 0;
  const animations = layer.textAnimations || [];
  for (const a of animations) {
    if (!a.enabled) continue;
    const p = progressFor(a, frame, fps);
    const n = a.type;
    const amount = 1 - p;
    if (a.scope !== 'text') continue;
    if (n.includes('fade') || n === 'mask-reveal' || n === 'mask-disappear') alpha *= p;
    else if (n.includes('slide-up')) py += a.amplitude * amount;
    else if (n.includes('slide-down')) py -= a.amplitude * amount;
    else if (n.includes('slide-left')) px -= a.amplitude * amount;
    else if (n.includes('slide-right')) px += a.amplitude * amount;
    else if (n.includes('zoom') || n === 'shrink') sc *= Math.max(0.01, a.scale + (1 - a.scale) * p);
    else if (n.includes('spin') || n.includes('rotate')) rot += amount * a.rotation;
    else if (n.includes('bounce')) { py += amount * a.amplitude - Math.sin(p * Math.PI * 2) * a.amplitude * 0.15; alpha = Math.min(1, alpha * Math.max(0.05, p)); }
    else if (n.includes('elastic')) sc *= Math.max(0.05, 1 + amount * Math.sin(amount * Math.PI * 5) * 0.25);
    else if (n.includes('flip')) rotationY += amount * 180;
    else if (n.includes('3d-rotation')) rotationX += amount * a.rotation;
    else if (n.includes('blur')) blur += amount * Math.max(1, a.blur);
    else if (n.includes('stretch') || n.includes('swish') || n.includes('stretch-reveal')) sc *= 1 + amount * a.intensity;
    else if (n.includes('perspective')) { rotationX += amount * a.rotation; sc *= 1 - amount * 0.15; alpha = Math.min(1, alpha * Math.max(0.05, p)); }
    else if (n.includes('glitch')) alpha = Math.min(1, alpha * (p > 0.08 ? 1 : 0.35));
    else if (n === 'floating' || n === 'wave' || n === 'swing' || n === 'wiggle' || n === 'breathing' || n === 'pulse' || n === 'rotation' || n === '3d-orbit' || n === 'neon-flicker') {
      const t = (frame / fps) * a.frequency * Math.PI * 2;
      if (n === 'floating' || n === 'wave') py += Math.sin(t) * a.amplitude;
      if (n === 'swing' || n === 'wiggle') rot += Math.sin(t) * a.rotation;
      if (n === 'pulse' || n === 'breathing') sc *= 1 + Math.sin(t) * 0.08 * a.intensity;
      if (n === 'rotation') rot += (t * 180) / Math.PI;
      if (n === '3d-orbit') rotationY += Math.sin(t) * a.rotation;
      if (n === 'neon-flicker') alpha = Math.min(1, alpha * (0.55 + 0.45 * Math.abs(Math.sin(t * 2.1))));
    }
  }
  return { x: px, y: py, scale: sc, rotation: rot, rotationX, rotationY, opacity: Math.max(0, Math.min(1, alpha)), blur };
}

/* ------------------------------------------------------------------ */
/* Path sampling (text along a vector path)                            */
/* ------------------------------------------------------------------ */

type PathSample = { x: number; y: number; tx: number; ty: number; length: number; width: number; height: number };
const pathCache = new Map<string, PathSample[]>();

function samplePath(d: string): PathSample[] {
  const cached = pathCache.get(d);
  if (cached) return cached;
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', d);
    svg.appendChild(el);
    svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
    document.body.appendChild(svg);
    const total = el.getTotalLength();
    const box = el.getBBox();
    const samples: PathSample[] = [];
    const steps = 240;
    for (let i = 0; i <= steps; i++) {
      const at = (i / steps) * total;
      const p = el.getPointAtLength(at);
      const q = el.getPointAtLength(Math.min(total, at + 1));
      samples.push({ x: p.x, y: p.y, tx: q.x - p.x, ty: q.y - p.y, length: total, width: box.width, height: box.height });
    }
    document.body.removeChild(svg);
    if (pathCache.size > 12) pathCache.delete(pathCache.keys().next().value as string);
    pathCache.set(d, samples);
    return samples;
  } catch {
    return [];
  }
}

function sampleAt(samples: PathSample[], distance: number) {
  if (!samples.length) return { x: 0, y: 0, angle: 0 };
  const total = samples[0].length || 1;
  const t = Math.max(0, Math.min(1, distance / total));
  const idx = Math.min(samples.length - 1, Math.round(t * (samples.length - 1)));
  const s = samples[idx];
  return { x: s.x, y: s.y, angle: (Math.atan2(s.ty, s.tx) * 180) / Math.PI };
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number) {
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      const test = line + word;
      if (line && ctx.measureText(test).width > width) {
        result.push(line.trimEnd());
        line = word.trimStart();
      } else line = test;
    }
    result.push(line);
  }
  return result.length ? result : [''];
}

/** Vertical writing: characters stacked in columns. */
function verticalLines(text: string) {
  return text.split('\n').map(l => Array.from(l));
}

function buildSlots(ctx: CanvasRenderingContext2D, layer: TextLayerLike, canvasWidth: number, canvasHeight: number, scale: number, size: number, lineHeight: number): { slots: Slot[]; maxLine: number } {
  const text = layer.text || 'Text';
  const letter = (layer.letterSpacing || 0) * scale;
  const kern = (layer.kerning || 0) * scale;
  const shift = (layer.baselineShift || 0) * scale;
  const maxWidth = (layer.textBoxWidth || (canvasWidth / scale) * 0.88) * scale;
  const slots: Slot[] = [];
  const align = layer.textAlign || 'center';
  let charIndex = 0;
  let wordIndex = 0;

  if (layer.textVertical) {
    const columns = verticalLines(text);
    const colWidth = lineHeight;
    const totalWidth = columns.length * colWidth;
    const tallest = Math.max(...columns.map(c => c.length), 1);
    const startX = align === 'left' ? -canvasWidth * 0.44 + colWidth / 2 : align === 'right' ? canvasWidth * 0.44 - totalWidth + colWidth / 2 : -totalWidth / 2 + colWidth / 2;
    const startY = layer.verticalAlign === 'top' ? -canvasHeight / 2 + size : layer.verticalAlign === 'bottom' ? canvasHeight / 2 - (tallest - 1) * size : -((tallest - 1) * size) / 2;
    columns.forEach((col, ci) => {
      col.forEach((ch, ri) => {
        slots.push({ ch, x: startX + ci * colWidth, y: startY + ri * size + shift, rot: 0, scale: 1, line: ci, word: ci, char: charIndex++ });
      });
    });
    return { slots, maxLine: totalWidth };
  }

  const lines = wrapText(ctx, text, maxWidth);
  const blockHeight = lines.length * lineHeight;
  const baseline = layer.verticalAlign === 'top' ? -canvasHeight / 2 + size : layer.verticalAlign === 'bottom' ? canvasHeight / 2 - blockHeight + size : -blockHeight / 2 + size * 0.85;
  const widest = Math.max(...lines.map(l => ctx.measureText(l).width), 1);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineWidth = ctx.measureText(line).width;
    const left = align === 'center' ? -lineWidth / 2 : align === 'right' ? widest / 2 - lineWidth : -widest / 2;
    const baseY = baseline + li * lineHeight + shift;
    let pen = left;
    let prev = '';
    let prevWidth = 0;
    const lineStart = slots.length;
    for (const segment of line.split(/(\s+)/)) {
      if (!segment) continue;
      const isSpace = /^\s+$/.test(segment);
      for (const ch of Array.from(segment)) {
        const w = ctx.measureText(ch).width;
        const pairKern = prev ? ctx.measureText(prev + ch).width - prevWidth - w : 0;
        slots.push({ ch, x: pen + w / 2 + pairKern / 2, y: baseY, rot: 0, scale: 1, line: li, word: wordIndex, char: charIndex++ });
        pen += w + pairKern + letter + kern;
        prev = ch;
        prevWidth = w;
      }
      if (isSpace) wordIndex++;
    }
    // Curved / circular text for this line.
    const curve = layer.textCurve || 0;
    if (curve !== 0) {
      const lineSlots = slots.slice(lineStart);
      if (lineSlots.length > 1) {
        const total = Math.max(1, pen - left);
        const r = Math.abs(curve) * scale;
        const span = Math.min(Math.PI * 1.7, total / r);
        const dir = curve > 0 ? 1 : -1;
        for (const s of lineSlots) {
          const t = (s.x - left) / total;
          const angle = -span / 2 + t * span;
          s.x = Math.sin(angle) * r;
          s.y = baseY + dir * r * (1 - Math.cos(angle));
          s.rot = ((angle * 180) / Math.PI) * dir;
        }
      }
    }
  }

  // Text along a vector path overrides the straight layout.
  if (layer.textPath) {
    const samples = samplePath(layer.textPath);
    if (samples.length) {
      const xs = samples.map(s => s.x), ys = samples.map(s => s.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
      const k = Math.max(0.12, Math.min(3, Math.min((canvasWidth * 0.92) / bw, (canvasWidth * 0.6) / bh)));
      // Fit the glyph size into the path space so characters do not overwhelm the curve.
      const glyphScale = Math.min(1.6, Math.max(0.25, (canvasWidth * 0.9) / Math.max(1, samples[0].length) / Math.max(1, size / 26)));
      let distance = 0;
      for (const s of slots) {
        const w = ctx.measureText(s.ch).width;
        const at = sampleAt(samples, distance + w / 2);
        s.x = (at.x - minX - bw / 2) * k;
        s.y = (at.y - minY - bh / 2) * k;
        s.rot = at.angle;
        s.scale = glyphScale;
        distance += w + letter + kern;
      }
    }
  }

  // Warp modes.
  const warp = layer.textWarp || 'none';
  const amount = layer.textWarpAmount ?? 30;
  if (warp !== 'none') {
    const half = Math.max(1, widest / 2);
    for (const s of slots) {
      if (warp === 'wave') s.y += Math.sin((s.x / half) * Math.PI) * amount * scale;
      else if (warp === 'bulge') {
        const d = Math.max(0, 1 - Math.abs(s.x) / half);
        s.scale *= 1 + d * (amount / 200);
        s.y -= d * amount * 0.25 * scale;
      } else if (warp === 'arch') {
        const d = Math.abs(s.x) / half;
        s.y += d * d * amount * scale;
        s.rot += (s.x / half) * amount * 0.25;
      }
    }
  }

  for (const s of slots) {
    const o = (layer.wordTransforms || {})[String(s.word)];
    if (o) {
      s.x += (o.x || 0) * scale;
      s.y += (o.y || 0) * scale;
      s.rot += o.rotation || 0;
      s.scale *= o.scale ?? 1;
    }
  }
  for (const s of slots) {
    const o = (layer.charTransforms || {})[String(s.char)];
    if (o) {
      s.x += (o.x || 0) * scale;
      s.y += (o.y || 0) * scale;
      s.rot += o.rotation || 0;
      s.scale *= o.scale ?? 1;
    }
  }
  return { slots, maxLine: widest };
}

/* ------------------------------------------------------------------ */
/* Per-glyph animation                                                 */
/* ------------------------------------------------------------------ */

type GlyphState = { dx: number; dy: number; rot: number; scale: number; alpha: number; hidden: boolean };

function applyGlyphAnim(state: GlyphState, a: TextAnimation, index: number, frame: number, fps: number) {
  const p = progressFor(a, frame, fps, index);
  const n = a.type;
  const amount = 1 - p;
  if (a.category === 'Loop') {
    const t = (frame / fps) * Math.max(0.01, a.frequency) * Math.PI * 2 + index * Math.max(0, a.stagger) * 0.2;
    if (n === 'wave' || n === 'floating' || n === 'character-oscillation' || n === 'word-oscillation') state.dy += Math.sin(t) * a.amplitude;
    else if (n === 'swing' || n === 'wiggle') state.rot += Math.sin(t) * a.rotation;
    else if (n === 'pulse' || n === 'breathing') state.scale *= 1 + Math.sin(t) * 0.09 * a.intensity;
    else if (n === 'bounce') state.dy -= Math.abs(Math.sin(t)) * a.amplitude;
    else if (n === 'rotation') state.rot += (t * 180) / Math.PI;
    else if (n === 'tracking-loop') state.dx += Math.sin(t) * a.stagger;
    else if (n === '3d-orbit') state.dx += Math.sin(t) * a.amplitude;
    else if (n === 'glitch-loop') { state.dx += Math.sin(t * 3.1 + index) * Math.max(2, a.amplitude) * 0.22; state.alpha *= 0.75 + 0.25 * Math.abs(Math.sin(t * 1.7)); }
    return;
  }
  if ((n.includes('typewriter') || n === 'character-disappear' || n === 'mask-reveal' || n === 'mask-disappear' || n === 'character-cascade' || n === 'word-cascade' || n === 'line-cascade') && a.category === 'In' && p <= 0) state.hidden = true;
  if (n.includes('fade')) state.alpha *= p;
  else if (n.includes('slide') || n.includes('mask')) {
    state.dy += amount * a.amplitude;
    state.alpha *= Math.max(0, Math.min(1, p * 1.6));
  } else if (n.includes('zoom') || n === 'shrink') {
    state.scale *= Math.max(0.01, a.scale + (1 - a.scale) * p);
    state.alpha *= Math.max(0, Math.min(1, p * 1.4));
  } else if (n.includes('spin') || n.includes('rotate')) {
    state.rot += amount * a.rotation;
    state.alpha *= Math.max(0, Math.min(1, p * 1.4));
  } else if (n.includes('flip')) {
    state.rot += amount * a.rotation;
    state.scale *= Math.max(0.02, Math.abs(Math.cos((1 - p) * Math.PI * 0.5)));
  } else if (n.includes('bounce')) {
    state.dy += amount * a.amplitude - Math.sin(p * Math.PI) * a.amplitude * 0.25;
    state.alpha *= p > 0 ? 1 : 0;
  } else if (n.includes('elastic')) {
    state.scale *= Math.max(0.02, 1 + amount * Math.sin(amount * Math.PI * 5) * 0.35);
    state.alpha *= Math.max(0, Math.min(1, p * 1.5));
  } else if (n.includes('blur')) {
    state.dy += amount * a.amplitude * 0.2;
    state.alpha *= Math.max(0, Math.min(1, p * 1.4));
  } else if (n.includes('glitch')) {
    const jitter = (1 - Math.abs(0.5 - p) * 2) * Math.max(2, a.amplitude) * 0.4;
    state.dx += (Math.sin(index * 7.3 + frame * 1.7 + (a.seed || 1)) * jitter);
    state.dy += (Math.cos(index * 3.1 + frame * 2.3 + (a.seed || 1)) * jitter * 0.4);
    state.alpha *= Math.max(0, Math.min(1, p * 1.5));
  } else if (n.includes('stretch') || n.includes('swish')) {
    state.dx += amount * a.amplitude * 0.5;
    state.scale *= 1 + amount * Math.max(0.1, a.intensity);
    state.alpha *= Math.max(0, Math.min(1, p * 1.3));
  } else if (n.includes('tracking')) {
    state.dx += amount * Math.max(1, a.stagger) * (index + 1) * 0.6;
    state.alpha *= Math.max(0, Math.min(1, p * 1.3));
  } else if (n.includes('typewriter')) {
    state.alpha *= p > 0 ? 1 : 0;
  } else if (n.includes('perspective') || n.includes('3d-rotation')) {
    state.rot += amount * a.rotation * 0.35;
    state.scale *= Math.max(0.04, Math.abs(Math.cos(amount * Math.PI * 0.5)));
    state.dy += amount * a.amplitude * 0.3;
    state.alpha *= Math.max(0, Math.min(1, p * 1.4));
  } else if (n.includes('cascade')) {
    state.dy += amount * a.amplitude;
    state.alpha *= Math.max(0, Math.min(1, p * 1.4));
  } else if (n === 'text-scramble') {
    state.alpha *= p > 0 ? 1 : 0;
    state.dx += (1 - p) * Math.sin(index * 5.1 + frame + (a.seed || 1)) * 12;
  }
}

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

export function renderText(ctx: CanvasRenderingContext2D, layer: TextLayerLike, width: number, height: number, projectWidth: number, projectHeight: number, frame: number, fps: number) {
  const projectScale = width / projectWidth;
  const animState = evaluateText(layer, 0, 0, 1, 0, 1, frame, fps);
  const blur = animState.blur;
  ctx.filter = blur > 0 ? `blur(${blur.toFixed(2)}px)` : 'none';
  const scale = projectScale;
  const size = (layer.fontSize || projectWidth * 0.055) * scale;
  const weight = layer.fontWeight || 700;
  const family = layer.fontFamily || 'sans-serif';
  const italic = layer.fontItalic ? 'italic ' : '';
  ctx.font = `${italic}${weight} ${size}px "${family}",sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const lineHeight = size * (layer.lineSpacing || 1.2);

  const { slots, maxLine } = buildSlots(ctx, layer, width, height, scale, size, lineHeight);
  if (!slots.length) { ctx.filter = 'none'; return; }
  const pad = (layer.textPadding || 0) * scale;

  if (layer.textPerspective) {
    const p = Math.max(0, Math.min(1, layer.textPerspective / 100));
    ctx.transform(1, 0, p * 0.35, 1, 0, 0);
    ctx.transform(1, p * 0.08, 0, 1, 0, 0);
  }

  // Fill / gradients.
  let fill: CanvasGradient | string = layer.color;
  const colorCycle = (layer.textAnimations || []).find(a => a.enabled && a.type === 'color-cycling');
  if (colorCycle) fill = `hsl(${((frame / fps) * Math.max(0.05, colorCycle.frequency) * 90) % 360} 95% 62%)`;
  const gradMove = (layer.textAnimations || []).find(a => a.enabled && a.type === 'gradient-movement');
  if (layer.textFillMode === 'linear' || layer.textFillMode === 'radial') {
    const spin = gradMove ? ((frame / fps) * Math.max(0.05, gradMove.frequency) * 360) % 360 : 0;
    const angle = ((layer.gradientAngle ?? 0) + spin) * Math.PI / 180;
    const half = Math.max(1, maxLine / 2);
    const gr = layer.textFillMode === 'linear'
      ? ctx.createLinearGradient(-Math.cos(angle) * half, -Math.sin(angle) * half, Math.cos(angle) * half, Math.sin(angle) * half)
      : ctx.createRadialGradient(0, 0, 0, 0, 0, half);
    const shift = colorCycle ? ((frame / fps) * colorCycle.frequency) % 1 : 0;
    gr.addColorStop(0, layer.gradientStart || layer.color);
    if (layer.gradientMid) gr.addColorStop(Math.max(0.05, Math.min(0.95, 0.5 + shift * 0.2)), layer.gradientMid);
    gr.addColorStop(1, layer.gradientEnd || '#ffffff');
    fill = gr;
  }

  // Background box.
  if (layer.textBackground && layer.textBackground !== 'transparent') {
    const ys = slots.map(s => s.y);
    const top = Math.min(...ys) - size * 0.9;
    const bottom = Math.max(...ys) + size * 0.35;
    const left = Math.min(...slots.map(s => s.x)) - maxLine * 0 - pad;
    const boxX = (left === -pad ? -maxLine / 2 - pad : left);
    ctx.fillStyle = layer.textBackground;
    ctx.beginPath();
    ctx.roundRect(boxX, top - pad, maxLine + pad * 2, bottom - top + pad * 2, Math.max(0, (layer.textRadius || 0) * scale));
    ctx.fill();
  }

  // Shadow / glow.
  if (layer.textShadow || layer.textGlow) {
    ctx.shadowColor = layer.textShadowColor || (layer.textGlow ? layer.color : '#000000');
    ctx.shadowBlur = layer.textGlow ? Math.max(4, layer.textGlow) * scale : 12 * scale;
    ctx.shadowOffsetX = layer.textShadow ? 2 * scale : 0;
    ctx.shadowOffsetY = layer.textShadow ? 3 * scale : 0;
  } else {
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  if (layer.textBlendMode && layer.textBlendMode !== 'source-over') ctx.globalCompositeOperation = layer.textBlendMode as GlobalCompositeOperation;

  const animations = (layer.textAnimations || []).filter(a => a.enabled);
  const byScope = (scope: TextAnimation['scope']) => animations.filter(a => a.scope === scope);
  const charAnims = byScope('character'), wordAnims = byScope('word'), lineAnims = byScope('line');

  for (const slot of slots) {
    if (slot.ch === '\n') continue;
    let x = slot.x;
    let y = slot.y;
    let rot = slot.rot;
    let scl = slot.scale;
    let alpha = 1;
    let hidden = false;

    const state: GlyphState = { dx: 0, dy: 0, rot: 0, scale: 1, alpha: 1, hidden: false };
    for (const a of charAnims) applyGlyphAnim(state, a, slot.char, frame, fps);
    for (const a of wordAnims) applyGlyphAnim(state, a, slot.word, frame, fps);
    for (const a of lineAnims) applyGlyphAnim(state, a, slot.line, frame, fps);
    if (state.hidden) continue;
    x += state.dx;
    y += state.dy;
    rot += state.rot;
    scl *= state.scale;
    alpha *= state.alpha;
    if (alpha <= 0.002) continue;

    // Locomotion from whole-text animations (slide / zoom handled per-layer).
    ctx.save();
    ctx.globalAlpha *= Math.max(0, Math.min(1, alpha));
    ctx.translate(x, y);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    if (scl !== 1) ctx.scale(scl, scl);
    const charStyle = (layer.charTransforms || {})[String(slot.char)] || (layer.wordTransforms || {})[String(slot.word)];
    if (charStyle?.size) ctx.scale(charStyle.size, charStyle.size);
    ctx.fillStyle = charStyle?.color || fill;
    if (layer.strokeTextWidth) {
      ctx.strokeStyle = layer.strokeText || '#000000';
      ctx.lineWidth = (layer.strokeTextWidth || 0) * scale;
      ctx.strokeText(slot.ch, 0, 0);
    }
    ctx.fillText(slot.ch, 0, 0);
    if (layer.textInnerShadow) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.filter = `blur(${Math.max(0.5, layer.textInnerShadow * 0.5).toFixed(2)}px)`;
      ctx.globalAlpha *= 0.72;
      ctx.fillStyle = '#000000';
      ctx.fillText(slot.ch, -size * 0.015, size * 0.055);
      ctx.restore();
    }
    ctx.restore();

    if ((layer.underline || layer.strikethrough) && !layer.textCurve && !layer.textPath) {
      const w = ctx.measureText(slot.ch).width;
      ctx.save();
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = Math.max(1, size * 0.05);
      ctx.beginPath();
      if (layer.underline) { ctx.moveTo(x - w / 2, y + size * 0.11); ctx.lineTo(x + w / 2, y + size * 0.11); }
      if (layer.strikethrough) { ctx.moveTo(x - w / 2, y - size * 0.28); ctx.lineTo(x + w / 2, y - size * 0.28); }
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
}
