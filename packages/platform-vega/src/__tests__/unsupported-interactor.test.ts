import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { createUnsupportedInteractor } from '../unsupported-interactor.ts';

const OPERATIONS = [
  'open',
  'openDevice',
  'close',
  'tap',
  'longPress',
  'focus',
  'type',
  'fill',
  'scroll',
  'screenshot',
  'snapshot',
  'back',
  'setOrientation',
  'tvRemote',
  'readClipboard',
  'writeClipboard',
  'setSetting',
] as const;

test('every operation rejects as unsupported and names the platform', async () => {
  const interactor = createUnsupportedInteractor('Vega OS');

  for (const operation of OPERATIONS) {
    const call = interactor[operation] as () => Promise<unknown>;
    await expectUnsupported(call, operation, 'Vega OS');
  }
});

test('the label is per-instance, so two platforms reject with their own wording', async () => {
  const web = createUnsupportedInteractor('web').setSetting as () => Promise<unknown>;
  const vega = createUnsupportedInteractor('Vega OS').setSetting as () => Promise<unknown>;

  await expectUnsupported(web, 'setSetting', 'web');
  await expectUnsupported(vega, 'setSetting', 'Vega OS');
});

// The system buttons ride fact-gated binders: web's cell refuses both, Vega's refuses the
// app switcher, and the system-button binder fails closed if a fact ever admits one anyway.
test('the springboard buttons are left undefined, not denied', () => {
  const interactor = createUnsupportedInteractor('Vega OS');

  assert.equal(interactor.home, undefined);
  assert.equal(interactor.appSwitcher, undefined);
});

test('the factory covers the whole required interactor surface', () => {
  const interactor = createUnsupportedInteractor('Vega OS');

  assert.deepEqual(Object.keys(interactor).sort(), [...OPERATIONS].sort());
});

async function expectUnsupported(
  call: () => Promise<unknown>,
  operation: string,
  platform: string,
): Promise<void> {
  await assert.rejects(
    call,
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.message === `${operation} is not supported on ${platform}`,
  );
}
