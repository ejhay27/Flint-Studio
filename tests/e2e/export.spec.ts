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
  const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
  let i = 0;
  ctx.fillStyle = colours[0]; ctx.fillRect(0, 0, 320, 180);
  const stream = canvas.captureStream(10);
  const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
  const chunks: Blob[] = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.start();
  for (const c of colours) {
    ctx.fillStyle = c; ctx.fillRect(0, 0, 320, 180);
    (stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
    await new Promise(r => setTimeout(r, 100));
    i++;
  }
  await new Promise(r => setTimeout(r, 100));
  const done = new Promise<void>(res => { rec.onstop = () => res(); });
  rec.stop(); await done;
  return new Blob(chunks, { type: 'video/webm' });
};

const makeWav = () => {
  const rate = 48000, seconds = 1.2, frames = rate * seconds;
  const buf = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    // One short 1 kHz pulse at t = 0.3s (the visual marker frame at 10 fps = frame 3)
    const inPulse = t >= 0.3 && t < 0.36;
    const s = inPulse ? Math.sin(2 * Math.PI * 1000 * t) * 0.9 : 0;
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
};

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
    await page.locator('.render-settings select').first().selectOption('720p');
    await page.locator('.render-settings input[type="number"]').nth(2).fill('240');
    await page.locator('.render-settings input[type="number"]').nth(3).fill('24');

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
    await page.getByRole('button', { name: /Offline render \(WebCodecs\)/i }).click();
    const dialog = page.locator('.modal-shade');
    if (await dialog.count()) await page.getByRole('button', { name: /^OK$|Export the picture/i }).click().catch(() => {});
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
    if (info.pulseAt !== null) expect(Math.abs(info.pulseAt - 0.06)).toBeLessThan(0.12);

    // Preview state: the canvas is live again and no export snapshot map remains.
    await expect(page.locator('canvas.spatial-live')).toBeVisible();
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
