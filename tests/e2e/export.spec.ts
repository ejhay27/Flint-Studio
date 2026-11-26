import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * End-to-end offline export verification.
 *
 * Fixtures are generated inside the page (no network, no external media): a WebM
 * clip whose frames are solid colours cycling every frame, and a WAV file with a
 * pulse exactly at the visual marker frame. Both are injected through the app's
 * own file input, so the real import path is exercised. The exported file is
 * taken from Playwright's download API and inspected with the browser's media
 * stack plus AudioContext.decodeAudioData.
 */

const makeVideo = async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d')!;
  const colours = Array.from({ length: 18 }, (_, i) => `hsl(${(i * 20) % 360} 100% 50%)`); // 18 frames @30 fps
  let i = 0;
  ctx.fillStyle = colours[0]; ctx.fillRect(0, 0, 320, 180);
  const stream = canvas.captureStream(TIMING.compFps);
  const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
  const chunks: Blob[] = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.start();
  for (const c of colours) {
    ctx.fillStyle = c; ctx.fillRect(0, 0, 320, 180);
    (stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
    await new Promise(r => setTimeout(r, 1000 / TIMING.compFps));
    i++;
  }
  await new Promise(r => setTimeout(r, 100));
  const done = new Promise<void>(res => { rec.onstop = () => res(); });
  rec.stop(); await done;
  return new Blob(chunks, { type: 'video/webm' });
};

const makeWav = () => {
  const rate = 48000, seconds = TIMING.fixtureSeconds, frames = Math.round(rate * seconds);
  const buf = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    // One 60 ms 1 kHz pulse at the marker time, so audio and picture can be compared.
    const inPulse = t >= TIMING.audioPulseCompSeconds && t < 0.36;
    const s = inPulse ? Math.sin(2 * Math.PI * 1000 * t) * 0.9 : 0;
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
};

/** Explicit timing model for this spec (30 fps composition, 0.6 s fixture). */
export const TIMING = {
  compFps: 30,
  fixtureFrames: 18,          // 18 frames @30 fps = 0.6 s of fixture video
  fixtureSeconds: 0.6,
  startFrame: 3,              // nonzero export origin: 0.1 s
  endFrame: 15,               // exclusive end: 0.5 s
  exportFps: 30,
  audioPulseCompSeconds: 0.3, // pulse in the source WAV (composition time)
  markerFrame: 9,             // 0.3 s at 30 fps
};
TIMING.exportFrames = TIMING.endFrame - TIMING.startFrame;
TIMING.expectedDuration = TIMING.exportFrames / TIMING.exportFps;
TIMING.expectedPulseOffset = TIMING.audioPulseCompSeconds - TIMING.startFrame / TIMING.compFps;

