/**
 * Frame-accurate media sampling for deterministic export.
 *
 * Composition time and source-media time are separate: animation is evaluated
 * continuously (fractional frames), while source frames are requested by an
 * explicit media timestamp derived from clip start, source in-point and rate.
 * A seek is never treated as complete just because `currentTime` was assigned:
 * the provider waits for `seeked` (and `requestVideoFrameCallback` where
 * available), matches the request token and rejects stale results.
 */

export type VideoLike = {
  currentTime: number;
  readyState: number;
  paused?: boolean;
  duration?: number;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export type ClipTiming = {
  /** Layer start, in composition frames. */
  start: number;
  /** Layer duration, in composition frames. */
  duration: number;
  /** Composition frame rate. */
  compFps: number;
  /** Source in-point, in source seconds. */
  inPoint?: number;
  /** Playback rate (1 = normal). */
  rate?: number;
  /** Source duration in seconds, when known. */
  sourceDuration?: number;
};

/**
 * Map a composition time (frames, fractional allowed) to a source timestamp.
 * Returns null when the layer is not live at that time.
 */
export function sourceTimeForClip(compFrame: number, clip: ClipTiming): number | null {
  if (compFrame < clip.start || compFrame >= clip.start + clip.duration) return null;
  const compSeconds = compFrame / Math.max(1, clip.compFps);
  const startSeconds = clip.start / Math.max(1, clip.compFps);
  const rate = clip.rate && clip.rate > 0 ? clip.rate : 1;
  const t = (compSeconds - startSeconds) * rate + (clip.inPoint || 0);
  const capped = clip.sourceDuration !== undefined ? Math.min(clip.sourceDuration, Math.max(0, t)) : Math.max(0, t);
  return Number.isFinite(capped) ? capped : null;
}

/** Quantise a seek target to a microsecond grid so cache keys are stable. */
export const quantiseTime = (seconds: number) => Math.round(seconds * 1e6) / 1e6;

export type FrameResult = {
  time: number;
  /** Presentation interval of the frame that was actually returned. */
  interval: { start: number; end: number };
  /** True when the requested time falls inside the returned frame's interval. */
  exact: boolean;
  /** True when the returned frame ends before the requested time. */
  stale: boolean;
};

export class MediaFrameError extends Error {}

/** Bounded LRU cache for decoded/decodable frames, keyed by media timestamp. */
export class FrameCache<T> {
  private map = new Map<number, { value: T; bytes: number }>();
  private used = 0;
  hits = 0;
  misses = 0;
  evictions = 0;
  constructor(
    private budgetBytes: number,
    private bytesOf: (value: T) => number,
  ) {}

  get bytes() {
    return this.used;
  }
  get size() {
    return this.map.size;
  }

  get(time: number): T | undefined {
    const key = quantiseTime(time);
    const hit = this.map.get(key);
    if (!hit) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.map.delete(key);
    this.map.set(key, hit); // refresh recency
    return hit.value;
  }

  set(time: number, value: T) {
    const key = quantiseTime(time);
    const bytes = Math.max(1, this.bytesOf(value));
    const existing = this.map.get(key);
    if (existing) {
      this.used -= existing.bytes;
      this.map.delete(key);
    }
    this.map.set(key, { value, bytes });
    this.used += bytes;
    for (const [k, entry] of this.map) {
      if (this.used <= this.budgetBytes) break;
      if (k === key) continue;
      this.map.delete(k);
      this.used -= entry.bytes;
      this.evictions++;
    }
  }

  clear() {
    this.map.clear();
    this.used = 0;
  }
}

type Waiter = {
  time: number;
  token: number;
  resolve: (r: FrameResult) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * HTMLVideoElement-backed frame retrieval with stale-frame protection.
 * Used for browsers without WebCodecs and for containers the decoder path
 * does not support. Frame accuracy is bounded by the platform's seek
 * precision; it is not claimed to be exact.
 */
export class VideoFrameProvider {
  private video: VideoLike;
  private token = 0;
  private queue: Waiter[] = [];
  private busy = false;
  private disposed = false;
  private onSeeked = () => this.settle(null);
  private onError = () => this.settle(new MediaFrameError('Video element failed while seeking'));
  private static registry = new WeakMap<VideoLike, VideoFrameProvider>();
  /** One provider per video element so seeks never interleave. */
  static for(video: VideoLike, timeoutMs = 4000) {
    let p = VideoFrameProvider.registry.get(video);
    if (!p) {
      p = new VideoFrameProvider(video, timeoutMs);
      VideoFrameProvider.registry.set(video, p);
    }
    return p;
  }

  /** Assumed presentation duration of one frame; VFR sources override per result. */
  frameDuration = 1 / 30;

  constructor(video: VideoLike, private timeoutMs = 4000) {
    this.video = video;
    video.addEventListener('seeked', this.onSeeked);
    video.addEventListener('error', this.onError);
  }

  /** Request the source frame at `time` (seconds). Resolves when decoding finished. */
  frameAt(time: number): Promise<FrameResult> {
    if (this.disposed) return Promise.reject(new MediaFrameError('Provider disposed'));
    if (!(this.video.readyState >= 2)) {
      return Promise.reject(new MediaFrameError('Media is not ready (metadata/decoded frame unavailable)'));
    }
    const target = quantiseTime(time);
    return new Promise<FrameResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter(w => w.timer !== timer);
        reject(new MediaFrameError(`Timed out waiting for media frame at ${target.toFixed(3)}s`));
        this.busy = false;
        this.pump();
      }, this.timeoutMs);
      this.queue.push({ time: target, token: ++this.token, resolve, reject, timer });
      this.pump();
    });
  }

  private pump() {
    if (this.busy || this.disposed) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    this.current = next;
    try {
      this.video.currentTime = next.time;
    } catch (e) {
      this.finish(next, undefined, e);
    }
  }

  private current: Waiter | null = null;

  private settle(error: unknown) {
    const waiting = this.current;
    if (!waiting) return;
    if (error) {
      this.finish(waiting, undefined, error);
      return;
    }
    const mediaTime = this.video.currentTime;
    const interval = { start: mediaTime, end: mediaTime + this.frameDuration };
    // A seek does not have to land on the requested timestamp: it is valid when
    // the requested time falls inside the returned frame's presentation interval.
    const cls = frameClassFor(interval, waiting.time);
    this.finish(waiting, { time: mediaTime, interval, exact: cls === 'exact', stale: cls === 'stale' });
  }

  private finish(waiter: Waiter, result: FrameResult | undefined, error?: unknown) {
    clearTimeout(waiter.timer);
    this.current = null;
    this.busy = false;
    if (error) waiter.reject(error);
    else waiter.resolve(result as FrameResult);
    this.pump();
  }

  dispose() {
    this.disposed = true;
    for (const w of this.queue) {
      clearTimeout(w.timer);
      w.reject(new MediaFrameError('Provider disposed'));
    }
    this.queue = [];
    if (this.current) this.finish(this.current, undefined, new MediaFrameError('Provider disposed'));
    this.video.removeEventListener('seeked', this.onSeeked);
    this.video.removeEventListener('error', this.onError);
  }
}

