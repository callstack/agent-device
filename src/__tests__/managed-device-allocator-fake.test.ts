import type {
  LeaseRequestInput,
  LeaseRequestStatus,
  ManagedIdentityRef,
} from '@agent-device/contracts/managed-device-allocation';
import { describe, expect, test } from 'vitest';
import { createScriptedManagedDeviceAllocator } from './test-utils/managed-device-allocator.fixtures.ts';

const request: LeaseRequestInput = {
  requesterId: 'requester-a',
  requestGeneration: 1,
  attemptKey: 'attempt-1',
  shape: { platform: 'ios', deviceType: 'iPhone 16' },
  deadlineAtMs: 1_000,
  admission: 'fail-fast',
  activation: 'direct',
};

const identity: ManagedIdentityRef = {
  deviceId: 'device-a',
  identityIncarnationId: 'incarnation-a',
};

const pending: LeaseRequestStatus = {
  requesterId: request.requesterId,
  requestGeneration: request.requestGeneration,
  attemptKey: request.attemptKey,
  state: 'pending',
};

const granted: LeaseRequestStatus = {
  ...pending,
  identityIncarnationId: identity.identityIncarnationId,
  state: 'granted',
  lease: {
    id: 'lease-1',
    ttlDeadline: 2_000,
    device: { address: 'device-a' },
    environment: { SIMLOCK_IOS_DEVICE_SET: '/sets/managed' },
  },
};

describe('scripted managed device allocator', () => {
  test('replays one step per method in order and refuses an unscripted call', async () => {
    const allocator = createScriptedManagedDeviceAllocator({
      instanceId: 'sim-a',
      script: {
        requestLease: [pending, granted],
        getLeaseRequestStatus: [granted],
        getManagedIdentityStatus: [new Error('allocator unreachable')],
      },
    });

    expect(allocator.instanceId).toBe('sim-a');
    await expect(allocator.requestLease(request)).resolves.toEqual(pending);
    // Steps are consumed per method: the lookup between the two requests takes its own script.
    await expect(
      allocator.getLeaseRequestStatus({ requesterId: 'requester-a', attemptKey: 'attempt-1' }),
    ).resolves.toEqual(granted);
    await expect(allocator.requestLease(request)).resolves.toEqual(granted);
    await expect(allocator.requestLease(request)).rejects.toThrow(
      'Unscripted allocator call: requestLease',
    );
    await expect(allocator.getManagedIdentityStatus(identity)).rejects.toThrow(
      'allocator unreachable',
    );
    await expect(
      allocator.confirmLeaseActivation({
        requesterId: 'requester-a',
        requestGeneration: 1,
        identityIncarnationId: 'incarnation-a',
      }),
    ).rejects.toThrow('Unscripted allocator call: confirmLeaseActivation');
  });

  test('records every call with the input it received', async () => {
    const allocator = createScriptedManagedDeviceAllocator({
      script: { requestLease: [granted], releaseLease: [undefined] },
    });

    await allocator.requestLease(request);
    await allocator.releaseLease({ leaseId: 'lease-1' });

    expect(allocator.calls).toEqual([
      { method: 'requestLease', input: request },
      { method: 'releaseLease', input: { leaseId: 'lease-1' } },
    ]);
    expect(allocator.calls[0]?.input).toBe(request);
  });
});
