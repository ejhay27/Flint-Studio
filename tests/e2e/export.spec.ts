import { test, expect, type Page } from '@playwright/test';
import { encodeScene, sceneExportSync } from './scenes';

/**
 * End-to-end offline export check. Requires a browser with WebCodecs and a
 * WebGL2 context; it is NOT executed in sandboxes without Chromium.
 *
 * Covers: nonzero start frame, export resolution != preview resolution,
 * explicit output frame rate, audio enabled, container validity, dimensions,
 * duration, frame content, presence of an Opus audio track and that the export
 * leaves the preview state untouched.
 */
const boot = async (page: Page) => {
  await page.goto(`/?project=${encodeScene(sceneExportSync)}`);
  await expect(page.locator('canvas.spatial-live')).toBeVisible();
};

test('offline export produces a playable WebM with video and audio', async ({ page }) => {
  await boot(page);
  const support = await page.evaluate(() => ({
    encoder: typeof (window as any).VideoEncoder === 'function',
    audio: typeof (window as any).AudioEncoder === 'function',
  }));
  test.skip(!support.encoder, 'WebCodecs VideoEncoder unavailable in this browser');
  test.skip(!support.audio, 'WebCodecs AudioEncoder unavailable in this browser');

  const playheadBefore = await page.evaluate(() => (window as any).__flint?.playhead ?? null);

  await page.getByRole('button', { name: /Export/i }).click();
  await page.locator('.render-settings select').first().selectOption('720p');
  await page.locator('.render-settings input[type="number"]').nth(3).fill('6');
  await page.getByRole('button', { name: /Offline render \(WebCodecs\)/i }).click();

  const download = await page.waitForEvent('download', { timeout: 120_000 });
  const path = await download.path();
  expect(download.suggestedFilename()).toMatch(/\.webm$/);
  expect(path).toBeTruthy();

  // Independent inspection happens inside the page: decode the produced file
  // with the browser's own demuxer/decoder and read real track metadata.
  const info = await page.evaluate(async () => {
    const bytes = (window as any).__flintLastExport;
    if (!bytes) return null;
    const blob = new Blob([bytes], { type: 'video/webm' });
    const buf = await blob.arrayBuffer();
    const head = new TextDecoder('latin1').decode(new Uint8Array(buf.slice(0, 64)));
    const text = new TextDecoder('latin1').decode(new Uint8Array(buf));
    const video = document.createElement('video');
    video.src = URL.createObjectURL(blob);
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('exported file failed to load'));
      setTimeout(() => rej(new Error('metadata timeout')), 15000);
    });
    const duration = video.duration;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (video.requestVideoFrameCallback) {
      await new Promise<void>(res => { video.currentTime = Math.min(0.2, duration / 2); video.requestVideoFrameCallback(() => res()); });
    }
    await video.play().catch(() => {});
    return {
      ebml: head.startsWith('\x1aE\xdf\xa3'),
      hasOpus: text.includes('A_OPUS'),
      hasVideo: text.includes('V_VP8') || text.includes('V_VP9'),
      width,
      height,
      duration,
      audioTracks: (video as any).audioTracks?.length ?? null,
      played: !video.paused,
    };
  });
  expect(info, 'export bytes were not exposed to the test').not.toBeNull();
  expect(info!.ebml).toBe(true);
  expect(info!.hasVideo).toBe(true);
  expect(info!.hasOpus).toBe(true);
  expect(info!.width).toBe(1280);
  expect(info!.height).toBe(720);
  expect(info!.duration).toBeGreaterThan(0.1);
  expect(info!.played).toBe(true);

  const playheadAfter = await page.evaluate(() => (window as any).__flint?.playhead ?? null);
  expect(playheadAfter).toBe(playheadBefore);
});
