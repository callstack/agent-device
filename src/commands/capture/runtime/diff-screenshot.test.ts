import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from '../../../utils/png.ts';
import { test } from 'vitest';
import type {
  AgentDeviceBackend,
  BackendScreenshotOptions,
  BackendScreenshotResult,
} from '../../../backend.ts';
import { createLocalArtifactAdapter } from '../../../io.ts';
import {
  createAgentDevice,
  localCommandPolicy,
  type CommandSessionStore,
} from '../../../runtime.ts';

const sessions = {
  get: () => undefined,
  set: () => {},
} satisfies CommandSessionStore;

test('runtime diff screenshot captures live current image and cleans temporary capture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-diff-screenshot-'));
  const baseline = path.join(dir, 'baseline.png');
  const diffOut = path.join(dir, 'diff.png');
  let capturedCurrentPath: string | undefined;
  let capturedOptions: BackendScreenshotOptions | undefined;

  fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 0, g: 0, b: 0 }));

  try {
    const device = createAgentDevice({
      backend: createScreenshotBackend((outPath, options) => {
        capturedCurrentPath = outPath;
        capturedOptions = options;
        fs.writeFileSync(outPath, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));
        return { path: outPath };
      }),
      artifacts: createLocalArtifactAdapter(),
      sessions,
      policy: localCommandPolicy(),
    });

    const result = await device.capture.diffScreenshot({
      baseline: { kind: 'path', path: baseline },
      current: { kind: 'live' },
      out: { kind: 'path', path: diffOut },
      threshold: 0,
      surface: 'menubar',
    });

    assert.equal(result.match, false);
    assert.equal(result.differentPixels, 100);
    assert.equal(result.diffPath, diffOut);
    assert.equal(fs.existsSync(diffOut), true);
    assert.equal(typeof capturedCurrentPath, 'string');
    assert.equal(fs.existsSync(capturedCurrentPath!), false);
    assert.equal(capturedOptions?.surface, 'menubar');
    assert.equal(capturedOptions?.normalizeStatusBar, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime diff screenshot compares supplied current image without backend capture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-diff-screenshot-'));
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 0, g: 0, b: 0 }));
  fs.writeFileSync(current, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));

  try {
    const device = createAgentDevice({
      backend: createScreenshotBackend(() => {
        throw new Error('capture should not be called');
      }),
      artifacts: createLocalArtifactAdapter(),
      sessions,
      policy: localCommandPolicy(),
    });

    const result = await device.capture.diffScreenshot({
      baseline: { kind: 'path', path: baseline },
      current: { kind: 'path', path: current },
      threshold: 0,
    });

    assert.equal(result.match, false);
    assert.equal(result.differentPixels, 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime diff screenshot rejects overlay refs with supplied current image', async () => {
  const device = createAgentDevice({
    backend: createScreenshotBackend(() => {
      throw new Error('capture should not be called');
    }),
    artifacts: createLocalArtifactAdapter(),
    sessions,
    policy: localCommandPolicy(),
  });

  await assert.rejects(
    () =>
      device.capture.diffScreenshot({
        baseline: { kind: 'path', path: '/tmp/baseline.png' },
        current: { kind: 'path', path: '/tmp/current.png' },
        overlayRefs: true,
      }),
    /saved-image comparisons have no live accessibility refs/,
  );
});

test('runtime diff screenshot enforces max image pixels policy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-diff-screenshot-'));
  const baseline = path.join(dir, 'baseline.png');
  const current = path.join(dir, 'current.png');
  fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 0, g: 0, b: 0 }));
  fs.writeFileSync(current, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));

  try {
    const device = createAgentDevice({
      backend: createScreenshotBackend(() => {
        throw new Error('capture should not be called');
      }),
      artifacts: createLocalArtifactAdapter(),
      sessions,
      policy: localCommandPolicy({ maxImagePixels: 50 }),
    });

    await assert.rejects(
      () =>
        device.capture.diffScreenshot({
          baseline: { kind: 'path', path: baseline },
          current: { kind: 'path', path: current },
        }),
      /maxImagePixels/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime diff screenshot attaches overlay refs to live mismatch regions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-diff-screenshot-'));
  const baseline = path.join(dir, 'baseline.png');
  const diffOut = path.join(dir, 'diff.png');
  const overlayOut = path.join(dir, 'diff.current-overlay.png');
  fs.writeFileSync(baseline, solidPngBuffer(10, 10, { r: 0, g: 0, b: 0 }));

  try {
    const device = createAgentDevice({
      backend: createScreenshotBackend((outPath, options) => {
        fs.writeFileSync(outPath, solidPngBuffer(10, 10, { r: 255, g: 255, b: 255 }));
        return {
          path: outPath,
          ...(options?.overlayRefs
            ? {
                overlayRefs: [
                  {
                    ref: 'e1',
                    label: 'Continue',
                    rect: { x: 1, y: 2, width: 3, height: 4 },
                    overlayRect: { x: 1, y: 2, width: 3, height: 4 },
                    center: { x: 3, y: 4 },
                  },
                ],
              }
            : {}),
        };
      }),
      artifacts: createLocalArtifactAdapter(),
      sessions,
      policy: localCommandPolicy(),
    });

    const result = await device.capture.diffScreenshot({
      baseline: { kind: 'path', path: baseline },
      current: { kind: 'live' },
      out: { kind: 'path', path: diffOut },
      threshold: 0,
      overlayRefs: true,
    });

    assert.equal(result.currentOverlayPath, overlayOut);
    assert.equal(result.currentOverlayRefCount, 1);
    assert.equal(fs.existsSync(overlayOut), true);
    assert.equal(result.regions?.[0]?.currentOverlayMatches?.[0]?.ref, 'e1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createScreenshotBackend(
  captureScreenshot: (
    outPath: string,
    options?: BackendScreenshotOptions,
  ) => BackendScreenshotResult | void | Promise<BackendScreenshotResult | void>,
): AgentDeviceBackend {
  return {
    platform: 'ios',
    captureScreenshot: async (_context, outPath, options) =>
      await captureScreenshot(outPath, options),
  };
}

function solidPngBuffer(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color.r;
    png.data[i + 1] = color.g;
    png.data[i + 2] = color.b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
