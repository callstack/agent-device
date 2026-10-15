import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { sampleUntilSettled } from '../sample-until-settled.ts';

beforeEach(() => {
  vi.useFakeTimers({ now: 0, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const OPTIONS = { timeoutMs: 1000, intervalMs: 1 };

test('sampleUntilSettled returns the first sample it accepts', async () => {
  const samples = [1, 2, 3];
  const read = vi.fn(async () => samples.shift() ?? 0);
  assert.equal(await sampleUntilSettled(read, (value) => value === 2, OPTIONS), 2);
  assert.equal(read.mock.calls.length, 2);
});

test('sampleUntilSettled returns the sample taken once the budget has passed', async () => {
  let reads = 0;
  const read = async (remainingMs: number) => {
    reads += 1;
    assert.ok(remainingMs >= 1 && remainingMs <= OPTIONS.timeoutMs);
    vi.setSystemTime(Date.now() + 600);
    return reads;
  };
  assert.equal(await sampleUntilSettled(read, () => false, OPTIONS), 2);
});

test('sampleUntilSettled stops before the next sample once the request is cancelled', async () => {
  const controller = new AbortController();
  const read = vi.fn(async () => {
    controller.abort();
    return 0;
  });
  await assert.rejects(
    sampleUntilSettled(read, () => false, { ...OPTIONS, signal: controller.signal }),
  );
  assert.equal(read.mock.calls.length, 1);
});