/**
 * A decoded frame is valid for a requested time when that time falls inside the
 * frame's presentation interval, not when the timestamps are equal. VFR footage
 * and platform timestamps are never exactly equal to the requested time.
 */
export type FrameInterval = { start: number; end: number };

export function frameContains(interval: FrameInterval, time: number, tolerance = 1e-4): boolean {
  return time >= interval.start - tolerance && time <= interval.end + tolerance;
}

export function frameClassFor(interval: FrameInterval, time: number): 'exact' | 'stale' | 'future' {
  if (frameContains(interval, time)) return 'exact';
  return interval.end < time ? 'stale' : 'future';
}

/**
 * Resolve every active video clip at one composition time and await its frame.
 * Clips sharing a source are fetched through the same provider at their own
 * timestamps; the provider serialises the seeks, so results are still correct.
 */
export type ActiveClip = { id: string; clip: ClipTiming; provider: VideoLike; getProvider: () => Promise<VideoLike | null> };

export async function awaitMediaForFrame(
  compFrame: number,
  clips: Array<{ id: string; clip: ClipTiming; provider: VideoLike }>,
  opts: { tolerance?: number } = {},
): Promise<{ resolved: Array<{ id: string; time: number; exact: boolean; stale: boolean }>; skipped: string[] }> {
  const resolved: Array<{ id: string; time: number; exact: boolean; stale: boolean }> = [];
  const skipped: string[] = [];
  for (const entry of clips) {
    const time = sourceTimeForClip(compFrame, entry.clip);
    if (time === null) {
      skipped.push(entry.id);
      continue;
    }
    const provider = VideoFrameProvider.for(entry.provider);
    const result = await provider.frameAt(time);
    if (!result.exact) {
      // A different presentation interval than requested: valid only if the
      // requested time still falls inside the returned frame's own interval.
      const interval = result.interval ?? { start: result.time, end: result.time + (opts.tolerance ?? 0) };
      const cls = frameClassFor(interval, time);
      if (cls !== 'exact') resolved.push({ id: entry.id, time, exact: false, stale: true });
      else resolved.push({ id: entry.id, time, exact: true, stale: false });
      continue;
    }
    resolved.push({ id: entry.id, time, exact: true, stale: false });
  }
  return { resolved, skipped };
}

