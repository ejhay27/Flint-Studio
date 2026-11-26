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

/* ------------------------------------------------------------------ *
 * Offline Opus audio encoding (WebCodecs AudioEncoder)
 * ------------------------------------------------------------------ */

export type PcmSource = {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(channel: number): Float32Array;
};

export type OpusChunk = { data: Uint8Array; timestamp: number; duration: number; keyframe: boolean };
export type OpusMeta = { sampleRate: number; channels: number; preSkip: number; codecDelayUs: number; seekPreRollUs: number; codecPrivate?: Uint8Array };

/** Opus packets are 20 ms (960 samples @48 kHz); encode in bounded blocks. */
export const OPUS_FRAME_SAMPLES = 960;
export const OPUS_SAMPLE_RATE = 48000;

/** Linear resampling of one channel into the Opus sample rate (nearest-neighbour safe). */
export function resampleChannel(src: Float32Array, fromRate: number, toRate = OPUS_SAMPLE_RATE): Float32Array {
  if (fromRate === toRate) return src;
  const ratio = fromRate / toRate;
  const outLen = Math.max(0, Math.floor(src.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = src[i0] * (1 - frac) + src[i1] * frac;
  }
  return out;
}

/**
 * Encode a slice of mixed PCM to Opus packets.
 * Timestamps are derived from the cumulative sample count, so they cannot drift.
 * `AudioEncoderCtor`/`AudioDataCtor` are injectable for tests; in the editor the
 * real WebCodecs globals are used.
 */
export async function encodeOpusPcm(opts: {
  pcm: PcmSource;
  startSec: number;
  endSec: number;
  bitrate?: number;
  sampleRate?: number;
  onChunk: (chunk: OpusChunk) => void;
  onMeta?: (meta: OpusMeta) => void;
  signal?: { aborted: boolean };
  maxQueue?: number;
  AudioEncoderCtor?: any;
  AudioDataCtor?: any;
}): Promise<{ chunks: number; samples: number; cancelled: boolean; meta: OpusMeta | null }> {
  const AE = opts.AudioEncoderCtor ?? (globalThis as any).AudioEncoder;
  const AD = opts.AudioDataCtor ?? (globalThis as any).AudioData;
  if (typeof AE !== 'function' || typeof AD !== 'function') throw new Error('WebCodecs AudioEncoder is not available in this browser');
  const rate = opts.sampleRate ?? OPUS_SAMPLE_RATE;
  const channels = Math.min(2, Math.max(1, opts.pcm.numberOfChannels));
  const config = { codec: 'opus', sampleRate: rate, numberOfChannels: channels, bitrate: opts.bitrate ?? 128_000 };
  if (typeof AE.isConfigSupported === 'function') {
    const support = await AE.isConfigSupported(config);
    if (!support?.supported) throw new Error(`Opus encoding is not supported at ${rate} Hz / ${channels} ch`);
  }
  const maxQueue = opts.maxQueue ?? 8;
  let chunks = 0;
  let meta: OpusMeta | null = null;
  let cancelled = false;
  const encoder = new AE({
    output: (chunk: any) => {
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      const desc = chunk.metadata?.decoderConfig?.description;
      if (!meta) {
        const priv = desc ? new Uint8Array(desc instanceof ArrayBuffer ? desc : desc.buffer ?? desc) : undefined;
        meta = {
          sampleRate: rate,
          channels,
          // Opus pre-skip lives at bytes 10..11 of OpusHead; read it, never invent it.
          preSkip: priv && priv.length >= 12 ? priv[10] | (priv[11] << 8) : 0,
          codecDelayUs: 0,
          seekPreRollUs: 80_000,
          codecPrivate: priv,
        };
        opts.onMeta?.(meta);
      }
      opts.onChunk({ data: buf, timestamp: chunk.timestamp / 1e6, duration: (chunk.duration ?? 20_000) / 1e6, keyframe: true });
      chunks++;
    },
    error: (e: any) => { throw e instanceof Error ? e : new Error(String(e)); },
  });
  encoder.configure(config);
  try {
    const srcRate = opts.pcm.sampleRate;
    const srcChannels = Array.from({ length: channels }, (_, c) => resampleChannel(opts.pcm.getChannelData(c), srcRate, rate));
    const startSample = Math.max(0, Math.round(opts.startSec * rate));
    const endSample = Math.min(srcChannels[0].length, Math.round(opts.endSec * rate));
    for (let pos = startSample; pos < endSample; pos += OPUS_FRAME_SAMPLES) {
      if (opts.signal?.aborted) { cancelled = true; break; }
      while ((encoder.encodeQueueSize ?? 0) >= maxQueue) {
        await sleep(1);
        if (opts.signal?.aborted) { cancelled = true; break; }
      }
      if (cancelled) break;
      const count = Math.min(OPUS_FRAME_SAMPLES, endSample - pos);
      const planar = new Float32Array(count * channels);
      for (let c = 0; c < channels; c++) planar.set(srcChannels[c].subarray(pos, pos + count), c * count);
      const data = new AD({
        format: 'f32-planar',
        sampleRate: rate,
        numberOfFrames: count,
        numberOfChannels: channels,
        timestamp: Math.round((pos / rate) * 1e6),
        data: planar,
      });
      try { encoder.encode(data); } finally { data.close?.(); }
    }
    if (!cancelled) await encoder.flush();
  } finally {
    try { encoder.close(); } catch { /* already closed */ }
  }
  return { chunks, samples: Math.max(0, Math.round((opts.endSec - opts.startSec) * rate)), cancelled, meta };
}
