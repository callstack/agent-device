import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { managedLocalRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { AppError } from '@agent-device/kernel/errors';
import {
  ALLOCATOR_CLAIM_MISSING,
  buildAllocatorHeldRefusal,
  buildDeviceClaimConflictError,
  buildDeviceClaimInspectionCommand,
  decideAllocatorHeldAdmission,
  DEVICE_CLAIM_ALLOCATOR_HELD,
  isDeviceClaimConflictReason,
} from '../device-claim-conflict.ts';
import type { AllocatorHeldClaimAdmission } from '../device-claim-allocator.ts';
import type { InspectedDeviceClaim } from '../device-claim-inspection.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
};

function conflict(
  classification: Exclude<InspectedDeviceClaim['classification'], 'allocator-held'>,
): InspectedDeviceClaim {
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

function allocatorConflict(): InspectedDeviceClaim {
  return {
    fileName: 'claim.json',
    deviceKey: 'local:android:none:emulator-5554',
    classification: 'allocator-held',
    allocatorClaim: {
      schemaVersion: 3,
      kind: 'allocator',
      deviceKey: 'local:android:none:emulator-5554',
      device: { family: 'android', id: device.id, name: device.name, kind: device.kind },
      stateDir: '/state/host',
      allocator: { instanceId: 'sim-a', identityIncarnationId: 'inc-1' },
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

// Every verifier outcome names its admission here, so an outcome this table does not answer
// fails to compile. `decideAllocatorHeldAdmission` returns a decision rather than an optional
// error for the same reason: a gate reads `admitted`, never the absence of an answer.
const ADMITTED_BY_OUTCOME_STATUS: Readonly<Record<AllocatorHeldClaimAdmission['status'], boolean>> =
  {
    'binding-invalid': false,
    missing: false,
    covered: true,
    'incarnation-stale': false,
    conflict: false,
  };

test('every allocator-held verifier outcome is decided, and none of them is decided by silence', () => {
  const owner = managedLocalRuntimeOwner('sim-a');
  const outcomes: readonly AllocatorHeldClaimAdmission[] = [
    { status: 'binding-invalid' },
    { status: 'missing' },
    { status: 'covered' },
    { status: 'incarnation-stale', heldIncarnationId: 'inc-1' },
    { status: 'conflict', conflict: conflict('live') },
  ];

  // The cases below cover the whole union, not whichever members happened to be listed.
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status).sort(),
    Object.keys(ADMITTED_BY_OUTCOME_STATUS).sort(),
  );
  for (const outcome of outcomes) {
    const decision = decideAllocatorHeldAdmission(device, owner, outcome);
    assert.equal(decision.admitted, ADMITTED_BY_OUTCOME_STATUS[outcome.status], outcome.status);
    // A refusal always carries the error the gates throw; an unanswered arm would land here
    // as `undefined` and admit the device instead.
    if (!decision.admitted) assert.ok(decision.error instanceof AppError, outcome.status);
  }
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

  // The claim is ours, but for an identity the allocator has since re-provisioned.
  const stale = buildAllocatorHeldRefusal(device, owner, {
    status: 'incarnation-stale',
    heldIncarnationId: 'inc-1',
  });
  assert.ok(stale && !stale.ok);
  assert.equal(stale.error.code, 'COMMAND_FAILED');
  assert.equal(stale.error.details?.reason, 'allocator-claim-incarnation-stale');
  assert.equal(stale.error.details?.heldIncarnationId, 'inc-1');
  assert.equal(stale.error.retriable, false);
  assert.equal(isDeviceClaimConflictReason('allocator-claim-incarnation-stale'), false);

  // Covered is the admitted outcome: the command executes under the claim, with no refusal.
  assert.equal(buildAllocatorHeldRefusal(device, owner, { status: 'covered' }), undefined);
});

test('an allocator-held conflict names the allocator instance and installation and offers no release', () => {
  const response = buildDeviceClaimConflictError(device, allocatorConflict());

  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'DEVICE_IN_USE');
  assert.equal(response.error.details?.reason, DEVICE_CLAIM_ALLOCATOR_HELD);
  assert.equal(response.error.details?.classification, 'allocator-held');
  assert.deepEqual(response.error.details?.owner, {
    kind: 'allocator',
    stateDir: '/state/host',
    allocator: { instanceId: 'sim-a', identityIncarnationId: 'inc-1' },
  });
  // No session or workspace exists to render, and no stale release is on offer.
  assert.match(response.error.message, /held by managed-device allocator "sim-a"/);
  assert.doesNotMatch(response.error.message, /undefined/);
  assert.deepEqual(response.error.details?.recovery, {
    command: 'agent-device device status --platform android --serial emulator-5554',
  });
  assert.doesNotMatch(String(response.error.hint), /--stale|device release/);
  // Replay retries every conflict reason as infrastructure; an allocator-held device is not one.
  assert.equal(isDeviceClaimConflictReason(DEVICE_CLAIM_ALLOCATOR_HELD), false);
});
