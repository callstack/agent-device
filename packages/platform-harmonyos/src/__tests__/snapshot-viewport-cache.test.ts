import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { runHarmonyHdc } = vi.hoisted(() => ({ runHarmonyHdc: vi.fn() }));

vi.mock('../hdc.ts', () => ({ runHarmonyHdc }));

import { invalidateHarmonyGestureViewport, readHarmonyGestureViewport } from '../snapshot.ts';

const DEVICE_A: DeviceInfo = {
  platform: 'harmonyos',
  id: 'harmony-viewport-a',
  name: 'HarmonyOS test device A',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

const DEVICE_B: DeviceInfo = { ...DEVICE_A, id: 'harmony-viewport-b' };

const TALL_LAYOUT = {
  attributes: { type: 'root', bounds: '[0,0][1080,2340]' },
};

const WIDE_LAYOUT = {
  attributes: { type: 'root', bounds: '[0,0][2340,1080]' },
};

beforeEach(() => {
  runHarmonyHdc.mockReset();
  scriptHarmonyLayoutDump(TALL_LAYOUT);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Scripts `uitest dumpLayout` + `file recv` so the pulled layout is `layout`. */
function scriptHarmonyLayoutDump(layout: unknown): void {
  runHarmonyHdc.mockImplementation(async (_device: unknown, args: string[]) => {
    if (args[0] === 'file' && args[1] === 'recv') {
      fs.writeFileSync(args[3] as string, JSON.stringify(layout), 'utf8');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

function dumpLayoutCallCount(): number {
  return runHarmonyHdc.mock.calls.filter(([, args]) => args.includes('dumpLayout')).length;
}

test('repeated viewport reads within the TTL trigger a single layout dump', async () => {
  const first = await readHarmonyGestureViewport(DEVICE_A);
  const second = await readHarmonyGestureViewport(DEVICE_A);

  assert.deepEqual(first, { x: 0, y: 0, width: 1080, height: 2340 });
  assert.deepEqual(second, first);
  assert.equal(dumpLayoutCallCount(), 1);
});

test('viewport cache expires after two seconds without explicit invalidation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);

  await readHarmonyGestureViewport(DEVICE_A);
  assert.equal(dumpLayoutCallCount(), 1);

  scriptHarmonyLayoutDump(WIDE_LAYOUT);
  await vi.advanceTimersByTimeAsync(2_000);
  const refreshed = await readHarmonyGestureViewport(DEVICE_A);

  assert.deepEqual(refreshed, { x: 0, y: 0, width: 2340, height: 1080 });
  assert.equal(dumpLayoutCallCount(), 2);
});

test('invalidating the viewport cache forces a fresh layout dump', async () => {
  await readHarmonyGestureViewport(DEVICE_A);
  assert.equal(dumpLayoutCallCount(), 1);

  scriptHarmonyLayoutDump(WIDE_LAYOUT);
  invalidateHarmonyGestureViewport(DEVICE_A);
  const refreshed = await readHarmonyGestureViewport(DEVICE_A);

  assert.deepEqual(refreshed, { x: 0, y: 0, width: 2340, height: 1080 });
  assert.equal(dumpLayoutCallCount(), 2);
});

test('viewport cache entries are scoped per device id', async () => {
  await readHarmonyGestureViewport(DEVICE_A);

  const otherDevice = await readHarmonyGestureViewport(DEVICE_B);

  assert.deepEqual(otherDevice, { x: 0, y: 0, width: 1080, height: 2340 });
  assert.equal(dumpLayoutCallCount(), 2);
});
