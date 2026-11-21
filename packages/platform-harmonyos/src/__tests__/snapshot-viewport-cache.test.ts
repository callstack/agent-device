import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyHdcRunnerStub, type HarmonyHdcRunnerStub } from '../toolbox.fixtures.ts';

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

let hdc: HarmonyHdcRunnerStub;

beforeEach(() => {
  hdc = createHarmonyHdcRunnerStub();
  layout = TALL_LAYOUT;
  scriptHarmonyLayoutDump();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The layout the device answers the next pull with; tests swap it to change what a dump reports. */
let layout: unknown;

/**
 * Answers the layout pull so the file the transport receives at its local path is the current
 * `layout`, which is what the viewport read parses.
 */
function scriptHarmonyLayoutDump(): void {
  const pull = hdc.run;
  hdc.run = async (device, args, options) => {
    if (args[0] === 'file' && args[1] === 'recv') {
      fs.writeFileSync(String(args[3]), JSON.stringify(layout), 'utf8');
    }
    return await pull(device, args, options);
  };
}

function dumpLayoutCallCount(): number {
  return hdc.calls.filter((call) => call.args.includes('dumpLayout')).length;
}

test('repeated viewport reads within the TTL trigger a single layout dump', async () => {
  const first = await readHarmonyGestureViewport(hdc, DEVICE_A);
  const second = await readHarmonyGestureViewport(hdc, DEVICE_A);

  assert.deepEqual(first, { x: 0, y: 0, width: 1080, height: 2340 });
  assert.deepEqual(second, first);
  assert.equal(dumpLayoutCallCount(), 1);
});

test('viewport cache expires after two seconds without explicit invalidation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);

  await readHarmonyGestureViewport(hdc, DEVICE_A);
  assert.equal(dumpLayoutCallCount(), 1);

  layout = WIDE_LAYOUT;
  await vi.advanceTimersByTimeAsync(2_000);
  const refreshed = await readHarmonyGestureViewport(hdc, DEVICE_A);

  assert.deepEqual(refreshed, { x: 0, y: 0, width: 2340, height: 1080 });
  assert.equal(dumpLayoutCallCount(), 2);
});

test('invalidating the viewport cache forces a fresh layout dump', async () => {
  await readHarmonyGestureViewport(hdc, DEVICE_A);
  assert.equal(dumpLayoutCallCount(), 1);

  layout = WIDE_LAYOUT;
  invalidateHarmonyGestureViewport(DEVICE_A);
  const refreshed = await readHarmonyGestureViewport(hdc, DEVICE_A);

  assert.deepEqual(refreshed, { x: 0, y: 0, width: 2340, height: 1080 });
  assert.equal(dumpLayoutCallCount(), 2);
});

test('viewport cache entries are scoped per device id', async () => {
  await readHarmonyGestureViewport(hdc, DEVICE_A);

  const otherDevice = await readHarmonyGestureViewport(hdc, DEVICE_B);

  assert.deepEqual(otherDevice, { x: 0, y: 0, width: 1080, height: 2340 });
  assert.equal(dumpLayoutCallCount(), 2);
});