/**
 * Copy the current pixels of a source element into an independent snapshot.
 * Required because several layers can reference one <video>: each layer needs
 * its own decoded frame held simultaneously, so the final seek cannot
 * overwrite the frames earlier layers still need.
 */
export type Snapshot = { canvas: HTMLCanvasElement; time: number; interval: FrameInterval; width: number; height: number };

export function captureSnapshot(source: CanvasImageSource & { currentTime?: number }, width: number, height: number, time: number): Snapshot | null {
  if (!(width > 0) || !(height > 0)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  } catch {
    return null; // tainted or not decodable yet
  }
  return { canvas, time, interval: { start: time, end: time }, width: canvas.width, height: canvas.height };
}

/**
 * Resolve and snapshot every live clip in one pass. Snapshots are returned in
 * clip order and stay valid after later seeks; the caller binds them to the
 * compositor layers and releases them when the frame is done.
 */
export async function snapshotMediaForFrame(
  compFrame: number,
  clips: Array<{ id: string; clip: ClipTiming; provider: VideoLike & { videoWidth?: number; videoHeight?: number } }>,
): Promise<{ snapshots: Array<{ id: string; snapshot: Snapshot | null; time: number }>; skipped: string[]; rejected: string[] }> {
  const snapshots: Array<{ id: string; snapshot: Snapshot | null; time: number }> = [];
  const skipped: string[] = [];
  const rejected: string[] = [];
  for (const entry of clips) {
    const time = sourceTimeForClip(compFrame, entry.clip);
    if (time === null) {
      skipped.push(entry.id);
      continue;
    }
    const provider = VideoFrameProvider.for(entry.provider);
    const frame = await provider.frameAt(time);
    if (!frame.exact) {
      // Never render footage we know is the wrong frame.
      rejected.push(entry.id);
      continue;
    }
    const w = entry.provider.videoWidth || 0;
    const h = entry.provider.videoHeight || 0;
    const snapshot = captureSnapshot(entry.provider as unknown as CanvasImageSource, w, h, time);
    if (!snapshot) {
      rejected.push(entry.id);
      continue;
    }
    snapshots.push({ id: entry.id, snapshot, time });
  }
  return { snapshots, skipped, rejected };
}
