/**
 * Render settings and deterministic frame/timebase maths shared by the
 * preview, the export driver and the tests. Pure functions only: no DOM,
 * no WebGL, so it can be verified headlessly.
 */

export type ResolutionPreset = '480p' | '720p' | '1080p' | '1440p' | '2160p' | 'custom';

export const RESOLUTION_PRESETS: Record<Exclude<ResolutionPreset, 'custom'>, { w: number; h: number; label: string }> = {
  '480p': { w: 854, h: 480, label: '480p' },
  '720p': { w: 1280, h: 720, label: '720p' },
  '1080p': { w: 1920, h: 1080, label: '1080p' },
  '1440p': { w: 2560, h: 1440, label: '1440p' },
  '2160p': { w: 3840, h: 2160, label: '4K UHD' },
};

export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

export type RenderQuality = 'draft' | 'standard' | 'high';

export type ExportSettings = {
  preset: ResolutionPreset;
  width: number;
  height: number;
  fps: number;
  quality: RenderQuality;
  transparent: boolean;
  includeAudio: boolean;
  /** Inclusive frame range in composition frames. */
  startFrame: number;
  endFrame: number | null;
};

export type FrameRange = { start: number; end: number; count: number };

export const defaultExportSettings = (width: number, height: number, fps: number): ExportSettings => ({
  preset: 'custom',
  width,
  height,
  fps,
  quality: 'high',
  transparent: false,
  includeAudio: true,
  startFrame: 0,
  endFrame: null,
});

/** Clamp user input to something the renderer can actually allocate. */
export function normaliseExportSettings(s: ExportSettings, project: { width: number; height: number; fps: number; duration: number }): ExportSettings {
  const maxDim = 4096;
  const w = Math.max(16, Math.min(maxDim, Math.round(s.width) || project.width));
  const h = Math.max(16, Math.min(maxDim, Math.round(s.height) || project.height));
  const totalFrames = Math.max(1, Math.round(project.duration * project.fps));
  const start = Math.max(0, Math.min(totalFrames - 1, Math.round(s.startFrame)));
  const end = s.endFrame === null ? totalFrames - 1 : Math.max(start, Math.min(totalFrames - 1, Math.round(s.endFrame)));
  const fps = FRAME_RATES.reduce((best, r) => (Math.abs(r - s.fps) < Math.abs(best - s.fps) ? r : best), FRAME_RATES[0]);
  return { ...s, width: w, height: h, fps, startFrame: start, endFrame: end };
}

export function applyPreset(s: ExportSettings, preset: ResolutionPreset): ExportSettings {
  if (preset === 'custom') return { ...s, preset };
  const r = RESOLUTION_PRESETS[preset];
  return { ...s, preset, width: r.w, height: r.h };
}

/** Frame range of an export, in composition frames. */
export function frameRange(s: ExportSettings, project: { duration: number; fps: number }): FrameRange {
  const total = Math.max(1, Math.round(project.duration * project.fps));
  const start = Math.max(0, Math.min(total - 1, Math.round(s.startFrame)));
  const end = s.endFrame === null ? total - 1 : Math.max(start, Math.min(total - 1, Math.round(s.endFrame)));
  return { start, end, count: end - start + 1 };
}

/**
 * Wall-clock timestamp (seconds) for an export frame, derived from the
 * composition timebase and the export frame rate - never from playback speed.
 */
export function frameTimestamp(index: number, exportFps: number): number {
  return index / Math.max(1, exportFps);
}

/** Map an export frame index to the composition frame that must be evaluated. */
export function exportFrameToCompositionFrame(
  index: number,
  settings: ExportSettings,
  project: { fps: number },
): number {
  const range = frameRange(settings, { duration: 1e9, fps: project.fps });
  const start = Math.max(0, range.start);
  const seconds = frameTimestamp(index, settings.fps);
  return Math.round((start / project.fps + seconds) * project.fps);
}

export type CapabilityReport = {
  ok: boolean;
  problems: string[];
  notes: string[];
};

/**
 * Capability check for the current machine. Values come from the caller
 * (measured or queried) - nothing here is guessed.
 */
export function checkExportCapability(
  settings: ExportSettings,
  caps: { maxTextureSize: number; webgl2: boolean; webCodecs: boolean; mediaRecorder: boolean },
): CapabilityReport {
  const problems: string[] = [];
  const notes: string[] = [];
  const longest = Math.max(settings.width, settings.height);
  if (longest > caps.maxTextureSize) {
    problems.push(
      `Requested ${settings.width}x${settings.height} exceeds this GPU's maximum texture size (${caps.maxTextureSize}px).`,
    );
  }
  const pixels = settings.width * settings.height;
  if (pixels > 8_294_400) notes.push('Above 4K: render targets are large, exports may be slow on integrated graphics.');
  if (!caps.webgl2) notes.push('WebGL1 context: floating point targets and WebCodecs paths are limited.');
  if (!caps.webCodecs) notes.push('WebCodecs is unavailable, so video is recorded in real time with MediaRecorder instead of deterministic offline encoding.');
  if (!caps.mediaRecorder && !caps.webCodecs) problems.push('No video encoder is available in this browser.');
  return { ok: problems.length === 0, problems, notes };
}

/** Bounded queue used by the export driver to keep encoder backpressure sane. */
export class FrameQueue<T> {
  private items: T[] = [];
  constructor(private limit: number) {}
  get size() {
    return this.items.length;
  }
  get full() {
    return this.items.length >= this.limit;
  }
  push(item: T) {
    if (this.full) return false;
    this.items.push(item);
    return true;
  }
  shift(): T | undefined {
    return this.items.shift();
  }
  clear() {
    this.items.length = 0;
  }
}
