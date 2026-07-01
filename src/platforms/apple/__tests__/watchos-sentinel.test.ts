import { test, expect } from 'vitest';
import { createAppleInteractor } from '../interactor.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import type { RunnerContext } from '../../../core/interactor-types.ts';
import { AppError } from '../../../kernel/errors.ts';

// watchOS is an explicit unsupported sentinel: XCUITest cannot drive watchOS UI,
// so a `appleOs: 'watchos'` device must be rejected at interactor creation (the
// admission seam) rather than silently falling through to the iOS runner.
const watchOsDevice: DeviceInfo = {
  platform: 'ios',
  id: 'watch-1',
  name: 'Apple Watch Series 10',
  kind: 'device',
  appleOs: 'watchos',
};

test('createAppleInteractor rejects a watchOS device as UNSUPPORTED_PLATFORM', () => {
  // The guard throws before touching runnerContext, so an empty context is fine.
  const create = () => createAppleInteractor(watchOsDevice, {} as RunnerContext);
  expect(create).toThrow(AppError);
  try {
    create();
    expect.unreachable('expected createAppleInteractor to throw for watchOS');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('UNSUPPORTED_PLATFORM');
    expect((error as AppError).message).toMatch(/watchOS/i);
  }
});

test('a non-watchOS appleOs does not trigger the watchOS sentinel', () => {
  // A tvOS device must not throw the watchOS-specific rejection. (It may still
  // fail later on the empty runner context, so we only assert it is not the
  // watchOS sentinel error.)
  const tvOsDevice: DeviceInfo = {
    platform: 'ios',
    id: 'tv-1',
    name: 'Apple TV 4K',
    kind: 'simulator',
    target: 'tv',
    appleOs: 'tvos',
    booted: true,
  };
  try {
    createAppleInteractor(tvOsDevice, {} as RunnerContext);
  } catch (error) {
    expect((error as AppError).message ?? '').not.toMatch(/watchOS/i);
  }
});
