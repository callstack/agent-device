import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from '@agent-device/capture-kit/png';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { test } from 'vitest';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { createAgentDevice } from '../../../runtime.ts';

test('runtime screenshot applies scale and forwards the capture rotation', async () => {
  const outPath = path.join(mkdtempForTestSync('runtime-screenshot-command-'), 'scaled.png');
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureScreenshot: async (_context, requestedPath) => {
        fs.writeFileSync(requestedPath, solidPngBuffer(100, 50));
        return { displayRotation: 'landscape-left' };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter({ cwd: process.cwd() }),
    sessions: { get: () => undefined, set: () => {} },
    policy: localCommandPolicy(),
  });

  const result = await device.capture.screenshot({
    out: { kind: 'path', path: outPath },
    scale: 0.5,
  });
  const scaled = PNG.sync.read(fs.readFileSync(outPath));

  assert.deepEqual({ width: scaled.width, height: scaled.height }, { width: 50, height: 25 });
  assert.equal(result.displayRotation, 'landscape-left');
});

test('runtime screenshot scales the already-cropped backend capture', async () => {
  const outPath = path.join(mkdtempForTestSync('runtime-screenshot-crop-order-'), 'cropped.png');
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureScreenshot: async (_context, requestedPath) => {
        const source = solidPngBuffer(100, 50);
        fs.writeFileSync(
          requestedPath,
          cropPngBuffer(source, { x: 10, y: 10, width: 40, height: 20 }),
        );
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter({ cwd: process.cwd() }),
    sessions: { get: () => undefined, set: () => {} },
    policy: localCommandPolicy(),
  });

  fs.writeFileSync(outPath, solidPngBuffer(100, 50));
  await device.capture.screenshot({
    out: { kind: 'path', path: outPath },
    scale: 0.5,
  });
  const scaledCrop = PNG.sync.read(fs.readFileSync(outPath));

  assert.deepEqual(
    { width: scaledCrop.width, height: scaledCrop.height },
    { width: 20, height: 10 },
  );
});

function solidPngBuffer(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255;
  return PNG.sync.write(png);
}

function cropPngBuffer(
  source: Buffer,
  crop: Readonly<{ x: number; y: number; width: number; height: number }>,
): Buffer {
  const image = PNG.sync.read(source);
  const cropped = new PNG({ width: crop.width, height: crop.height });
  for (let row = 0; row < crop.height; row += 1) {
    const sourceStart = ((crop.y + row) * image.width + crop.x) * 4;
    const targetStart = row * crop.width * 4;
    image.data.copy(cropped.data, targetStart, sourceStart, sourceStart + crop.width * 4);
  }
  return PNG.sync.write(cropped);
}

for (const staged of [false, true]) {
  test(`late cancellation ${staged ? 'refuses staged publication' : 'retains direct screenshot success'}`, async () => {
    const root = mkdtempForTestSync('screenshot-late-cancellation');
    const destination = path.join(root, 'output.png');
    const staging = path.join(root, 'work.png');
    const sentinel = Buffer.from('old screenshot');
    fs.writeFileSync(destination, sentinel);
    const controller = new AbortController();
    const cancellation = new Error('caller cancelled after capture');
    const adapter = createLocalArtifactAdapter({ cwd: process.cwd() });
    let publications = 0;
    let cleanups = 0;
    if (staged) {
      adapter.reserveOutput = async () => ({
        path: staging,
        publishedPath: destination,
        visibility: 'client-visible',
        publish: async () => {
          publications += 1;
          fs.renameSync(staging, destination);
          return undefined;
        },
        cleanup: async () => {
          cleanups += 1;
          fs.rmSync(staging, { force: true });
        },
      });
    }
    const device = createAgentDevice({
      backend: {
        platform: 'ios',
        captureScreenshot: async (_context, requestedPath) => {
          fs.writeFileSync(requestedPath, solidPngBuffer(8, 8));
          controller.abort(cancellation);
        },
      },
      artifacts: adapter,
      sessions: { get: () => undefined, set: () => {} },
      policy: localCommandPolicy(),
    });
    const operation = device.capture.screenshot({
      out: { kind: 'path', path: destination },
      scale: 0.5,
      signal: controller.signal,
    });
    if (staged) {
      await assert.rejects(operation, (error) => error === cancellation);
      assert.deepEqual(fs.readFileSync(destination), sentinel);
      assert.equal(fs.existsSync(staging), false);
      assert.equal(publications, 0);
      assert.equal(cleanups, 1);
    } else {
      const result = await operation;
      assert.equal(result.path, destination);
      const image = PNG.sync.read(fs.readFileSync(destination));
      assert.deepEqual({ width: image.width, height: image.height }, { width: 4, height: 4 });
    }
  });
}
