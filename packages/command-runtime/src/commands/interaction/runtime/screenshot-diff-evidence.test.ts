import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PNG } from '@agent-device/capture-kit/png';
import { test } from 'vitest';
import type { BackendScreenshotOptions } from '@agent-device/contracts/backend';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { ref } from './selector-read-utils.ts';
import { createInteractionDevice, selectorSnapshot } from './__tests__/test-utils/index.ts';

// `--expect-screenshot-diff` (#press-expect): the out-of-tree readback for the
// surfaces --verify cannot answer for — a PIN keypad whose keys never reach the
// accessibility tree digests identically whether or not the digit was entered,
// so the pair compares pixels instead of nodes.

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

type FramePlan = Array<{ bytes: Buffer; options?: BackendScreenshotOptions }>;

function framePlanBackend(frames: FramePlan) {
  let frameIndex = 0;
  const captured: BackendScreenshotOptions[] = [];
  return {
    captured,
    captureScreenshot: async (
      _context: unknown,
      outPath: string,
      options?: BackendScreenshotOptions,
    ) => {
      const frame = frames[Math.min(frameIndex, frames.length - 1)];
      frameIndex += 1;
      if (options) captured.push(options);
      assert.ok(frame, 'the frame plan must cover every capture the pair takes');
      fs.writeFileSync(outPath, frame.bytes);
      return { path: outPath };
    },
  };
}

test('press with expectScreenshotDiff brackets the dispatch and reports a changed screen', async () => {
  const backend = framePlanBackend([
    { bytes: solidPngBuffer(8, 8, { r: 0, g: 0, b: 0 }) },
    { bytes: solidPngBuffer(8, 8, { r: 255, g: 255, b: 255 }) },
  ]);
  const taps: Array<{ x: number; y: number }> = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    ...backend,
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 10, y: 20 },
    {
      session: 'default',
      expectScreenshotDiff: true,
    },
  );

  assert.deepEqual(taps, [{ x: 10, y: 20 }]);
  assert.ok(result.screenshotDiff);
  assert.equal(result.screenshotDiff?.changedFromBefore, true);
  assert.equal(result.screenshotDiff?.changedPixelRatio, 1);
  assert.equal('warning' in result ? result.warning : undefined, undefined);
  // The status-bar clock must not read as the reaction the caller asked about.
  assert.deepEqual(backend.captured, [{ normalizeStatusBar: true }, { normalizeStatusBar: true }]);
});

test('press with expectScreenshotDiff warns when the frames match', async () => {
  const backend = framePlanBackend([
    { bytes: solidPngBuffer(8, 8, { r: 0, g: 0, b: 0 }) },
    { bytes: solidPngBuffer(8, 8, { r: 0, g: 0, b: 0 }) },
  ]);
  const device = createInteractionDevice(selectorSnapshot(), {
    ...backend,
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 10, y: 20 },
    {
      session: 'default',
      expectScreenshotDiff: true,
    },
  );

  assert.ok(result.screenshotDiff);
  assert.equal(result.screenshotDiff?.changedFromBefore, false);
  assert.equal(result.screenshotDiff?.changedPixelRatio, 0);
  // The silent no-op must not read as success: the response says so next to
  // the evidence, and the action itself still succeeds.
  assert.match(
    ('warning' in result ? result.warning : undefined) ?? '',
    /may have had no visible effect/,
  );
});

test('press with expectScreenshotDiff keeps a resolution warning beside its own', async () => {
  const backend = framePlanBackend([
    { bytes: solidPngBuffer(8, 8, { r: 0, g: 0, b: 0 }) },
    { bytes: solidPngBuffer(8, 8, { r: 0, g: 0, b: 0 }) },
  ]);
  // A point outside the viewport the stored tree captured earns the
  // outside-viewport warning; the pair warning composes after it.
  const viewportSnapshot = makeSnapshotState([
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      hittable: true,
    },
  ]);
  const device = createInteractionDevice(viewportSnapshot, {
    ...backend,
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 100000, y: 100000 },
    {
      session: 'default',
      expectScreenshotDiff: true,
    },
  );

  const warning = 'warning' in result ? result.warning : undefined;
  assert.match(warning ?? '', /outside the last-known viewport/);
  assert.match(warning ?? '', /may have had no visible effect/);
});

