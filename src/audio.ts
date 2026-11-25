/* Flint audio engine: decoding, waveform peaks, beat detection, automation and mixdown. */

export type AudioKeyframe = { frame: number; volume: number; pan?: number };

export type BeatAnalysis = { peaks: number[]; beats: number[]; bpm: number; duration: number };

export type MixLayer = {
  id: string;
  start: number;
  duration: number;
  volume?: number;
  pan?: number;
  fadeIn?: number;
  fadeOut?: number;
  audioOffset?: number;
  audioKeys?: AudioKeyframe[];
  muted?: boolean;
  visible?: boolean;
};

let decodeContext: OfflineAudioContext | null = null;
function getDecodeContext() {
  if (!decodeContext) decodeContext = new OfflineAudioContext(1, 1, 44100);
  return decodeContext;
}

export async function decodeAudio(data: ArrayBuffer): Promise<AudioBuffer> {
  return await getDecodeContext().decodeAudioData(data.slice(0));
}

/** Waveform peaks (0..1) — max amplitude per bucket, subsampled for long files. */
export function computePeaks(buffer: AudioBuffer, buckets = 900): number[] {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const length = buffer.length;
  const step = Math.max(1, Math.floor(length / buckets));
  const stride = Math.max(1, Math.floor(step / 48));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = b * step;
    const end = Math.min(length, start + step);
    let peak = 0;
    for (let i = start; i < end; i += stride) {
      for (const ch of channels) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
    }
    peaks.push(peak);
  }
  const max = Math.max(1e-6, ...peaks);
  return peaks.map(p => p / max);
}

/** Energy-flux beat detection with autocorrelation tempo estimate. */
export function detectBeats(buffer: AudioBuffer): { beats: number[]; bpm: number } {
  const sr = buffer.sampleRate;
  const length = buffer.length;
  if (!length) return { beats: [], bpm: 0 };
  const mono = new Float32Array(length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    const w = 1 / buffer.numberOfChannels;
    for (let i = 0; i < length; i++) mono[i] += data[i] * w;
  }
  const win = 1024;
  const hop = 512;
  const frames = Math.floor((length - win) / hop);
  if (frames < 12) return { beats: [], bpm: 0 };
  const energy = new Float32Array(frames);
  const stride = 2;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const off = f * hop;
    for (let i = 0; i < win; i += stride) {
      const v = mono[off + i];
      sum += v * v;
    }
    energy[f] = Math.sqrt(sum / (win / stride));
  }
  const onset = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    let avg = 0;
    const n = Math.min(20, f);
    for (let k = 1; k <= n; k++) avg += energy[f - k];
    avg /= Math.max(1, n);
    onset[f] = Math.max(0, energy[f] - avg * 1.12);
  }
  let maxOnset = 0;
  for (const v of onset) maxOnset = Math.max(maxOnset, v);
  if (maxOnset < 1e-5) return { beats: [], bpm: 0 };
  for (let f = 0; f < frames; f++) onset[f] /= maxOnset;

  const envelopeRate = sr / hop;
  const lagMin = Math.max(2, Math.round((envelopeRate * 60) / 190));
  const lagMax = Math.min(frames - 2, Math.round((envelopeRate * 60) / 55));
  if (lagMax <= lagMin) return { beats: [], bpm: 0 };
  let bestLag = lagMin;
  let bestScore = -1;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let score = 0;
    for (let i = lag; i < frames; i++) score += onset[i] * onset[i - lag];
    score /= frames - lag;
    // Prefer plausible dance tempos slightly.
    const bpm = (60 * envelopeRate) / lag;
    const weighted = score * (bpm > 70 && bpm < 175 ? 1.08 : 1);
    if (weighted > bestScore) {
      bestScore = weighted;
      bestLag = lag;
    }
  }
  let bestPhase = 0;
  let bestPhaseScore = -1;
  for (let phase = 0; phase < bestLag; phase++) {
    let score = 0;
    let count = 0;
    for (let i = phase; i < frames; i += bestLag) {
      score += onset[i];
      count++;
    }
    score /= Math.max(1, count);
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = phase;
    }
  }
  const beats: number[] = [];
  for (let f = bestPhase; f < frames; f += bestLag) beats.push((f * hop) / sr);
  const bpm = (60 * envelopeRate) / bestLag;
  return { beats, bpm: Math.round(bpm * 10) / 10 };
}

export async function analyzeAudio(buffer: AudioBuffer): Promise<BeatAnalysis> {
  const { beats, bpm } = detectBeats(buffer);
  return { peaks: computePeaks(buffer), beats, bpm, duration: buffer.duration };
}

/* ------------------------------------------------------------------ */
/* Automation                                                          */
/* ------------------------------------------------------------------ */

function sortedKeys(keys?: AudioKeyframe[]) {
  return [...(keys || [])].sort((a, b) => a.frame - b.frame);
}

export function audioGainAt(layer: MixLayer, frame: number): number {
  const local = frame - layer.start;
  let gain = Math.max(0, layer.volume ?? 1);
  const keys = sortedKeys(layer.audioKeys);
  if (keys.length) {
    if (frame <= keys[0].frame) gain = keys[0].volume;
    else if (frame >= keys[keys.length - 1].frame) gain = keys[keys.length - 1].volume;
    else
      for (let i = 0; i < keys.length - 1; i++) {
        if (frame >= keys[i].frame && frame <= keys[i + 1].frame) {
          const t = (frame - keys[i].frame) / Math.max(1, keys[i + 1].frame - keys[i].frame);
          gain = keys[i].volume + (keys[i + 1].volume - keys[i].volume) * t;
          break;
        }
      }
  }
  if ((layer.fadeIn || 0) > 0) gain *= Math.min(1, Math.max(0, local) / (layer.fadeIn as number));
  if ((layer.fadeOut || 0) > 0) gain *= Math.min(1, Math.max(0, layer.duration - local) / (layer.fadeOut as number));
  return Math.max(0, Math.min(2, gain));
}

