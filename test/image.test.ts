import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { processScreenshot, readPngDimensions, validateScreenshotOptions } from '../src/image.ts';

/** Create a synthetic RGBA PNG with distinct colored quadrants for crop/resize tests. */
function makeTestPng(width = 100, height = 80): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = x < width / 2 ? 255 : 20;
      png.data[i + 1] = y < height / 2 ? 200 : 40;
      png.data[i + 2] = (x + y) % 255;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test('validateScreenshotOptions accepts valid options and rejects invalid ones', () => {
  assert.equal(validateScreenshotOptions(undefined), undefined);
  assert.equal(validateScreenshotOptions({ ref: '@e1', padding: 8, maxWidth: 800, format: 'jpeg', quality: 75 }), undefined);
  assert.equal(validateScreenshotOptions({ rect: { x: 0, y: 0, w: 50, h: 40 }, scale: 0.5 }), undefined);

  assert.match(validateScreenshotOptions({ ref: '@e1', rect: { x: 0, y: 0, w: 10, h: 10 } })!, /both ref and rect/);
  assert.match(validateScreenshotOptions({ padding: -1 })!, /padding/);
  assert.match(validateScreenshotOptions({ rect: { x: -1, y: 0, w: 10, h: 10 } })!, /rect/);
  assert.match(validateScreenshotOptions({ rect: { x: 0, y: 0, w: 0, h: 10 } })!, /rect/);
  assert.match(validateScreenshotOptions({ maxWidth: 0 })!, /maxWidth/);
  assert.match(validateScreenshotOptions({ scale: 1.5 })!, /scale/);
  assert.match(validateScreenshotOptions({ scale: 0 })!, /scale/);
  assert.match(validateScreenshotOptions({ quality: 0 })!, /quality/);
  assert.match(validateScreenshotOptions({ format: 'webp' as 'png' })!, /format/);
});

test('processScreenshot returns original buffer untouched when no transform is requested', () => {
  const raw = Buffer.from('not-a-png');
  const res = processScreenshot(raw);
  assert.equal(res.buffer, raw);
  assert.equal(res.mimeType, 'image/png');
});

test('processScreenshot crops to rect with padding and clamps to image bounds', () => {
  const png = makeTestPng(100, 80);
  const res = processScreenshot(png, { rect: { x: 10, y: 20, w: 30, h: 25 }, padding: 15 });
  assert.equal(res.mimeType, 'image/png');
  // x: max(0, 10-15)=0 .. min(100, 10+30+15)=55 -> 55
  // y: max(0, 20-15)=5 .. min(80, 20+25+15)=60 -> 55
  assert.equal(res.width, 55);
  assert.equal(res.height, 55);
  assert.deepEqual(readPngDimensions(res.buffer), { width: 55, height: 55 });
});

test('processScreenshot throws when crop rect is completely outside image bounds', () => {
  const png = makeTestPng(100, 80);
  assert.throws(() => processScreenshot(png, { rect: { x: 200, y: 200, w: 10, h: 10 } }), /outside captured image/);
});

test('processScreenshot downscales via scale and maxWidth without upscaling', () => {
  const png = makeTestPng(200, 100);
  const scaled = processScreenshot(png, { scale: 0.5 });
  assert.equal(scaled.width, 100);
  assert.equal(scaled.height, 50);

  const capped = processScreenshot(png, { maxWidth: 50 });
  assert.equal(capped.width, 50);
  assert.equal(capped.height, 25);

  const noUpscale = processScreenshot(png, { maxWidth: 500 });
  assert.equal(noUpscale.width, 200);
  assert.equal(noUpscale.height, 100);
});

test('processScreenshot encodes jpeg with smaller byte size than png', () => {
  const png = makeTestPng(200, 160);
  const jpg = processScreenshot(png, { format: 'jpeg', quality: 70 });
  assert.equal(jpg.mimeType, 'image/jpeg');
  assert.equal(jpg.buffer[0], 0xff);
  assert.equal(jpg.buffer[1], 0xd8);
  assert.ok(jpg.buffer.length < png.length, `expected jpeg (${jpg.buffer.length}) < png (${png.length})`);
});