test('press with expectScreenshotDiff reports a shape change without a ratio', async () => {
  const backend = framePlanBackend([
    { bytes: solidPngBuffer(8, 8, { r: 0, g: 0, b: 0 }) },
    { bytes: solidPngBuffer(4, 16, { r: 0, g: 0, b: 0 }) },
  ]);
  const device = createInteractionDevice(selectorSnapshot(), {
    ...backend,
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 10, y: 20 },
    {
      session: 'default',
      expectScreenshotDiff: true,
    },
  );

  assert.ok(result.screenshotDiff);
  assert.equal(result.screenshotDiff?.changedFromBefore, true);
  assert.equal(result.screenshotDiff?.changedPixelRatio, undefined);
  assert.equal('warning' in result ? result.warning : undefined, undefined);
});

test('press with expectScreenshotDiff drops the evidence when a capture fails', async () => {
  let captureCount = 0;
  const taps: Array<{ x: number; y: number }> = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    captureScreenshot: async () => {
      captureCount += 1;
      if (captureCount === 1) throw new Error('screen capture unavailable');
      return { path: '/unused/after.png' };
    },
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 10, y: 20 },
    {
      session: 'default',
      expectScreenshotDiff: true,
    },
  );

  // No pair, no claim — the tap still crossed, and the readback says nothing.
  assert.equal('screenshotDiff' in result, false);
  assert.equal('warning' in result ? result.warning : undefined, undefined);
  assert.deepEqual(captureCount, 1);
  assert.deepEqual(taps, [{ x: 10, y: 20 }]);
});

test('press without a screenshot backend drops the evidence and still taps', async () => {
  const taps: Array<{ x: number; y: number }> = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 10, y: 20 },
    {
      session: 'default',
      expectScreenshotDiff: true,
    },
  );

  assert.deepEqual(taps, [{ x: 10, y: 20 }]);
  assert.equal('screenshotDiff' in result, false);
});

test('press with expectScreenshotDiff routes a ref target through the runtime path', async () => {
  const backend = framePlanBackend([
    { bytes: solidPngBuffer(8, 8, { r: 0, g: 0, b: 0 }) },
    { bytes: solidPngBuffer(8, 8, { r: 255, g: 255, b: 255 }) },
  ]);
  const refTaps: string[] = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    ...backend,
    platform: 'web',
    tapTarget: async (_context, target) => {
      refTaps.push(target.ref);
      return { ref: target.ref.replace(/^@/, '') };
    },
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(ref('@e1'), {
    session: 'default',
    expectScreenshotDiff: true,
  });

  // The native ref fast path would skip the pair entirely; the flag forces the
  // runtime path so the readback brackets the dispatch it names.
  assert.deepEqual(refTaps, []);
  assert.ok(result.screenshotDiff);
  assert.equal(result.screenshotDiff?.changedFromBefore, true);
});

test('a corrupted after-frame yields no evidence instead of failing a delivered tap', async () => {
  const corrupted = Buffer.from('not a png at all');
  const backend = framePlanBackend([
    { bytes: solidPngBuffer(8, 8, { r: 0, g: 0, b: 0 }) },
    { bytes: corrupted },
  ]);
  const taps: Array<{ x: number; y: number }> = [];
  const device = createInteractionDevice(selectorSnapshot(), {
    ...backend,
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.press(
    { kind: 'point', x: 10, y: 20 },
    { session: 'default', expectScreenshotDiff: true },
  );

  // The tap crossed the device; the unreadable readback claims nothing.
  assert.equal(taps.length, 1);
  assert.equal(result.screenshotDiff, undefined);
  assert.equal(result.warning, undefined);
});