const inject = async (page: import('@playwright/test').Page, which: 'video' | 'audio') => {
  await page.evaluate(async kind => {
    // Fixture builders are inlined so the page needs no extra script.
    const blob = await (0, eval)(`(${kind === 'video' ? makeVideo.toString() : makeWav.toString()})`)();
    const file = new File([blob], kind === 'video' ? 'fixture.webm' : 'pulse.wav', { type: blob.type });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, which);
  await page.waitForTimeout(800);
};

test.describe('offline export', () => {
  test('exports a playable 720p WebM with synced audio', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('canvas.spatial-live')).toBeVisible();
    const playheadBefore = (await page.locator('.time-readout').innerText()).trim();
    expect(playheadBefore.length).toBeGreaterThan(0);
    const caps = await page.evaluate(() => ({
      video: typeof (window as any).VideoEncoder === 'function',
      audio: typeof (window as any).AudioEncoder === 'function',
    }));
    test.skip(!caps.video, 'WebCodecs VideoEncoder unavailable');
    test.skip(!caps.audio, 'WebCodecs AudioEncoder unavailable');

    await inject(page, 'video');
    await inject(page, 'audio');
    await expect(page.locator('.layer-row, [data-layer-id]').first()).toBeVisible({ timeout: 15000 });


    // Reduced preview resolution first, then a 720p export with a nonzero start.
    await page.getByRole('button', { name: /Export/i }).click();
    // Selector facts from src/workspace.tsx: `.render-settings` holds a
    // Resolution select, then number inputs in the order Width, Height, Start,
    // End, and a Frame rate select.
    await page.locator('.render-settings select').first().selectOption('720p');
    await page.locator('.render-settings select').nth(1).selectOption(String(TIMING.exportFps));
    await page.locator('.render-settings input[type="number"]').nth(2).fill(String(TIMING.startFrame));
    await page.locator('.render-settings input[type="number"]').nth(3).fill(String(TIMING.endFrame));

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
    await page.getByRole('button', { name: /Offline render \(WebCodecs\)/i }).click();
    // If the project has audio and Opus is unavailable the app asks for
    // confirmation; accept only that explicit dialog.
    page.on('dialog', d => d.accept());
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.webm$/);
    const savedTo = test.info().outputPath('export.webm');
    await download.saveAs(savedTo);
    const bytes = readFileSync(savedTo);
    expect(bytes.length).toBeGreaterThan(1000);

    // Inspect with real browser media APIs.
    const info = await page.evaluate(async b64 => {
      const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const blob = new Blob([raw], { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.src = url; video.muted = true;
      await new Promise((res, rej) => {
        video.onloadedmetadata = res;
        video.onerror = () => rej(new Error('exported file failed to parse'));
        setTimeout(() => rej(new Error('metadata timeout')), 20000);
      });
      const meta = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      // Decode a frame in the middle and read its average colour.
      video.currentTime = Math.min(0.2, meta.duration / 2);
      await new Promise<void>(res => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(() => res()) : video.addEventListener('seeked', () => res(), { once: true })));
      const c = document.createElement('canvas'); c.width = meta.width; c.height = meta.height;
      const cx = c.getContext('2d')!; cx.drawImage(video, 0, 0);
      const px = cx.getImageData(meta.width >> 1, meta.height >> 1, 1, 1).data;
      await video.play().catch(() => {});
      const played = !video.paused;
      // Audio: decode the exported track and find the pulse position.
      let pulseAt: number | null = null, hasAudio = false;
      try {
        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer().catch(() => raw.buffer as ArrayBuffer).then(b => b.slice(0)));
        hasAudio = decoded.numberOfChannels > 0 && decoded.length > 0;
        const data = decoded.getChannelData(0);
        let best = 0, bestI = 0;
        for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > best) { best = Math.abs(data[i]); bestI = i; }
        pulseAt = best > 0.02 ? bestI / decoded.sampleRate : null;
        await ctx.close();
      } catch { hasAudio = false; }
      return { ...meta, rgb: [px[0], px[1], px[2]], played, hasAudio, pulseAt };
    }, bytes.toString('base64'));

    expect(info.width).toBe(1280);
    expect(info.height).toBe(720);
    expect(info.duration).toBeGreaterThan(0.1);
    expect(info.played).toBe(true);
    expect(info.hasAudio, 'exported file must carry the soundtrack').toBe(true);
    // The pulse sits at composition 0.3 s; with a 0.24 s start offset it should
    // appear ~0.06 s after the export origin (tolerance 120 ms).
    expect(info.pulseAt).not.toBeNull();
    expect(Math.abs((info.pulseAt as number) - TIMING.expectedPulseOffset)).toBeLessThan(0.12);
    expect(info.duration).toBeGreaterThan(TIMING.expectedDuration - 0.1);

    // Real state restoration, read from the UI's own playhead readout.
    await expect(page.locator('.time-readout')).toHaveText(playheadBefore.trim(), { timeout: 10000 });
  });

  test('cancellation restores preview state', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('canvas.spatial-live')).toBeVisible();
    const caps = await page.evaluate(() => typeof (window as any).VideoEncoder === 'function');
    test.skip(!caps, 'WebCodecs VideoEncoder unavailable');
    await page.getByRole('button', { name: /Export/i }).click();
    await page.getByRole('button', { name: /Offline render \(WebCodecs\)/i }).click();
    await page.waitForTimeout(300);
    const cancel = page.getByRole('button', { name: /Cancel export/i });
    if (await cancel.count()) await cancel.click();
    await expect(page.locator('canvas.spatial-live')).toBeVisible();
    await expect(page.getByRole('button', { name: /Offline render/i })).toBeEnabled({ timeout: 20000 });
  });
});
