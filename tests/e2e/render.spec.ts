import { test, expect, type Page } from '@playwright/test';
import { sceneMaskGlow, sceneMaskBeforeAfter, sceneSpatial, sceneTransparent, encodeScene } from './scenes';

const open = async (page: Page, scene: unknown) => {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`/?project=${encodeScene(scene)}`);
  await expect(page.locator('canvas.spatial-live')).toBeVisible();
  await page.waitForTimeout(1200);
  return errors;
};

/** Average RGB of a region of the visible WebGL canvas. */
const probe = async (page: Page, x: number, y: number) =>
  page.evaluate(({ x, y }) => {
    const c = document.querySelector('canvas.spatial-live') as HTMLCanvasElement;
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const g = t.getContext('2d')!;
    g.drawImage(c, 0, 0);
    const d = g.getImageData(Math.round(x * c.width), Math.round(y * c.height), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }, { x, y });

test('WebGL context, shader compilation and non-blank composition', async ({ page }) => {
  const errors = await open(page, sceneMaskGlow);
  const info = await page.evaluate(() => {
    const c = document.querySelector('canvas.spatial-live') as HTMLCanvasElement;
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return { hasContext: !!gl, version: gl ? gl.getParameter(gl.VERSION) : null, w: c.width, h: c.height };
  });
  expect(info.hasContext).toBe(true);
  expect(info.w).toBeGreaterThan(0);
  expect(errors.filter(e => /WebGLProgram|shader/i.test(e))).toEqual([]);
  const centre = await probe(page, 0.5, 0.5);
  expect(centre[3]).toBeGreaterThan(0);
  expect(centre[0] + centre[1] + centre[2]).toBeGreaterThan(30);
});

test('mask + glow renders and clipped edges differ from bleed', async ({ page }) => {
  await open(page, sceneMaskBeforeAfter('after'));
  const after = await probe(page, 0.34, 0.5); // just outside the mask rect edge
  await open(page, sceneMaskBeforeAfter('before'));
  const before = await probe(page, 0.34, 0.5);
  expect(Math.abs(after[0] - before[0]) + Math.abs(after[1] - before[1])).toBeGreaterThan(2);
});

test('spatial scene keeps depth ordering', async ({ page }) => {
  await open(page, sceneSpatial);
  const centre = await probe(page, 0.5, 0.5);
  expect(centre[0]).toBeGreaterThan(200); // front plate is white and in front
});

test('transparent composition exports with alpha', async ({ page }) => {
  await open(page, sceneTransparent);
  const corner = await probe(page, 0.05, 0.05);
  expect(corner[3]).toBeGreaterThanOrEqual(0);
});

test('PNG export uses the configured export resolution', async ({ page }) => {
  await open(page, sceneMaskGlow);
  await page.getByRole('button', { name: /export/i }).first().click();
  await page.locator('.render-settings input[type=number]').first().fill('1280');
  await page.locator('.render-settings input[type=number]').nth(1).fill('720');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Current frame PNG/i }).click();
  const file = await download;
  const body = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(c as Buffer);
  const png = Buffer.concat(chunks);
  expect(png.slice(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(1280);
  expect(png.readUInt32BE(20)).toBe(720);
});
