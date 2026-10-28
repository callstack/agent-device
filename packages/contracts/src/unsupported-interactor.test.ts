import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createUnsupportedInteractor } from './unsupported-interactor.ts';

// The stub's members are what a composing platform does NOT override, so each platform's own
// interactor test proves its own list through its composed interactor. This is the factory's
// behaviour shared by every owner that composes it: one platform-side copy of each case would
// assert the shared production module twice without adding an owner.
const REQUIRED_OPERATIONS = [
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
  'setSetting',
] as const;

test('the factory covers the whole required interactor surface', () => {
  const interactor = createUnsupportedInteractor('Vega OS');

  assert.deepEqual(Object.keys(interactor).sort(), [...REQUIRED_OPERATIONS].sort());
});

test('every required operation rejects as unsupported and names itself and the platform', async () => {
  const interactor = createUnsupportedInteractor('web');

  for (const operation of REQUIRED_OPERATIONS) {
    const call = interactor[operation] as () => Promise<unknown>;
    await expectUnsupported(call, operation, 'web');
  }
});

test('the label is per-instance, so two owners refuse with their own wording', async () => {
  const web = createUnsupportedInteractor('web').setSetting as () => Promise<unknown>;
  const vega = createUnsupportedInteractor('Vega OS').setSetting as () => Promise<unknown>;

  await expectUnsupported(web, 'setSetting', 'web');
  await expectUnsupported(vega, 'setSetting', 'Vega OS');
});

// A fused double-click has no shared-series stand-in, the system buttons ride fact-gated binders,
// and neither the clipboard nor a TV remote has a shared fallback either: an absent member is the
// owner's absence, a throw would fake one. The web and Vega fact sets refuse these operations, so
// their binders must never resolve a member this stub carries.
test('operations with no shared fallback are left undefined, not denied', () => {
  const interactor = createUnsupportedInteractor('Vega OS');

  assert.equal(interactor.doubleTap, undefined);
  assert.equal(interactor.home, undefined);
  assert.equal(interactor.appSwitcher, undefined);
  assert.equal(interactor.readClipboard, undefined);
  assert.equal(interactor.writeClipboard, undefined);
  assert.equal(interactor.tvRemote, undefined);
});

test('a refusal carries no partial result the caller could mistake for success', async () => {
  const interactor = createUnsupportedInteractor('Linux desktop');

  await assert.rejects(
    async () => await interactor.snapshot(),
    (error: unknown) =>
      error instanceof AppError && error.message.endsWith('supported on Linux desktop'),
  );
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
