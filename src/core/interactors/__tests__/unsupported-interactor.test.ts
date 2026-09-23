import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { createUnsupportedInteractor } from '../unsupported-interactor.ts';

test('every operation on the factory rejects, naming itself and the platform', async () => {
  const interactor = createUnsupportedInteractor('web');
  const entries = Object.entries(interactor) as [string, () => Promise<unknown>][];

  assert.ok(entries.length > 0, 'the factory exposes operations');

  const failures = await Promise.all(
    entries.map(async ([operation, call]) => {
      try {
        await call();
        return `${operation}: resolved instead of rejecting`;
      } catch (error) {
        if (!(error instanceof AppError)) return `${operation}: threw a non-AppError`;
        if (error.code !== 'UNSUPPORTED_OPERATION') return `${operation}: ${error.code}`;
        if (error.message !== `${operation} is not supported on web`) {
          return `${operation}: ${error.message}`;
        }
        return null;
      }
    }),
  );

  assert.deepEqual(failures.filter(Boolean), []);
});

test('optional operations are left undefined, not denied, so shared dispatch keeps its fallback semantics', () => {
  const interactor = createUnsupportedInteractor('web');

  // A fused double-click has no shared-series stand-in, and the system buttons ride
  // fact-gated binders: an absent member is the owner's absence, a throw would fake one.
  assert.equal(interactor.doubleTap, undefined);
  assert.equal(interactor.home, undefined);
  assert.equal(interactor.appSwitcher, undefined);
});

test('a rejection carries no partial result the caller could mistake for success', async () => {
  const interactor = createUnsupportedInteractor('Linux desktop');

  await assert.rejects(
    async () => await interactor.snapshot(),
    (error: unknown) =>
      error instanceof AppError && error.message.endsWith('supported on Linux desktop'),
  );
});