export function audioPanAt(layer: MixLayer, frame: number): number {
  const keys = sortedKeys(layer.audioKeys);
  if (keys.length && keys.some(k => typeof k.pan === 'number')) {
    if (frame <= keys[0].frame) return keys[0].pan ?? layer.pan ?? 0;
    if (frame >= keys[keys.length - 1].frame) return keys[keys.length - 1].pan ?? layer.pan ?? 0;
    for (let i = 0; i < keys.length - 1; i++) {
      if (frame >= keys[i].frame && frame <= keys[i + 1].frame) {
        const t = (frame - keys[i].frame) / Math.max(1, keys[i + 1].frame - keys[i].frame);
        return (keys[i].pan ?? 0) + ((keys[i + 1].pan ?? 0) - (keys[i].pan ?? 0)) * t;
      }
    }
  }
  return Math.max(-1, Math.min(1, layer.pan ?? 0));
}

/** Convert detected source-time beats into timeline frames for a placed clip. */
export function beatsToFrames(beats: number[], startFrame: number, offsetFrames: number, fps: number): number[] {
  return beats.map(b => startFrame + b * fps - offsetFrames).filter(f => f >= startFrame - 0.001);
}

/** Decaying beat envelope (0..1) at a timeline frame. */
export function beatEnvelopeFrames(beatFrames: number[], frame: number, decayFrames = 6): number {
  if (!beatFrames.length) return 0;
  let idx = -1;
  let lo = 0;
  let hi = beatFrames.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beatFrames[mid] <= frame) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  let env = 0;
  for (let i = Math.max(0, idx); i <= Math.min(beatFrames.length - 1, idx + 1); i++) {
    const dt = frame - beatFrames[i];
    if (dt >= 0 && dt < decayFrames) env = Math.max(env, 1 - dt / decayFrames);
  }
  return env;
}

/** Decaying beat envelope (0..1) at a frame, driven by detected beat times. */
export function beatEnvelopeAt(beats: number[], frame: number, fps: number, decayFrames = 6): number {
  if (!beats.length) return 0;
  const t = frame / fps;
  let lo = 0;
  let hi = beats.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  let env = 0;
  for (let i = Math.max(0, idx); i <= Math.min(beats.length - 1, idx + 1); i++) {
    const dt = (t - beats[i]) * fps;
    if (dt >= 0 && dt < decayFrames) env = Math.max(env, 1 - dt / decayFrames);
  }
  return env;
}

export function nearestBeatFrame(beatFrames: number[] | undefined, frame: number, maxDistance = 6): number | null {
  if (!beatFrames || !beatFrames.length) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const f of beatFrames) {
    const d = Math.abs(f - frame);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  if (best === null || bestDist > maxDistance) return null;
  return Math.round(best);
}

/* ------------------------------------------------------------------ */
/* Asset persistence                                                   */
/* ------------------------------------------------------------------ */

function assetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('flint-audio-assets', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('assets')) req.result.createObjectStore('assets');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function storeAsset(id: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await assetDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('assets', 'readwrite');
      tx.objectStore('assets').put(data, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* storage unavailable — the session still works from memory */
  }
}

export async function loadAsset(id: string): Promise<ArrayBuffer | undefined> {
  try {
    const db = await assetDb();
    const data = await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
      const req = db.transaction('assets').objectStore('assets').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return data;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Mixdown and WAV encoding                                            */
/* ------------------------------------------------------------------ */

export async function renderMixdown(layers: MixLayer[], buffers: Map<string, AudioBuffer>, fps: number, durationFrames: number, sampleRate = 44100): Promise<AudioBuffer> {
  const seconds = Math.max(0.1, durationFrames / fps);
  const context = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  let rendered = 0;
  for (const layer of layers) {
    const buffer = buffers.get(layer.id);
    if (!buffer || layer.muted || layer.visible === false) continue;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    source.connect(gain);
    gain.connect(panner);
    panner.connect(context.destination);
    const startSec = Math.max(0, layer.start / fps);
    const offsetSec = Math.max(0, (layer.audioOffset || 0) / fps);
    const durationSec = Math.max(0, Math.min(layer.duration / fps, buffer.duration - offsetSec));
    if (durationSec <= 0) continue;
    const steps = Math.max(2, Math.min(900, Math.ceil(durationSec * 24)));
    for (let i = 0; i <= steps; i++) {
      const localSec = (i / steps) * durationSec;
      const frame = layer.start + localSec * fps;
      const at = startSec + localSec;
      const gainValue = audioGainAt(layer, frame);
      const panValue = audioPanAt(layer, frame);
      if (i === 0) {
        gain.gain.setValueAtTime(gainValue, at);
        panner.pan.setValueAtTime(panValue, at);
      } else {
        gain.gain.linearRampToValueAtTime(gainValue, at);
        panner.pan.linearRampToValueAtTime(panValue, at);
      }
    }
    source.start(startSec, offsetSec, durationSec);
    rendered++;
  }
  if (!rendered) throw Error('No decodable audio layers');
  return await context.startRendering();
}

export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels);
  const frames = buffer.length;
  const dataSize = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
