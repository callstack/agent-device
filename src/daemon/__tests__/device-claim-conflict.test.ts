import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { managedLocalRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  ALLOCATOR_CLAIM_MISSING,
  buildAllocatorHeldRefusal,
  buildDeviceClaimConflictError,
  buildDeviceClaimInspectionCommand,
  isDeviceClaimConflictReason,
} from '../device-claim-conflict.ts';
import type { InspectedDeviceClaim } from '../device-claim-inspection.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
};

function conflict(classification: InspectedDeviceClaim['classification']): InspectedDeviceClaim {
  return {
    fileName: 'claim.json',
    deviceKey: 'local:android:none:emulator-5554',
    classification,
    claim: {
      schemaVersion: 2,
      deviceKey: 'local:android:none:emulator-5554',
      device: { family: 'android', id: device.id, name: device.name, kind: device.kind },
      session: 'checkout',
      workspace: '/worktrees/checkout',
      stateDir: '/state/checkout',
      ownerPid: 4242,
      ownerStartTime: 'start',
      ownerToken: 'token',
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  };
}

test.each(['owner-process-dead', 'owner-process-reused', 'owner-state-dir-gone'] as const)(
  'builds an exact --stale recovery command for %s',
  (classification) => {
    assert.equal(
      buildDeviceClaimInspectionCommand(device, conflict(classification)),
      'agent-device device status --platform android --serial emulator-5554 --stale',
    );
  },
);

test('routes conflict presentation through the canonical error response shape', () => {
  const response = buildDeviceClaimConflictError(device, conflict('live'));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.retriable, false);
  assert.equal(
    response.error.hint,
    'Inspect the owner with: agent-device device status --platform android --serial emulator-5554',
  );
  assert.deepEqual(response.error.details?.recovery, {
    command: 'agent-device device status --platform android --serial emulator-5554',
  });
});

test('routes a provably dead owner to the exact stale release command', () => {
  const response = buildDeviceClaimConflictError(device, conflict('owner-process-dead'));
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.deepEqual(response.error.details?.recovery, {
    command: 'agent-device device release --platform android --serial emulator-5554 --stale',
  });
  assert.match(String(response.error.hint), /settle its resources and release the claim with:/);
});

test('a missing allocator-held claim is a permanent COMMAND_FAILED refusal outside the conflict reasons', () => {
  const owner = managedLocalRuntimeOwner('sim-a');
  const response = buildAllocatorHeldRefusal(device, owner, { status: 'missing' });
  assert.ok(response && !response.ok);
  assert.equal(response.error.code, 'COMMAND_FAILED');
  assert.equal(response.error.retriable, false);
  assert.equal(response.error.details?.reason, ALLOCATOR_CLAIM_MISSING);
  assert.equal(response.error.details?.owner, 'managed:["sim-a"]');
  assert.equal(response.error.details?.deviceKey, 'local:android:none:emulator-5554');
  assert.match(String(response.error.hint), /allocator-held claim/);
  // Replay retries every conflict reason as infrastructure; a never-activated identity is not one.
  assert.equal(isDeviceClaimConflictReason(ALLOCATOR_CLAIM_MISSING), false);
});

test('each allocator-held verifier outcome maps to its own refusal', () => {
  const owner = managedLocalRuntimeOwner('sim-a');
  const invalid = buildAllocatorHeldRefusal(device, owner, { status: 'binding-invalid' });
  assert.ok(invalid && !invalid.ok);
  assert.equal(invalid.error.code, 'COMMAND_FAILED');
  assert.equal(invalid.error.details?.reason, 'runtime-contract-invalid');
  assert.equal(invalid.error.retriable, false);

  const foreign = buildAllocatorHeldRefusal(device, owner, {
    status: 'conflict',
    conflict: conflict('live'),
  });
  assert.ok(foreign && !foreign.ok);
  assert.equal(foreign.error.code, 'DEVICE_IN_USE');
  assert.equal(foreign.error.details?.reason, 'DEVICE_CLAIM_LIVE_OWNER');
});
