import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { createUnsupportedInteractor } from '../unsupported-interactor.ts';

const OPERATIONS = [
  'open',
  'openDevice',
  'close',
  'tap',
  'doubleTap',
  'longPress',
  'focus',
  'type',
  'fill',
  'scroll',
  'screenshot',
  'snapshot',
  'back',
  'home',
  'setOrientation',
  'appSwitcher',
  'tvRemote',
  'readClipboard',
  'writeClipboard',
  'setSetting',
  'readAlert',
  'awaitAlert',
  'acceptAlert',
  'dismissAlert',
] as const;

test('every operation rejects as unsupported and names the platform', async () => {
  const interactor = createUnsupportedInteractor('Vega OS');

  for (const operation of OPERATIONS) {
    const call = interactor[operation] as () => Promise<unknown>;
    await expectUnsupported(call, operation, 'Vega OS');
  }
});

test('the label is per-instance, so two platforms reject with their own wording', async () => {
  const web = createUnsupportedInteractor('web').home as () => Promise<unknown>;
  const vega = createUnsupportedInteractor('Vega OS').home as () => Promise<unknown>;

  await expectUnsupported(web, 'home', 'web');
  await expectUnsupported(vega, 'home', 'Vega OS');
});

test('the factory covers the whole interactor surface', () => {
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
