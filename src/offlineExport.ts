/**
 * Deterministic offline export driver.
 *
 * The export clock is the frame index, never requestAnimationFrame or wall
 * clock time: composition time, source-media sampling and encoder timestamps
 * are all derived from it. Rendering is awaited per frame, so a slow render
 * changes how long the export takes, not what it contains.
 */

export type FrameLike = { close?: () => void; timestamp?: number; duration?: number };

export type OfflineExportOptions = {
  /** First composition frame to render (may be fractional). */
  startFrame: number;
  /** Number of frames to write. */
  frameCount: number;
  /** Composition frame rate. */
  compFps: number;
  /** Output frame rate. */
  exportFps: number;
  /** Await decoded media for this composition frame before rendering. */
  awaitMedia?: (compFrame: number, index: number) => Promise<void>;
  /** Render one frame through the real compositor at export resolution. */
  render: (compFrame: number, index: number) => Promise<FrameLike>;
  /** Submit one frame to the encoder (WebCodecs VideoEncoder). */
  encode: (frame: FrameLike, meta: { timestampUs: number; durationUs: number; keyframe: boolean; index: number }) => void | Promise<void>;
  /** Current encoder queue depth, for backpressure. */
  queueDepth?: () => number;
  /** Maximum queued frames before waiting (default 4). */
  maxQueue?: number;
  /** Keyframe interval in seconds (default 2). */
  keyframeIntervalSec?: number;
  /** Cooperative cancellation flag. */
  signal?: { aborted: boolean };
  flush?: () => Promise<void>;
  onProgress?: (p: { index: number; done: number; total: number; elapsedMs: number; compFrame: number }) => void;
  now?: () => number;
};

export type OfflineExportResult = {
  framesEncoded: number;
  cancelled: boolean;
  elapsedMs: number;
  timestampsUs: number[];
  compFrames: number[];
  mediaWaits: number;
  backpressureWaits: number;
};

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Composition frame for output index i, preserving fractional stepping. */
export const compFrameAt = (startFrame: number, index: number, compFps: number, exportFps: number) =>
  startFrame + index * (compFps / exportFps);

/** Microsecond presentation timestamp for output index i (no accumulating drift). */
export const timestampUsAt = (index: number, exportFps: number) => Math.round((index * 1_000_000) / exportFps);

export async function runOfflineExport(opts: OfflineExportOptions): Promise<OfflineExportResult> {
  const {
    startFrame, frameCount, compFps, exportFps, awaitMedia, render, encode,
    queueDepth, maxQueue = 4, keyframeIntervalSec = 2, signal, flush, onProgress,
  } = opts;
  if (!(frameCount > 0)) throw new Error('Offline export needs at least one frame');
  if (!(exportFps > 0) || !(compFps > 0)) throw new Error('Invalid frame rate for offline export');
  const now = opts.now || (() => Date.now());
  const t0 = now();
  const durationUs = Math.round(1_000_000 / exportFps);
  const keyEvery = Math.max(1, Math.round(keyframeIntervalSec * exportFps));
  const timestampsUs: number[] = [];
  const compFrames: number[] = [];
  let mediaWaits = 0;
  let backpressureWaits = 0;
  let framesEncoded = 0;
  let cancelled = false;

  for (let i = 0; i < frameCount; i++) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    while (queueDepth && queueDepth() >= maxQueue) {
      backpressureWaits++;
      if (signal?.aborted) { cancelled = true; break; }
      await sleep(1);
    }
    if (cancelled) break;
    const compFrame = compFrameAt(startFrame, i, compFps, exportFps);
    if (awaitMedia) {
      await awaitMedia(compFrame, i);
      mediaWaits++;
    }
    const frame = await render(compFrame, i);
    try {
      const timestampUs = timestampUsAt(i, exportFps);
      await encode(frame, { timestampUs, durationUs, keyframe: i % keyEvery === 0, index: i });
      timestampsUs.push(timestampUs);
      compFrames.push(compFrame);
      framesEncoded++;
    } finally {
      // Release the render result immediately; never accumulate frames in RAM.
      try { frame?.close?.(); } catch { /* already closed by the encoder */ }
    }
    onProgress?.({ index: i, done: framesEncoded, total: frameCount, elapsedMs: now() - t0, compFrame });
  }
  if (!cancelled && flush) await flush();
  return { framesEncoded, cancelled, elapsedMs: now() - t0, timestampsUs, compFrames, mediaWaits, backpressureWaits };
}
