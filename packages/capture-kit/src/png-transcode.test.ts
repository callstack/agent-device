import { expect, test } from 'vitest';
import { encode as encodeJpeg } from 'jpeg-js';
import { PNG } from './png.ts';
import { detectScreenshotImageFormat, transcodeScreenshotToPng } from './png-transcode.ts';

function solidRgba(width: number, height: number, rgba: readonly [number, number, number, number]) {
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(rgba, offset);
  return data;
}

/** The value a synchronous call throws, so one assertion can check its code and message together. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

test('a JPEG screenshot becomes a PNG of the same size with the same picture', () => {
  const jpeg = encodeJpeg({ width: 6, height: 4, data: solidRgba(6, 4, [200, 30, 30, 255]) }, 100);
  expect(detectScreenshotImageFormat(jpeg.data)).toBe('jpeg');

  const png = transcodeScreenshotToPng(jpeg.data, 'test screenshot');

  expect(detectScreenshotImageFormat(png)).toBe('png');
  const decoded = PNG.sync.read(png);
  expect([decoded.width, decoded.height]).toEqual([6, 4]);
  const [r = -1, g = -1, b = -1, a = -1] = decoded.data.subarray(0, 4);
  // JPEG is lossy; a flat field survives within a few levels per channel.
  expect(Math.abs(r - 200)).toBeLessThanOrEqual(4);
  expect(Math.abs(g - 30)).toBeLessThanOrEqual(4);
  expect(Math.abs(b - 30)).toBeLessThanOrEqual(4);
  expect(a).toBe(255);
});

test('a PNG screenshot passes through byte for byte', () => {
  const png = PNG.sync.write(new PNG({ width: 3, height: 2 }));

  expect(transcodeScreenshotToPng(png, 'test screenshot')).toBe(png);
});

test('bytes that are neither container are refused with a typed error carrying the label', () => {
  expect(
    thrownBy(() => transcodeScreenshotToPng(Buffer.from('GIF89a'), 'Limrun iOS screenshot')),
  ).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Limrun iOS screenshot is neither PNG nor JPEG',
    details: { label: 'Limrun iOS screenshot', leadingBytes: '47494638' },
  });
});

test('a valid SOI marker followed by garbage is refused with the typed decode error, not the decoder exception', () => {
  const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x41)]);
  expect(detectScreenshotImageFormat(garbage)).toBe('jpeg');

  expect(thrownBy(() => transcodeScreenshotToPng(garbage, 'Limrun iOS screenshot'))).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Failed to decode Limrun iOS screenshot as JPEG',
    details: { label: 'Limrun iOS screenshot', reason: expect.any(String) },
  });
});

test('a truncated JPEG body is refused with the same typed decode error', () => {
  const jpeg = encodeJpeg({ width: 6, height: 4, data: solidRgba(6, 4, [10, 200, 30, 255]) }, 100);
  const truncated = jpeg.data.subarray(0, 24);

  expect(
    thrownBy(() => transcodeScreenshotToPng(truncated, 'Limrun iOS screenshot')),
  ).toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Failed to decode Limrun iOS screenshot as JPEG',
  });
});
