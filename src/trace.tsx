/* Flint Studio — Phase 6 "Flint Trace" workspace.
 * Real analysis only: frames are seeked and read from the actual footage, the
 * tracker is NCC template matching with corner-based feature placement, roto
 * propagation uses per-frame similarity transforms, removal uses exemplar
 * patch inpainting and segmentation is a colour-model classifier refined with
 * brushes. Nothing here fabricates a motion path.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Play, Pause, Square, RotateCcw, Crosshair, Wand2, Scissors, Eraser, Activity, Sparkles, Trash2, Pin } from 'lucide-react';
import {
  grayFromCanvas, trackPointsRobust, detectCorners, solveSimilarity, inpaintPatches,
  buildColorModel, segmentByColorModel, strokeMask, featherMaskAlpha, smoothCurve,
  type Gray, type Corner,
} from './cv';

type AnyLayer = {
  id: string;
  kind: string;
  name: string;
  src?: string;
  start: number;
  duration: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  masks?: any[];
  track?: TrackData;
  trackAttach?: TrackAttach;
  stabilize?: StabilizeData;
  [k: string]: any;
};

export type TrackSample = { nx: number; ny: number; confidence: number; recovered?: boolean };
export type TrackFrame = { frame: number; points: TrackSample[] };
export type TrackData = {
  start: number;
  end: number;
  mode: 'position' | 'rotation' | 'scale' | 'planar';
  quality: 'fast' | 'balanced' | 'high';
  frames: TrackFrame[];
  frozen?: boolean;
};
export type TrackAttach = {
  enabled: boolean;
  pointIndex: number;
  offsetX: number;
  offsetY: number;
  useRotation: boolean;
  useScale: boolean;
};
export type StabilizeData = {
  strength: number;
  crop: number;
  smooth: number;
  frames: { frame: number; dx: number; dy: number; rotation: number; scale: number }[];
  enabled: boolean;
};

type Props = {
  layer: AnyLayer;
  project: { width: number; height: number; fps: number; duration: number };
  playhead: number;
  onClose: () => void;
  onLayer: (patch: Record<string, unknown>) => void;
  onAddLayer: (kind: string, details: Record<string, unknown>) => void;
  onNotice: (msg: string) => void;
  onSeek: (frame: number) => void;
  onSelectMask: (id: string) => void;
  mediaFor: (layer: AnyLayer, kind: 'image' | 'video') => HTMLImageElement | HTMLVideoElement | undefined;
};

const QUALITY_WIDTH = { fast: 320, balanced: 480, high: 640 } as const;
const QUALITY_STEP = { fast: 2, balanced: 1, high: 1 } as const;

export default function TracePanel({ layer, project, playhead, onClose, onLayer, onAddLayer, onNotice, onSeek, onSelectMask, mediaFor }: Props) {
  const previewRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [quality, setQuality] = useState<'fast' | 'balanced' | 'high'>('balanced');
  const [mode, setMode] = useState<'position' | 'rotation' | 'scale' | 'planar'>('position');
  const [tracking, setTracking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [tool, setTool] = useState<'select' | 'remove' | 'segment' | 'mask'>('select');
  const [compare, setCompare] = useState(false);
  const [showMask, setShowMask] = useState(true);
  const [brush, setBrush] = useState(24);
  const [segMode, setSegMode] = useState<'balanced' | 'fast' | 'high'>('balanced');
  const cancelRef = useRef(false);
  const strokesRef = useRef<{ x: number; y: number; erase: boolean }[]>([]);
  const brushLayerRef = useRef<HTMLCanvasElement | null>(null);
  const [brushDirty, setBrushDirty] = useState(0);

  const isImage = layer.kind === 'image';
  const media = useMemo(() => mediaFor(layer, isImage ? 'image' : 'video'), [layer, layer.src, isImage]);

  const sourceSize = useMemo(() => {
    if (media instanceof HTMLVideoElement && media.videoWidth) return { w: media.videoWidth, h: media.videoHeight };
    if (media instanceof HTMLImageElement && media.naturalWidth) return { w: media.naturalWidth, h: media.naturalHeight };
    return { w: project.width, h: project.height };
  }, [media, (media as HTMLVideoElement | undefined)?.readyState]);

  /* ---------------------------------------------------------------- */
  /* Frame access                                                      */
  /* ---------------------------------------------------------------- */

  const drawFrame = useCallback((target: HTMLCanvasElement, src: HTMLVideoElement | HTMLImageElement) => {
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.drawImage(src, 0, 0, target.width, target.height);
  }, []);

  const paintPreview = useCallback(() => {
    const c = previewRef.current;
    if (!c || !media) return;
    const w = QUALITY_WIDTH[quality];
    const h = Math.max(16, Math.round(w * (sourceSize.h / Math.max(1, sourceSize.w))));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (media instanceof HTMLVideoElement) {
      if (media.readyState >= 2) drawFrame(c, media);
    } else if (media.complete) drawFrame(c, media);
  }, [media, quality, sourceSize.h, sourceSize.w, drawFrame]);

  // seek the hidden video to the playhead so preview + analysis agree
  useEffect(() => {
    if (!(media instanceof HTMLVideoElement)) return;
    const t = Math.max(0, (playhead - layer.start) / project.fps);
    if (Math.abs(media.currentTime - t) > 0.02) {
      try { media.currentTime = t; } catch { /* seeking can fail before metadata */ }
    }
  }, [media, playhead, layer.start, project.fps]);

  useEffect(() => {
    paintPreview();
    const v = media instanceof HTMLVideoElement ? media : null;
    if (!v) return;
    const onSeeked = () => paintPreview();
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('loadeddata', onSeeked);
    return () => { v.removeEventListener('seeked', onSeeked); v.removeEventListener('loadeddata', onSeeked); };
  }, [paintPreview, media, quality]);

  /* ---------------------------------------------------------------- */
  /* Overlay: tracking points, masks, brush strokes                    */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const c = overlayRef.current, p = previewRef.current;
    if (!c || !p) return;
    if (c.width !== p.width || c.height !== p.height) { c.width = p.width; c.height = p.height; }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const t = layer.track;
    if (t) {
      const sample = t.frames.find(f => f.frame === playhead);
      const first = t.frames[0];
      if (sample) {
        sample.points.forEach((pt, i) => {
          const x = pt.nx * c.width, y = pt.ny * c.height;
          const base = first?.points[i];
          const bx = (base?.nx ?? pt.nx) * c.width, by = (base?.ny ?? pt.ny) * c.height;
          ctx.strokeStyle = 'rgba(255,255,255,.25)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(x, y); ctx.stroke();
          const conf = pt.confidence;
          ctx.fillStyle = `rgba(${Math.round(255 * (1 - conf))},${Math.round(200 + 55 * conf)},${Math.round(120 + 135 * conf)},1)`;
          ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.stroke();
          ctx.fillStyle = '#eaeaea'; ctx.font = '9px sans-serif';
          ctx.fillText(`${i + 1} ${(conf * 100) | 0}%`, x + 7, y - 6);
        });
      }
    }
    if (showMask && layer.masks?.length) {
      const m = layer.masks[0];
      if (m?.points?.length) {
        const sx = c.width / project.width, sy = c.height / project.height;
        ctx.strokeStyle = '#f0f0f0';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        m.points.forEach((pt: any, i: number) => {
          const x = pt.x * sx, y = pt.y * sy;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        if (m.closed) ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        m.points.forEach((pt: any) => {
          ctx.fillStyle = '#111'; ctx.strokeStyle = '#f5f5f5';
          ctx.beginPath(); ctx.rect(pt.x * sx - 3, pt.y * sy - 3, 6, 6); ctx.fill(); ctx.stroke();
        });
      }
    }
    const brushCanvas = brushLayerRef.current;
    if (brushCanvas) ctx.drawImage(brushCanvas, 0, 0, c.width, c.height);
  }, [layer, playhead, showMask, project.width, project.height, brushDirty, compare]);

  /* ---------------------------------------------------------------- */
  /* Tracking                                                          */
  /* ---------------------------------------------------------------- */

  const grabGray = useCallback(async (video: HTMLVideoElement, timeSec: number, width: number): Promise<Gray> => {
    const target = Math.max(0, timeSec);
    if (Math.abs(video.currentTime - target) > 0.001) {
      await new Promise<void>(resolve => {
        const done = () => { video.removeEventListener('seeked', done); resolve(); };
        video.addEventListener('seeked', done);
        try { video.currentTime = target; } catch { done(); }
        window.setTimeout(done, 1500);
      });
    }
    const c = document.createElement('canvas');
    const w = width;
    const h = Math.max(8, Math.round(width * (video.videoHeight / Math.max(1, video.videoWidth))));
    c.width = w; c.height = h;
    c.getContext('2d')?.drawImage(video, 0, 0, w, h);
    return grayFromCanvas(c, width);
  }, []);

  const ensurePoints = useCallback((): TrackSample[] => {
    const existing = layer.track?.frames.find(f => f.frame === playhead)?.points;
    if (existing?.length) return existing;
    const mediaEl = media;
    if (!mediaEl) return [];
    const c = document.createElement('canvas');
    const w = QUALITY_WIDTH[quality];
    const h = Math.max(8, Math.round(w * (sourceSize.h / Math.max(1, sourceSize.w))));
    c.width = w; c.height = h;
    if (mediaEl instanceof HTMLVideoElement && mediaEl.readyState < 2) return [];
    c.getContext('2d')?.drawImage(mediaEl, 0, 0, w, h);
    const gray = grayFromCanvas(c, w);
    const count = mode === 'planar' ? 4 : mode === 'position' ? 1 : 2;
    const corners: Corner[] = detectCorners(gray, { count, minDistance: Math.min(w, h) / 3 });
    if (!corners.length) return [];
    return corners.map(cn => ({ nx: cn.x / w, ny: cn.y / h, confidence: 1 }));
  }, [layer.track, playhead, media, quality, mode, sourceSize.h, sourceSize.w]);

  const runTracking = useCallback(async (direction: 1 | -1) => {
    if (tracking) return;
    const mediaEl = media;
    if (!mediaEl) { onNotice('This layer has no analysable source'); return; }
    if (layer.kind !== 'video' && layer.kind !== 'image') { onNotice('Tracking needs a video or image layer'); return; }
    if (mediaEl instanceof HTMLVideoElement && mediaEl.readyState < 2) { onNotice('Footage is still loading'); return; }
    cancelRef.current = false;
    setTracking(true);
    setProgress(0);
    try {
      const width = QUALITY_WIDTH[quality];
      const step = QUALITY_STEP[quality];
      const firstFrame = Math.max(0, layer.start);
      const lastFrame = Math.min(layer.start + layer.duration - 1, Math.round(project.duration * project.fps) - 1);
      const seed = ensurePoints();
      if (!seed.length) { onNotice('No trackable feature found in this frame'); return; }
      let points = seed.map(p => ({ x: p.nx * width, y: p.ny * (width * sourceSize.h / Math.max(1, sourceSize.w)) }));
      const frames: TrackFrame[] = [];
      const frameTime = (f: number) => (f - layer.start) / project.fps;
      let prevGray: Gray;
      if (mediaEl instanceof HTMLVideoElement) {
        prevGray = await grabGray(mediaEl, frameTime(playhead), width);
      } else {
        prevGray = grayFromCanvas(mediaEl as unknown as HTMLCanvasElement, width);
      }
      const targets: number[] = [];
      if (direction === 1) for (let f = playhead; f <= lastFrame; f += step) targets.push(f);
      else for (let f = playhead; f >= firstFrame; f -= step) targets.push(f);
      frames.push({ frame: playhead, points: seed.map(p => ({ ...p })) });
      for (let i = 1; i < targets.length; i++) {
        if (cancelRef.current) break;
        const f = targets[i];
        let gray: Gray;
        if (mediaEl instanceof HTMLVideoElement) gray = await grabGray(mediaEl, frameTime(f), width);
        else gray = prevGray;
        if (mediaEl instanceof HTMLVideoElement && gray.data.every(v => v === 0)) {
          // seek failed / frame unavailable — stop instead of inventing motion
          onNotice('Frame data unavailable; tracking stopped');
          break;
        }
        const tracked = trackPointsRobust(prevGray, gray, points, 8, quality === 'high' ? 20 : 16);
        points = tracked.map(t => ({ x: t.x, y: t.y }));
        const h = gray.h;
        frames.push({
          frame: f,
          points: tracked.map(t => ({
            nx: t.x / width, ny: t.y / h, confidence: t.confidence, recovered: t.recovered,
          })),
        });
        prevGray = gray;
        setProgress(i / Math.max(1, targets.length - 1));
        if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
      }
      frames.sort((a, b) => a.frame - b.frame);
      const merged = new Map<number, TrackFrame>();
      for (const f of layer.track?.frames || []) merged.set(f.frame, f);
      for (const f of frames) merged.set(f.frame, f);
      const all = [...merged.values()].sort((a, b) => a.frame - b.frame);
      const data: TrackData = {
        start: Math.min(all[0]?.frame ?? playhead, playhead),
        end: Math.max(all[all.length - 1]?.frame ?? playhead, playhead),
        mode, quality, frames: all,
      };
      onLayer({ track: data });
      onNotice(`Tracked ${frames.length} frames · mean confidence ${(frames.reduce((s, fr) => s + fr.points.reduce((a, p) => a + p.confidence, 0) / Math.max(1, fr.points.length), 0) / Math.max(1, frames.length) * 100).toFixed(0)}%`);
    } catch (err) {
      onNotice(`Tracking failed: ${(err as Error).message}`);
    } finally {
      setTracking(false);
      setProgress(0);
    }
  }, [tracking, media, layer, quality, mode, ensurePoints, sourceSize.h, sourceSize.w, project.fps, project.duration, playhead, grabGray, onLayer, onNotice]);

  /* ---------------------------------------------------------------- */
  /* Mask propagation (rotoscoping)                                    */
  /* ---------------------------------------------------------------- */

  const propagateMask = useCallback(async (direction: 1 | -1) => {
    const m = layer.masks?.[0];
    if (!m) { onNotice('Add a mask in the inspector first'); return; }
    const track = layer.track;
    if (!track || track.frames.length < 2) { onNotice('Track the footage before propagating a mask'); return; }
    const ordered = [...track.frames].sort((a, b) => a.frame - b.frame);
    const startIdx = ordered.findIndex(f => f.frame === playhead);
    if (startIdx < 0) { onNotice('No tracking data at this frame'); return; }
    const keys = [...(m.keys || [])];
    let pts = (m.keys.find((k: any) => k.frame === playhead)?.points || m.points).map((p: any) => ({ ...p }));
    let idx = startIdx;
    while (idx + direction >= 0 && idx + direction < ordered.length) {
      const a = ordered[idx], b = ordered[idx + direction];
      // work in project pixels so rotation is not distorted by aspect ratio
      const sx = project.width, sy = project.height;
      const from = a.points.map(p => ({ x: p.nx * sx, y: p.ny * sy }));
      const to = b.points.map(p => ({ x: p.nx * sx, y: p.ny * sy }));
      const sim = solveSimilarity(from, to);
      const cfx = from.reduce((s, p) => s + p.x, 0) / Math.max(1, from.length);
      const cfy = from.reduce((s, p) => s + p.y, 0) / Math.max(1, from.length);
      const ctx2 = to.reduce((s, p) => s + p.x, 0) / Math.max(1, to.length);
      const cty = to.reduce((s, p) => s + p.y, 0) / Math.max(1, to.length);
      const cos = Math.cos(sim.rotation), sin = Math.sin(sim.rotation);
      pts = pts.map((p: any) => {
        const ax = (p.x - cfx) * sim.scale;
        const ay = (p.y - cfy) * sim.scale;
        return { ...p, x: ax * cos - ay * sin + ctx2, y: ax * sin + ay * cos + cty };
      });
      const existing = keys.findIndex((k: any) => k.frame === b.frame);
      const key = { frame: b.frame, points: pts.map((p: any) => ({ ...p })), closed: m.closed };
      if (existing >= 0) keys[existing] = key; else keys.push(key);
      idx += direction;
    }
    keys.sort((a: any, b: any) => a.frame - b.frame);
    onLayer({ masks: (layer.masks || []).map(x => (x.id === m.id ? { ...x, keys } : x)) });
    onNotice(`Mask propagated ${direction > 0 ? 'forward' : 'backward'} across ${Math.abs(idx - startIdx)} frames`);
  }, [layer, playhead, project.width, project.height, onLayer, onNotice]);

  /* ---------------------------------------------------------------- */
  /* Object removal                                                    */
  /* ---------------------------------------------------------------- */

  const runInpaint = useCallback(async () => {
    const brushCanvas = brushLayerRef.current;
    const preview = previewRef.current;
    if (!brushCanvas || !preview) { onNotice('Nothing selected'); return; }
    const mask = document.createElement('canvas');
    mask.width = preview.width; mask.height = preview.height;
    mask.getContext('2d')?.drawImage(brushCanvas, 0, 0, mask.width, mask.height);
    const data = mask.getContext('2d')?.getImageData(0, 0, mask.width, mask.height).data;
    if (!data || !data.some((v, i) => i % 4 === 3 && v > 10)) { onNotice('Brush over the object you want to remove'); return; }
    const work = document.createElement('canvas');
    work.width = preview.width; work.height = preview.height;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    if (!wctx) return;
    wctx.drawImage(preview, 0, 0);
    setProgress(0);
    const filled = inpaintPatches(work, mask, { radius: 48, patch: 7, onProgress: p => setProgress(p) });
    setProgress(0);
    const layerC = document.createElement('canvas');
    layerC.width = project.width; layerC.height = project.height;
    layerC.getContext('2d')?.drawImage(work, 0, 0, layerC.width, layerC.height);
    onAddLayer('image', {
      name: 'Removal patch', src: layerC.toDataURL('image/png'),
      start: playhead, duration: Math.max(1, layer.duration - (playhead - layer.start)),
      x: project.width / 2, y: project.height / 2,
    });
    brushLayerRef.current = null;
    setBrushDirty(d => d + 1);
    onNotice(`Object removed · ${filled} pixels rebuilt from surrounding patches`);
  }, [playhead, project.width, project.height, layer.duration, layer.start, onAddLayer, onNotice]);

  /* ---------------------------------------------------------------- */
  /* Segmentation                                                      */
  /* ---------------------------------------------------------------- */

  const fgStrokes = useRef<{ x: number; y: number }[]>([]);
  const bgStrokes = useRef<{ x: number; y: number }[]>([]);

  const runSegmentation = useCallback(async () => {
    const preview = previewRef.current;
    if (!preview || !media) return;
    if (!fgStrokes.current.length) { onNotice('Mark the subject with the foreground brush first'); return; }
    const w = segMode === 'fast' ? 240 : segMode === 'balanced' ? 400 : 640;
    const h = Math.round(w * preview.height / Math.max(1, preview.width));
    const small = document.createElement('canvas');
    small.width = w; small.height = h;
    const sctx = small.getContext('2d', { willReadFrequently: true });
    if (!sctx) return;
    sctx.drawImage(preview, 0, 0, w, h);
    const img = sctx.getImageData(0, 0, w, h);
    const sampleAt = (pts: { x: number; y: number }[]) => pts.flatMap(p => {
      const cx = Math.round(p.x * w), cy = Math.round(p.y * h);
      const out: { r: number; g: number; b: number }[] = [];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = Math.max(0, Math.min(w - 1, cx + dx)), y = Math.max(0, Math.min(h - 1, cy + dy));
        const i = (y * w + x) * 4;
        out.push({ r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] });
      }
      return out;
    });
    const model = buildColorModel(img, sampleAt(fgStrokes.current), sampleAt(bgStrokes.current.length ? bgStrokes.current : [{ x: 0.02, y: 0.02 }, { x: 0.98, y: 0.98 }]));
    const alpha = segmentByColorModel(img, model, segMode === 'high' ? 3 : 2, 0.5);
    const out = document.createElement('canvas');
    out.width = project.width; out.height = project.height;
    const octx = out.getContext('2d');
    if (!octx) return;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d');
    if (!tctx) return;
    const id = tctx.createImageData(w, h);
    id.data.set(alpha);
    // make it a white alpha matte
    for (let i = 0; i < id.data.length; i += 4) { id.data[i] = 255; id.data[i + 1] = 255; id.data[i + 2] = 255; }
    tctx.putImageData(id, 0, 0);
    featherMaskAlpha(tctx, w, h, 1);
    octx.drawImage(tmp, 0, 0, out.width, out.height);
    onAddLayer('image', {
      name: `${layer.name} matte`, src: out.toDataURL('image/png'),
      start: layer.start, duration: layer.duration,
      x: project.width / 2, y: project.height / 2,
    });
    onNotice('Subject matte generated from colour model — set it as a luminance/alpha matte in the inspector');
  }, [media, segMode, project.width, project.height, layer.name, layer.start, layer.duration, onAddLayer, onNotice]);

  /* ---------------------------------------------------------------- */
  /* Stabilisation                                                     */
  /* ---------------------------------------------------------------- */

  const analyzeStabilization = useCallback(async () => {
    const mediaEl = media;
    if (!(mediaEl instanceof HTMLVideoElement)) { onNotice('Stabilisation needs video footage'); return; }
    if (mediaEl.readyState < 2) { onNotice('Footage is still loading'); return; }
    cancelRef.current = false;
    setTracking(true);
    setProgress(0);
    try {
      const width = QUALITY_WIDTH[quality];
      const step = QUALITY_STEP[quality];
      const samples: { frame: number; dx: number; dy: number; rotation: number; scale: number }[] = [];
      const seed = ensurePoints().length ? ensurePoints() : [];
      let points = seed.map(p => ({ x: p.nx * width, y: p.ny * width * sourceSize.h / Math.max(1, sourceSize.w) }));
      if (points.length < 2) { onNotice('Two trackable features are needed for stabilisation'); return; }
      let prevGray = await grabGray(mediaEl, (playhead - layer.start) / project.fps, width);
      let cx = 0, cy = 0, rotAcc = 0, scaleAcc = 1;
      samples.push({ frame: playhead, dx: 0, dy: 0, rotation: 0, scale: 1 });
      const targets: number[] = [];
      for (let f = playhead + step; f < layer.start + layer.duration; f += step) targets.push(f);
      for (let i = 0; i < targets.length; i++) {
        if (cancelRef.current) break;
        const f = targets[i];
        const gray = await grabGray(mediaEl, (f - layer.start) / project.fps, width);
        const tracked = trackPointsRobust(prevGray, gray, points, 8, 18);
        const sim = solveSimilarity(points, tracked.map(t => ({ x: t.x, y: t.y })));
        cx += sim.dx; cy += sim.dy; rotAcc += sim.rotation; scaleAcc *= sim.scale;
        samples.push({ frame: f, dx: cx, dy: cy, rotation: rotAcc, scale: scaleAcc });
        points = tracked.map(t => ({ x: t.x, y: t.y }));
        prevGray = gray;
        setProgress(i / Math.max(1, targets.length - 1));
      }
      const smooth = smoothCurve(samples.map(s => s.dx), 6);
      const smoothY = smoothCurve(samples.map(s => s.dy), 6);
      const smoothR = smoothCurve(samples.map(s => s.rotation), 6);
      const smoothS = smoothCurve(samples.map(s => s.scale), 6);
      const frames = samples.map((s, i) => ({
        frame: s.frame,
        dx: s.dx - smooth[i],
        dy: s.dy - smoothY[i],
        rotation: s.rotation - smoothR[i],
        scale: smoothS[i] / Math.max(1e-6, s.scale),
      }));
      const data: StabilizeData = { strength: 1, crop: 6, smooth: 6, frames, enabled: true };
      onLayer({ stabilize: data });
      onNotice(`Motion analysed across ${frames.length} frames — stabilisation applied non-destructively`);
    } catch (err) {
      onNotice(`Stabilisation failed: ${(err as Error).message}`);
    } finally {
      setTracking(false);
      setProgress(0);
    }
  }, [media, quality, ensurePoints, grabGray, playhead, layer.start, layer.duration, sourceSize.h, sourceSize.w, onLayer, onNotice]);

  /* ---------------------------------------------------------------- */
  /* Brush painting on the overlay                                     */
  /* ---------------------------------------------------------------- */

  const toNorm = (e: React.PointerEvent) => {
    const c = overlayRef.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) / Math.max(1, r.width), y: (e.clientY - r.top) / Math.max(1, r.height) };
  };

  const startPaint = (e: React.PointerEvent, erase: boolean) => {
    const preview = previewRef.current;
    if (!preview) return;
    let canvas = brushLayerRef.current;
    if (!canvas) { canvas = document.createElement('canvas'); }
    if (canvas.width !== preview.width || canvas.height !== preview.height) {
      const old = canvas;
      canvas = document.createElement('canvas');
      canvas.width = preview.width; canvas.height = preview.height;
      canvas.getContext('2d')?.drawImage(old, 0, 0);
      brushLayerRef.current = canvas;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const paint = (pt: { x: number; y: number }) => {
      const r = brush * (canvas!.width / Math.max(1, preview.width)) * 0.5;
      strokeMask(ctx, pt.x * canvas!.width, pt.y * canvas!.height, Math.max(2, r), erase || tool === 'segment' ? erase : false);
      if (tool === 'segment') {
        const store = erase ? bgStrokes : fgStrokes;
        store.current.push(pt);
      }
      setBrushDirty(d => d + 1);
    };
    paint(toNorm(e));
    const move = (ev: PointerEvent) => {
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) return;
      paint({ x: (ev.clientX - rect.left) / Math.max(1, rect.width), y: (ev.clientY - rect.top) / Math.max(1, rect.height) });
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  };

  /* ---------------------------------------------------------------- */
  /* Bake tracking into keyframes                                      */
  /* ---------------------------------------------------------------- */

  const bakeTracking = useCallback(() => {
    const track = layer.track;
    if (!track?.frames.length) { onNotice('No tracking data to bake'); return; }
    const base = track.frames[0].points;
    const baseX = base[0]?.nx ?? 0.5, baseY = base[0]?.ny ?? 0.5;
    const dispW = project.width, dispH = project.height;
    const keys = track.frames.map(fr => {
      const p = fr.points[0] || base[0];
      const dx = (p.nx - baseX) * dispW;
      const dy = (p.ny - baseY) * dispH;
      let rotation = layer.rotation;
      let scale = layer.scale;
      if (fr.points.length > 1) {
        const sim = solveSimilarity(base.map(b => ({ x: b.nx, y: b.ny })), fr.points.map(q => ({ x: q.nx, y: q.ny })));
        if (mode === 'rotation' || mode === 'planar') rotation = layer.rotation + (sim.rotation * 180) / Math.PI;
        if (mode === 'scale' || mode === 'planar') scale = layer.scale * sim.scale;
      }
      return {
        frame: fr.frame, x: layer.x + dx, y: layer.y + dy, z: layer.z || 0,
        scale, rotation, rotationX: layer.rotationX || 0, rotationY: layer.rotationY || 0, opacity: layer.opacity,
      };
    });
    onLayer({ keys, trackAttach: { enabled: false, pointIndex: 0, offsetX: 0, offsetY: 0, useRotation: mode !== 'position', useScale: mode === 'scale' || mode === 'planar' } });
    onNotice(`${keys.length} tracking keys baked into the layer`);
  }, [layer, project.width, project.height, mode, onLayer, onNotice]);

  const attachData = layer.trackAttach;
  const confidenceSummary = useMemo(() => {
    const frames = layer.track?.frames || [];
    if (!frames.length) return null;
    const all = frames.flatMap(f => f.points.map(p => p.confidence));
    const mean = all.reduce((a, b) => a + b, 0) / Math.max(1, all.length);
    const weak = frames.filter(f => f.points.some(p => p.confidence < 0.55)).length;
    return { mean, weak, frames: frames.length };
  }, [layer.track]);

  return (
    <div className="trace-panel">
      <div className="trace-head">
        <span className="trace-title">FLINT TRACE</span>
        <span className="trace-sub">{layer.name}</span>
        <div className="trace-head-actions">
          <button className={compare ? 'chosen' : ''} onClick={() => setCompare(!compare)}>Original compare</button>
          <button className={showMask ? 'chosen' : ''} onClick={() => setShowMask(!showMask)}>Mask preview</button>
          <button onClick={onClose} title="Close Trace"><X size={14} /></button>
        </div>
      </div>

      <div className="trace-body">
        <div className="trace-stage">
          <div className="trace-canvas-wrap">
            <canvas ref={previewRef} className="trace-preview" />
            <canvas
              ref={overlayRef}
              className="trace-overlay"
              onPointerDown={e => {
                if (tool === 'remove') startPaint(e, false);
                else if (tool === 'segment') startPaint(e, e.altKey);
              }}
            />
            {compare && <div className="trace-compare-tag">ORIGINAL</div>}
          </div>
          <div className="trace-scrub">
            <button onClick={() => onSeek(Math.max(layer.start, playhead - 1))}>‹</button>
            <input
              type="range"
              min={layer.start}
              max={Math.max(layer.start, layer.start + layer.duration - 1)}
              value={playhead}
              onChange={e => onSeek(+e.target.value)}
            />
            <button onClick={() => onSeek(Math.min(layer.start + layer.duration - 1, playhead + 1))}>›</button>
            <span>{playhead - layer.start + 1}/{layer.duration}</span>
          </div>
          {tracking && <div className="trace-progress"><i style={{ width: `${Math.round(progress * 100)}%` }} /><span>{Math.round(progress * 100)}%</span></div>}
        </div>

        <div className="trace-controls">
          <section className="trace-section">
            <div className="trace-section-head">TRACKING
              <span>
                <button className={!tracking ? 'chosen' : ''} onClick={() => runTracking(1)} disabled={tracking}><Play size={12} />Fwd</button>
                <button onClick={() => runTracking(-1)} disabled={tracking}><Play size={12} className="flip" />Back</button>
                <button onClick={() => { cancelRef.current = true; }} disabled={!tracking}><Square size={11} />Stop</button>
                <button onClick={() => onLayer({ track: undefined })}><RotateCcw size={11} />Reset</button>
              </span>
            </div>
            <div className="trace-row">
              <label>Mode<select value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
                <option value="position">Position (1 pt)</option>
                <option value="rotation">Rotation (2 pt)</option>
                <option value="scale">Scale (2 pt)</option>
                <option value="planar">Planar (4 pt)</option>
              </select></label>
              <label>Quality<select value={quality} onChange={e => setQuality(e.target.value as typeof quality)}>
                <option value="fast">Fast</option>
                <option value="balanced">Balanced</option>
                <option value="high">High quality</option>
              </select></label>
            </div>
            <div className="trace-meta">
              {confidenceSummary ? <><span>confidence <b>{(confidenceSummary.mean * 100).toFixed(0)}%</b></span><span>frames <b>{confidenceSummary.frames}</b></span>{confidenceSummary.weak > 0 && <span className="warn">{confidenceSummary.weak} weak</span>}</> : <span>No tracking data yet</span>}
            </div>
            {layer.track?.frames && layer.track.frames.length > 0 && <div className="trace-graph" title="Tracking confidence per frame">
              {layer.track.frames.map(f => {
                const conf = f.points.reduce((a, p) => a + p.confidence, 0) / Math.max(1, f.points.length);
                return <i style={{ left: `${((f.frame - layer.track!.frames[0].frame) / Math.max(1, layer.track!.frames[layer.track!.frames.length - 1].frame - layer.track!.frames[0].frame)) * 100}%`, height: `${Math.max(6, conf * 100)}%`, opacity: 0.35 + conf * 0.6 }} />;
              })}
            </div>}
            <div className="trace-row">
              <button onClick={bakeTracking}><Wand2 size={12} />Bake to keyframes</button>
              <button onClick={() => onLayer({ trackAttach: { enabled: !attachData?.enabled, pointIndex: 0, offsetX: 0, offsetY: 0, useRotation: mode !== 'position', useScale: mode === 'scale' || mode === 'planar' } })}>
                <Pin size={12} />{attachData?.enabled ? 'Detach' : 'Attach layer'}
              </button>
            </div>
            <p className="trace-hint">Feature tracking uses NCC template matching on real frames. Low-confidence points hold their last position and are flagged rather than guessed. Landmark tracking is not offered: Flint is a conventional-CV tool and runs no trained models.</p>
          </section>

          <section className="trace-section">
            <div className="trace-section-head">ROTO / MASK
              <span>
                <button onClick={() => propagateMask(1)} disabled={tracking}>Propagate fwd</button>
                <button onClick={() => propagateMask(-1)} disabled={tracking}>Back</button>
              </span>
            </div>
            <div className="trace-row">
              <button onClick={() => { onLayer({ masks: layer.masks?.length ? layer.masks : undefined }); onSelectMask(layer.masks?.[0]?.id || ''); }}>Edit mask</button>
              <button onClick={() => onSelectMask(layer.masks?.[0]?.id || '')}><Crosshair size={12} />Select mask</button>
            </div>
            <p className="trace-hint">Propagation warps the current mask with the per-frame similarity solved from tracked features; it preserves path topology and writes editable mask keys.</p>
          </section>

          <section className="trace-section">
            <div className="trace-section-head">OBJECT REMOVAL
              <span>
                <button className={tool === 'remove' ? 'chosen' : ''} onClick={() => setTool(tool === 'remove' ? 'select' : 'remove')}><Eraser size={12} />Brush</button>
                <button onClick={runInpaint}><Scissors size={12} />Inpaint</button>
              </span>
            </div>
            <label className="trace-slider">Brush size<input type="range" min={6} max={90} value={brush} onChange={e => setBrush(+e.target.value)} /></label>
            <p className="trace-hint">Exemplar patch inpainting rebuilds the region from surrounding pixels. It creates a new patch layer above the source, so the original stays untouched. Video removal is per-frame.</p>
          </section>

          <section className="trace-section">
            <div className="trace-section-head">SUBJECT SEGMENTATION
              <span>
                <button className={tool === 'segment' ? 'chosen' : ''} onClick={() => setTool(tool === 'segment' ? 'select' : 'segment')}><Sparkles size={12} />{tool === 'segment' ? 'Painting' : 'Brushes'}</button>
                <button onClick={runSegmentation}>Generate matte</button>
              </span>
            </div>
            <div className="trace-row">
              <select value={segMode} onChange={e => setSegMode(e.target.value as typeof segMode)}>
                <option value="fast">Fast</option><option value="balanced">Balanced</option><option value="high">High quality</option>
              </select>
              <button onClick={() => { fgStrokes.current = []; bgStrokes.current = []; brushLayerRef.current = null; setBrushDirty(d => d + 1); }}>Clear strokes</button>
            </div>
            <p className="trace-hint">Paint the subject (drag) and the background (Alt-drag). This uses a locally computed colour/edge model with spatial refinement — accurate for distinct subjects, weaker on low-contrast edges. Manual masks remain available.</p>
          </section>

          <section className="trace-section">
            <div className="trace-section-head">STABILISATION
              <span>
                <button onClick={analyzeStabilization} disabled={tracking}><Activity size={12} />Analyse motion</button>
                <button onClick={() => onLayer({ stabilize: undefined })}><Trash2 size={11} />Remove</button>
              </span>
            </div>
            {layer.stabilize && <>
              <label className="trace-slider">Strength<input type="range" min={0} max={1} step=".02" value={layer.stabilize.strength} onChange={e => onLayer({ stabilize: { ...layer.stabilize!, strength: +e.target.value } })} /></label>
              <label className="trace-slider">Auto crop<input type="range" min={0} max={20} value={layer.stabilize.crop} onChange={e => onLayer({ stabilize: { ...layer.stabilize!, crop: +e.target.value } })} /></label>
              <div className="trace-row"><button className={layer.stabilize.enabled ? 'chosen' : ''} onClick={() => onLayer({ stabilize: { ...layer.stabilize!, enabled: !layer.stabilize!.enabled } })}>{layer.stabilize.enabled ? 'Stabilised preview' : 'Original preview'}</button></div>
            </>}
            <p className="trace-hint">Motion is estimated from tracked features and smoothed; the inverse transform is applied at render time. Source footage is never modified.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
