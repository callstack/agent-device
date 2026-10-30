import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createRevylPlatformRuntimeOwner } from './platform-runtime.ts';

const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'revyl:ios:lease-1',
  name: 'Revyl ios run-1',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const OWNER = providerRuntimeOwner('revyl', 'instance');

/** Only the iOS snapshot presenter reaches this owner; the rest of the host stays unused. */
const HOST = {
  snapshot: { presentIosAcquisition: async () => ({ ok: true }) },
} as unknown as PlatformRuntimeHost;

function owner(options: {
  hasLiveSession: boolean;
  interactor?: Interactor;
}): PlatformRuntimeOwner {
  return createRevylPlatformRuntimeOwner({
    host: HOST,
    runtimeInstance: OWNER.instance,
    ownsDevice: () => true,
    hasLiveSession: () => options.hasLiveSession,
    getInteractor: () => options.interactor,
  });
}

async function bind(owner: PlatformRuntimeOwner, device = IOS_DEVICE) {
  return await owner.bind({
    device,
    intent: { kind: 'exact-owner', owner: OWNER },
    scope: { signal: new AbortController().signal },
  } as never);
}

test('an exact-owner bind of a device whose session has ended reports the facts inspectFacts reports', async () => {
  const ownerInstance = owner({ hasLiveSession: false });
  const binding = await bind(ownerInstance);
  // The gate reads the facts, so what the binding carries must be what inspection reports: a drift
  // between the two would let a gone session's operations through.
  assert.deepEqual(binding.facts, await ownerInstance.inspectFacts(IOS_DEVICE));
  assert.equal(binding.facts.operations.captureSnapshot.available, false);
  assert.equal(binding.facts.operations.openApplication.available, false);
});

test('a bind without an exact owner refuses a device with no live session', async () => {
  await assert.rejects(
    owner({ hasLiveSession: false }).bind({
      device: IOS_DEVICE,
      intent: { kind: 'provider-default' },
      scope: { signal: new AbortController().signal },
    } as never),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-session-unavailable',
  );
});

test('a live session binds the interactor-backed operations and refuses the rest', async () => {
  const binding = await bind(
    owner({ hasLiveSession: true, interactor: { tap: async () => {} } as unknown as Interactor }),
  );
  assert.ok(binding.operations.tapPoint);
  assert.ok(binding.operations.captureSnapshot);
  assert.ok(binding.operations.captureScreenshot);
  assert.ok(binding.operations.openApplication);
  assert.ok(binding.operations.home);
  assert.equal(binding.operations.tapRef, undefined);
  assert.equal(binding.operations.performGesturePlan, undefined);
  assert.equal(binding.operations.keyboardStatus, undefined);
  assert.equal(binding.operations.screenRecordingStart, undefined);
  assert.equal(binding.operations.appLogInspect, undefined);
});

test('a session that has ended reports the refused facts and binds no device action', async () => {
  const facts = await owner({ hasLiveSession: false }).inspectFacts(IOS_DEVICE);
  assert.equal(facts?.operations.captureSnapshot.available, false);
  assert.equal(facts?.operations.openApplication.available, false);
  assert.equal(facts?.operations.tapPoint.available, false);
});

test('a binding whose facts refused everything exposes no operation at all', async () => {
  // The exact-owner intent binds even without a live session so `inspectFacts` and `bind` cannot
  // disagree, so the operations projection has to follow those facts. An operation left bound here
  // would reach an interactor for a session that is gone.
  const binding = await bind(
    owner({ hasLiveSession: false, interactor: { tap: async () => {} } as unknown as Interactor }),
  );
  assert.deepEqual(Object.keys(binding.operations), []);
});

test('a device identity this module never built is refused at bind', async () => {
  const foreign: DeviceInfo = { ...IOS_DEVICE, id: 'other:ios:lease-1' };
  await assert.rejects(
    owner({ hasLiveSession: true }).bind({
      device: foreign,
      intent: { kind: 'exact-owner', owner: OWNER },
      scope: { signal: new AbortController().signal },
    } as never),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_PLATFORM',
  );
});

test('a facts inspection of an unowned device reports the target refusal, not a session one', async () => {
  const foreign: DeviceInfo = { ...IOS_DEVICE, id: 'other:ios:lease-1' };
  const facts = await owner({ hasLiveSession: true }).inspectFacts(foreign);
  assert.equal(facts?.operations.openApplication.available, false);
  assert.equal(facts?.operations.openApplication.reason, 'unsupported-provider-mode');
});
