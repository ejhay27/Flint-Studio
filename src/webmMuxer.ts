/**
 * Minimal, dependency-free WebM (Matroska/EBML) muxer for a single video track.
 *
 * Scope: VP8/VP9 video in WebM, written as EBML with known sizes, one Tracks
 * entry and sequential Clusters (one cluster per keyframe). Timestamps are
 * milliseconds, as required by Matroska. Audio tracks are not written by this
 * muxer - callers must not advertise audio for its output.
 *
 * Reference: Matroska/WebM container specification (EBML element IDs as below).
 */

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
};

const enc = new TextEncoder();

export function vint(value: number): Uint8Array {
  // EBML variable-size integer for element IDs/sizes (data length form).
  if (value < 0 || !Number.isInteger(value)) throw new RangeError(`vint(${value})`);
  for (let len = 1; len <= 8; len++) {
    const max = 2 ** (7 * len) - 1;
    if (value <= max) {
      const out = new Uint8Array(len);
      let v = value;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new RangeError('value too large for vint');
}

export function elemId(id: number): Uint8Array {
  const bytes: number[] = [];
  let v = id;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function element(id: number, payload: Uint8Array): Uint8Array {
  return concat([elemId(id), vint(payload.length), payload]);
}

function uint(value: number, bytes = 8): Uint8Array {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function float64(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value);
  return new Uint8Array(buf);
}

function str(value: string): Uint8Array {
  return enc.encode(value);
}

/** 19-byte OpusHead identification header required for CodecPrivate. */
export function opusHead(channels = 2, sampleRate = 48000, preSkip = 312): Uint8Array {
  const out = new Uint8Array(19);
  out.set(enc.encode('OpusHead'), 0);
  const dv = new DataView(out.buffer);
  dv.setUint8(8, 1);
  dv.setUint8(9, channels);
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, sampleRate, true);
  dv.setInt16(16, 0, true);
  dv.setUint8(18, 0);
  return out;
}

export type WebmTrack = {
  codec: 'V_VP8' | 'V_VP9';
  width: number;
  height: number;
  fps: number;
  /** Optional Opus audio track. Omit for a video-only file. */
  audio?: { sampleRate: number; channels: number; codecPrivate?: Uint8Array };
};

export type EncodedChunk = {
  data: Uint8Array;
  /** Presentation timestamp in seconds. */
  timestamp: number;
  /** Frame duration in seconds. */
  duration: number;
  keyframe: boolean;
};

/** Frame timestamp (seconds) -> Matroska millisecond timecode. */
export const msOf = (seconds: number) => Math.max(0, Math.round(seconds * 1000));

export class WebmMuxer {
  private clusters: Uint8Array[] = [];
  private pending: Array<EncodedChunk & { track: number }> = [];
  private clusterStartMs = 0;
  private lastMs = -1;
  private chunks = 0;
  private bytes = 0;
  private finished = false;
  constructor(private track: WebmTrack) {
    if (!(track.width > 0) || !(track.height > 0)) throw new RangeError('WebmMuxer: invalid dimensions');
  }

  get chunkCount() {
    return this.chunks;
  }
  get byteLength() {
    return this.bytes;
  }

  addChunk(chunk: EncodedChunk) {
    if (this.finished) throw new Error('WebmMuxer: already finalised');
    const ms = msOf(chunk.timestamp);
    if (ms < this.lastMs) throw new RangeError('WebmMuxer: timestamps must not decrease');
    this.lastMs = ms;
    this.chunks++;
    this.bytes += chunk.data.byteLength;
    // Start a new cluster on a keyframe, or when the int16 block offset would
    // overflow the SimpleBlock relative timestamp field.
    if (this.pending.length === 0 || (chunk.keyframe && this.pending.length > 0) || ms - this.clusterStartMs > 32767) {
      this.flushCluster();
      this.clusterStartMs = ms;
    }
    this.pending.push({ ...chunk, timestamp: ms / 1000, track: 1 });
  }

  /** Add one encoded Opus packet (requires an audio track on this muxer). */
  addAudioChunk(chunk: EncodedChunk) {
    if (this.finished) throw new Error('WebmMuxer: already finalised');
    if (!this.track.audio) throw new Error('WebmMuxer: no audio track configured');
    const ms = msOf(chunk.timestamp);
    this.audioChunks++;
    this.bytes += chunk.data.byteLength;
    if (this.pending.length === 0) this.clusterStartMs = ms;
    this.pending.push({ ...chunk, timestamp: ms / 1000, track: 2 });
    if (this.pending.length > 512) this.flushCluster();
  }
  private audioChunks = 0;
  get audioChunkCount() {
    return this.audioChunks;
  }

  private flushCluster() {
    if (!this.pending.length) return;
    const ordered = [...this.pending].sort((a, b) => msOf(a.timestamp) - msOf(b.timestamp));
    const blocks = ordered.map(c => {
      const rel = new Uint8Array(2);
      new DataView(rel.buffer).setInt16(0, Math.max(-32768, Math.min(32767, msOf(c.timestamp) - this.clusterStartMs)));
      const header = new Uint8Array([0x80 | c.track, rel[0], rel[1], c.track === 1 && c.keyframe ? 0x80 : 0x00]);
      return element(ID.SimpleBlock, concat([header, c.data]));
    });
    this.clusters.push(element(ID.Cluster, concat([element(ID.Timecode, uint(this.clusterStartMs, 4)), ...blocks])));
    this.pending = [];
  }

  /** Finalise the container and return the complete WebM file. */
  finalize(): Uint8Array {
    if (this.finished) throw new Error('WebmMuxer: already finalised');
    this.finished = true;
    this.flushCluster();
    const durationSec = this.lastMs >= 0 ? (this.lastMs + 1000 / this.track.fps) / 1000 : 0;
    const ebml = element(
      ID.EBML,
      concat([
        element(ID.EBMLVersion, uint(1, 1)),
        element(ID.EBMLReadVersion, uint(1, 1)),
        element(ID.EBMLMaxIDLength, uint(4, 1)),
        element(ID.EBMLMaxSizeLength, uint(8, 1)),
        element(ID.DocType, str('webm')),
        element(ID.DocTypeVersion, uint(2, 1)),
        element(ID.DocTypeReadVersion, uint(2, 1)),
      ]),
    );
    const info = element(
      ID.Info,
      concat([
        element(ID.TimecodeScale, uint(1_000_000, 3)), // 1 ms
        element(ID.MuxingApp, str('Flint Studio')),
        element(ID.WritingApp, str('Flint Studio offline renderer')),
        element(ID.Duration, float64(durationSec)),
      ]),
    );
    const audioEntry = this.track.audio
      ? element(
          ID.TrackEntry,
          concat([
            element(ID.TrackNumber, uint(2, 1)),
            element(ID.TrackUID, uint(2, 1)),
            element(ID.TrackType, uint(2, 1)),
            element(ID.CodecID, str('A_OPUS')),
            ...(this.track.audio.codecPrivate ? [element(ID.CodecPrivate, this.track.audio.codecPrivate)] : []),
            element(
              ID.Audio,
              concat([
                element(ID.SamplingFrequency, float64(this.track.audio.sampleRate)),
                element(ID.Channels, uint(this.track.audio.channels, 1)),
              ]),
            ),
          ]),
        )
      : null;
    const tracks = element(
      ID.Tracks,
      concat([
      element(
        ID.TrackEntry,
        concat([
          element(ID.TrackNumber, uint(1, 1)),
          element(ID.TrackUID, uint(1, 1)),
          element(ID.TrackType, uint(1, 1)), // video
          element(ID.CodecID, str(this.track.codec)),
          element(ID.DefaultDuration, uint(Math.round(1e9 / this.track.fps), 4)),
          element(
            ID.Video,
            concat([element(ID.PixelWidth, uint(this.track.width, 4)), element(ID.PixelHeight, uint(this.track.height, 4))]),
          ),
        ]),
      ),
      ...(audioEntry ? [audioEntry] : []),
      ]),
    );
    return concat([ebml, element(ID.Segment, concat([info, tracks, ...this.clusters]))]);
  }
}
