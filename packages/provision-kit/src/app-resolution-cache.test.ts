import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createAppResolutionCache } from './app-resolution-cache.ts';

test('app resolution cache returns values until the expiry boundary', () => {
  let nowMs = 1_000;
  const cache = createAppResolutionCache<string>({ ttlMs: 50, nowMs: () => nowMs });
  const scope = { platform: 'android', deviceId: 'device-a' } as const;

  assert.equal(cache.set(scope, 'Maps', 'com.example.maps'), 'com.example.maps');
  assert.equal(cache.get(scope, 'maps'), 'com.example.maps');

  nowMs = 1_049;
  assert.equal(cache.get(scope, 'Maps'), 'com.example.maps');

  nowMs = 1_050;
  assert.equal(cache.get(scope, 'Maps'), undefined);
  assert.equal(cache.get(scope, 'Maps'), undefined);
});

test('app resolution cache clear removes all variants for one device', () => {
  const cache = createAppResolutionCache<string>({ nowMs: () => 0 });
  const mobile = { platform: 'android', deviceId: 'device-a', variant: 'mobile' } as const;
  const tv = { platform: 'android', deviceId: 'device-a', variant: 'tv' } as const;
  const otherDevice = { platform: 'android', deviceId: 'device-b', variant: 'mobile' } as const;
  const otherPlatform = { platform: 'ios', deviceId: 'device-a', variant: 'simulator' } as const;

  cache.set(mobile, 'Maps', 'com.example.mobile.maps');
  cache.set(tv, 'Maps', 'com.example.tv.maps');
  cache.set(otherDevice, 'Maps', 'com.example.other.maps');
  cache.set(otherPlatform, 'Maps', 'com.example.ios.maps');

  cache.clear(mobile);

  assert.equal(cache.get(mobile, 'Maps'), undefined);
  assert.equal(cache.get(tv, 'Maps'), undefined);
  assert.equal(cache.get(otherDevice, 'Maps'), 'com.example.other.maps');
  assert.equal(cache.get(otherPlatform, 'Maps'), 'com.example.ios.maps');
});

test('app resolution cache invalidates before and after an operation', async () => {
  const cache = createAppResolutionCache<string>({ nowMs: () => 0 });
  const scope = { platform: 'ios', deviceId: 'device-a', variant: 'simulator' } as const;

  cache.set(scope, 'Maps', 'com.example.before');

  const result = await cache.invalidateWhile(scope, async () => {
    assert.equal(cache.get(scope, 'Maps'), undefined);
    cache.set(scope, 'Maps', 'com.example.during');
    return 'installed';
  });

  assert.equal(result, 'installed');
  assert.equal(cache.get(scope, 'Maps'), undefined);
});
