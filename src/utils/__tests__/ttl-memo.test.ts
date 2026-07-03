import { expect, test, vi } from 'vitest';

import { createTtlMemo } from '../ttl-memo.ts';

const crossTestMemo = createTtlMemo<string, string>({ ttlMs: 60_000 });

test.sequential('process memo setup clears values after each test: seed', () => {
  crossTestMemo.set('key', 'value');

  expect(crossTestMemo.get('key')).toBe('value');
});

test.sequential('process memo setup clears values after each test: verify', () => {
  expect(crossTestMemo.get('key')).toBeUndefined();
});

test('ttl memo expires entries on read', () => {
  let now = 1_000;
  const memo = createTtlMemo<string, string>({ ttlMs: 5_000, now: () => now });

  memo.set('device', 'ready');
  now += 4_999;
  expect(memo.get('device')).toBe('ready');

  now += 1;
  expect(memo.get('device')).toBeUndefined();
});

test('ttl memo can schedule entry expiry', () => {
  vi.useFakeTimers();
  try {
    const memo = createTtlMemo<string, string>({ ttlMs: 5_000, scheduleExpiry: true });

    memo.set('device', 'ready');
    vi.advanceTimersByTime(4_999);
    expect(memo.get('device')).toBe('ready');

    vi.advanceTimersByTime(1);
    expect(memo.get('device')).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

test('ttl memo delete removes a cached entry', () => {
  const memo = createTtlMemo<string, string>();

  memo.set('tool', 'fingerprint');

  expect(memo.delete('tool')).toBe(true);
  expect(memo.get('tool')).toBeUndefined();
  expect(memo.delete('tool')).toBe(false);
});
