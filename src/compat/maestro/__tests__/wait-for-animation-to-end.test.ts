import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { PNG } from '../../../utils/png.ts';
import { waitForMaestroAnimationToEnd } from '../wait-for-animation-to-end.ts';

test('captures an explicit zero-timeout pair and accepts exactly 0.005% RGB difference', async () => {
  const images = [makePng(40, 100), makePng(40, 100, [[0, 153, 0, 0, 0]])];
  let captureCount = 0;
  let tempRoot: string | undefined;

  const stable = await waitForMaestroAnimationToEnd({
    timeoutMs: 0,
    now: () => 0,
    capture: async (screenshotPath) => {
      tempRoot ??= path.dirname(screenshotPath);
      await fs.writeFile(screenshotPath, images[captureCount++]!);
    },
  });

  expect(stable).toBe(true);
  expect(captureCount).toBe(2);
  expect(await exists(tempRoot!)).toBe(false);
});

test('retries changed pairs immediately until a matching pair is captured', async () => {
  let now = 0;
  let captureCount = 0;
  let tempRoot: string | undefined;

  const stable = await waitForMaestroAnimationToEnd({
    timeoutMs: 2,
    now: () => now,
    capture: async (screenshotPath) => {
      tempRoot ??= path.dirname(screenshotPath);
      const attempt = Math.floor(captureCount / 2);
      const changedPixels: readonly PixelDelta[] =
        attempt === 0 && captureCount % 2 === 1
          ? [
              [0, 255, 255, 255, 255],
              [1, 255, 255, 255, 255],
            ]
          : [];
      await fs.writeFile(screenshotPath, makePng(20, 10, changedPixels));
      captureCount += 1;
      if (captureCount % 2 === 0) now += 1;
    },
  });

  expect(stable).toBe(true);
  expect(captureCount).toBe(4);
  expect(await exists(tempRoot!)).toBe(false);
});

test('treats dimension and capture failures as nonmatches before retrying', async () => {
  let now = 0;
  let captureCount = 0;
  let tempRoot: string | undefined;

  const stable = await waitForMaestroAnimationToEnd({
    timeoutMs: 10,
    now: () => now,
    capture: async (screenshotPath) => {
      tempRoot ??= path.dirname(screenshotPath);
      const attempt = Math.floor(captureCount / 2);
      const currentCapture = captureCount;
      captureCount += 1;
      if (captureCount % 2 === 0) now += 1;
      if (attempt === 0) {
        await fs.writeFile(screenshotPath, makePng(currentCapture === 0 ? 2 : 1, 1));
      } else if (attempt === 1 && currentCapture % 2 === 0) {
        throw new Error('capture unavailable');
      } else {
        await fs.writeFile(screenshotPath, makePng(2, 1));
      }
    },
  });

  expect(stable).toBe(true);
  expect(captureCount).toBe(6);
  expect(await exists(tempRoot!)).toBe(false);
});

test('reports an expired deadline when no screenshot pair is stable', async () => {
  let captureCount = 0;

  const stable = await waitForMaestroAnimationToEnd({
    timeoutMs: 0,
    now: () => 0,
    capture: async (screenshotPath) => {
      await fs.writeFile(
        screenshotPath,
        makePng(1, 1, [[0, captureCount++ % 2 === 0 ? 0 : 255, 0, 0]]),
      );
    },
  });

  expect(stable).toBe(false);
  expect(captureCount).toBe(2);
});

test('propagates cancellation and cleans temporary screenshots', async () => {
  const controller = new AbortController();
  let captureCount = 0;
  let tempRoot: string | undefined;

  await expect(
    waitForMaestroAnimationToEnd({
      timeoutMs: 10,
      now: () => 0,
      signal: controller.signal,
      capture: async (screenshotPath) => {
        tempRoot ??= path.dirname(screenshotPath);
        await fs.writeFile(screenshotPath, makePng(1, 1));
        captureCount += 1;
        controller.abort();
      },
    }),
  ).rejects.toMatchObject({ details: { reason: 'request_canceled' } });

  expect(captureCount).toBe(1);
  expect(await exists(tempRoot!)).toBe(false);
});

type PixelDelta = readonly [
  pixel: number,
  red: number,
  green: number,
  blue: number,
  alpha?: number,
];

function makePng(width: number, height: number, deltas: readonly PixelDelta[] = []): Buffer {
  const png = new PNG({ width, height });
  const deltaByPixel = new Map(deltas.map((delta) => [delta[0], delta]));
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * 4;
    const [, red = 0, green = 0, blue = 0, alpha = 255] = deltaByPixel.get(pixel) ?? [];
    png.data[index] = 255 - red;
    png.data[index + 1] = 255 - green;
    png.data[index + 2] = 255 - blue;
    png.data[index + 3] = alpha;
  }
  return PNG.sync.write(png);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
