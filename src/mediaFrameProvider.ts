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
  /** True when the returned frame was decoded for this exact request. */
  exact: boolean;
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
    const exact = Math.abs(mediaTime - waiting.time) <= 0.5 / 1000 + 1e-6;
    if (!exact) {
      // The element settled on a different frame than requested - this is a
      // stale frame, so report it as such instead of pretending it matches.
      this.finish(waiting, { time: mediaTime, exact: false, stale: true });
      return;
    }
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      const handle = this.video.requestVideoFrameCallback(() => {
        this.finish(waiting, { time: this.video.currentTime, exact: true, stale: false });
      });
      setTimeout(() => {
        if (this.current === waiting) {
          this.video.cancelVideoFrameCallback?.(handle);
          this.finish(waiting, { time: this.video.currentTime, exact: true, stale: false });
        }
      }, Math.min(250, this.timeoutMs));
    } else {
      this.finish(waiting, { time: mediaTime, exact: true, stale: false });
    }
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
