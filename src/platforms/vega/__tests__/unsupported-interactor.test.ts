import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createUnsupportedInteractor } from '../unsupported-interactor.ts';
import { assertRejectsAppError } from '../../../__tests__/test-utils/app-error.ts';

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
    await assertRejectsAppError(async () => await call(), {
      code: 'UNSUPPORTED_OPERATION',
      message: new RegExp(`^${operation} is not supported on Vega OS$`),
    });
  }
});

test('the label is per-instance, so two platforms reject with their own wording', async () => {
  const web = createUnsupportedInteractor('web').home as () => Promise<unknown>;
  const vega = createUnsupportedInteractor('Vega OS').home as () => Promise<unknown>;

  await assertRejectsAppError(async () => await web(), {
    code: 'UNSUPPORTED_OPERATION',
    message: /not supported on web$/,
  });
  await assertRejectsAppError(async () => await vega(), {
    code: 'UNSUPPORTED_OPERATION',
    message: /not supported on Vega OS$/,
  });
});

test('the factory covers the whole interactor surface', () => {
  const interactor = createUnsupportedInteractor('Vega OS');

  assert.deepEqual(Object.keys(interactor).sort(), [...OPERATIONS].sort());
});
