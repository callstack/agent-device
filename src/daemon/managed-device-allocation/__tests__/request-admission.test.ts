import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { ManagedLease } from '@agent-device/contracts/managed-device-allocation';
import { ensureBoundDeviceReady } from '../../request-runtime-binding.ts';
import { withManagedAdbFixture } from '../../../platform-runtime-managed-owner.fixtures.ts';
import { NOW, deferred, unknownStatus } from './lease-admission.fixtures.ts';
import {
  setupRequest,
  renewedRequestLease,
  mismatchedRequestAuthorities,
} from './request-admission.fixtures.ts';

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
afterEach(() => vi.restoreAllMocks());

test.skipIf(process.platform === 'win32')(
  'request and claim admission confirm command plus teardown before real Android bind probes and clipboard execution',
  async () => {
    await withManagedAdbFixture(async (native) => {
      const pending = deferred<ManagedLease>();
      const setup = await setupRequest({ script: { renewLease: [pending.promise] } });
      const binding = setup.bind();
      void binding.catch(() => {});
      await vi.waitFor(() => expect(setup.allocator.calls).toHaveLength(1));
      expect(setup.probe).not.toHaveBeenCalled();
      expect(native.calls()).toEqual([]);
      const required = NOW + 90_000 + setup.horizon.teardownTimeoutMs;
      expect(setup.allocator.calls[0]).toEqual({
        method: 'renewLease',
        input: { leaseId: 'lease-1', ttlDeadline: required + 5_000 },
      });
      pending.resolve(renewedRequestLease({ ttlDeadline: required }));
      const bound = await binding;
      await ensureBoundDeviceReady(bound);
      expect(await bound.operations.readClipboard({})).toBe('managed clipboard');
      expect(setup.probe).toHaveBeenCalledOnce();
      expect(native.calls()).toHaveLength(2);
      for (const args of native.calls())
        expect(args.slice(0, 4)).toEqual(['-P', '15037', '-s', 'emulator-15037']);
      expect(setup.requests[0]?.scope.managedDevice?.fence).toEqual(setup.admission.fence);
      setup.admission.fenceBinding('released');
      await expect(bound.operations.readClipboard({})).rejects.toMatchObject({
        details: { reason: 'managed-lease-teardown-required' },
      });
      await expect(ensureBoundDeviceReady(bound)).rejects.toMatchObject({
        details: { reason: 'managed-lease-teardown-required' },
      });
      expect(native.calls()).toHaveLength(2);
      await setup.bindings[Symbol.asyncDispose]();
      expect(setup.dispose).toHaveBeenCalledOnce();
    });
  },
);

test.each([
  [{ missingClaim: true }, 'allocator-claim-missing'],
  [{ missingAdmission: true }, 'managed-lease-admission-unavailable'],
  [{ readinessDuringBind: true }, 'managed-request-not-admitted'],
] as const)(
  'managed request refuses %j before readiness or native probes',
  async (options, reason) => {
    const setup = await setupRequest({
      ...options,
      script: { renewLease: [renewedRequestLease({ ttlDeadline: NOW + 200_000 })] },
    });
    await expect(setup.bind()).rejects.toMatchObject({ details: { reason } });
    expect(setup.probe).not.toHaveBeenCalled();
    if (!('readinessDuringBind' in options)) expect(setup.allocator.calls).toEqual([]);
    await setup.bindings[Symbol.asyncDispose]();
  },
);

test('insufficient confirmed command-plus-teardown horizon refuses before any platform probe', async () => {
  const setup = await setupRequest({
    script: { renewLease: [renewedRequestLease()], getLeaseRequestStatus: [unknownStatus] },
  });
  await expect(setup.bind()).rejects.toMatchObject({
    details: { reason: 'managed-lease-teardown-required' },
  });
  expect(setup.probe).not.toHaveBeenCalled();
  await setup.bindings[Symbol.asyncDispose]();
});

test.each(Object.entries(mismatchedRequestAuthorities))(
  'mismatched resolved %s is refused before allocator work or binding',
  async (_name, overrideLease) => {
    const setup = await setupRequest({
      overrideLease,
      script: { renewLease: [renewedRequestLease({ ttlDeadline: NOW + 200_000 })] },
    });
    const error = await setup.bind().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(setup.allocator.calls).toEqual([]);
    expect(setup.requests).toEqual([]);
    expect(setup.probe).not.toHaveBeenCalled();
    expect(error).toMatchObject({ details: { reason: 'managed-lease-admission-unavailable' } });
    await setup.bindings[Symbol.asyncDispose]();
  },
);

test.skipIf(process.platform === 'win32')(
  'request disposal and command expiry revoke captured operations and readiness',
  async () => {
    await withManagedAdbFixture(async (native) => {
      const setup = await setupRequest({
        script: { renewLease: [renewedRequestLease({ ttlDeadline: NOW + 200_000 })] },
      });
      const bound = await setup.bind();
      const calls = native.calls();
      vi.spyOn(Date, 'now').mockReturnValue(NOW + 90_000);
      await expect(bound.operations.readClipboard({})).rejects.toMatchObject({
        details: { reason: 'managed-command-deadline-exceeded' },
      });
      await setup.bindings[Symbol.asyncDispose]();
      for (const operation of [
        () => ensureBoundDeviceReady(bound),
        () => bound.operations.readClipboard({}),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          details: { reason: 'request_canceled' },
        });
      }
      expect(native.calls()).toEqual(calls);
    });
  },
);

test.skipIf(process.platform === 'win32')(
  'a binding published after request disposal is cleaned up without activating readiness',
  async () => {
    await withManagedAdbFixture(async (native) => {
      const publication = deferred<void>();
      const setup = await setupRequest({
        beforePublication: publication.promise,
        script: { renewLease: [renewedRequestLease({ ttlDeadline: NOW + 200_000 })] },
      });
      const binding = setup.bind();
      const rejected = expect(binding).rejects.toBeDefined();
      await vi.waitFor(() => expect(setup.probe).toHaveBeenCalledOnce());
      await setup.bindings[Symbol.asyncDispose]();
      publication.resolve();
      await rejected;
      expect(setup.dispose).toHaveBeenCalledOnce();
      await expect(
        setup.requests[0]?.scope.managedDevice?.admit(async () => {}),
      ).rejects.toMatchObject({
        details: { reason: 'managed-request-not-admitted' },
      });
      expect(native.calls()).toHaveLength(1);
    });
  },
);

test.skipIf(process.platform === 'win32')(
  'disposal during renewal prevents native binding while another caller retains shared renewal',
  async () => {
    await withManagedAdbFixture(async (native) => {
      const pending = deferred<ManagedLease>();
      const setup = await setupRequest({ script: { renewLease: [pending.promise] } });
      const outcome = setup.bind().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.waitFor(() => expect(setup.allocator.calls).toHaveLength(1));
      const surviving = setup.admission.run(
        setup.horizon,
        new AbortController().signal,
        async () => 'confirmed',
      );
      await setup.bindings[Symbol.asyncDispose]();
      pending.resolve(renewedRequestLease({ ttlDeadline: NOW + 200_000 }));
      const [result, survivor] = await Promise.all([outcome, surviving]);
      expect(setup.probe).not.toHaveBeenCalled();
      expect(native.calls()).toEqual([]);
      expect(result).toMatchObject({ error: { details: { reason: 'request_canceled' } } });
      expect(survivor).toMatchObject({ status: 'admitted', value: 'confirmed' });
      expect(setup.allocator.calls).toHaveLength(1);
    });
  },
);

test.skipIf(process.platform === 'win32')(
  'disposal during operation projection refuses activation after successful adoption',
  async () => {
    await withManagedAdbFixture(async (native) => {
      let disposing: Promise<void> | undefined;
      const setup = await setupRequest({
        beforeProjection: () => {
          disposing ??= setup.bindings[Symbol.asyncDispose]();
        },
        script: { renewLease: [renewedRequestLease({ ttlDeadline: NOW + 200_000 })] },
      });
      const error = await setup.bind().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(disposing).toBeDefined();
      await disposing;
      expect(setup.dispose).toHaveBeenCalledOnce();
      expect(native.calls()).toHaveLength(1);
      expect(error).toMatchObject({ details: { reason: 'request_canceled' } });
      await expect(
        setup.requests[0]?.scope.managedDevice?.admit(async () => {}),
      ).rejects.toMatchObject({ details: { reason: 'managed-request-not-admitted' } });
    });
  },
);

test.skipIf(process.platform === 'win32')(
  'request disposal revokes captured operations before asynchronous cleanup finishes',
  async () => {
    await withManagedAdbFixture(async (native) => {
      const cleanup = deferred<void>();
      const setup = await setupRequest({
        beforeDisposal: cleanup.promise,
        script: { renewLease: [renewedRequestLease({ ttlDeadline: NOW + 200_000 })] },
      });
      const bound = await setup.bind();
      const calls = native.calls();
      const disposing = setup.bindings[Symbol.asyncDispose]();
      try {
        await vi.waitFor(() => expect(setup.dispose).toHaveBeenCalledOnce());
        await expect(bound.operations.readClipboard({})).rejects.toMatchObject({
          code: 'COMMAND_FAILED',
        });
        expect(native.calls()).toEqual(calls);
      } finally {
        cleanup.resolve();
        await disposing;
      }
    });
  },
);

test.skipIf(process.platform === 'win32')(
  'the real operation completes inside lease admission before a following fence',
  async () => {
    await withManagedAdbFixture(async (native) => {
      let fenceAfterAdmission = false;
      const callsAtFence: number[] = [];
      const setup = await setupRequest({
        script: { renewLease: [renewedRequestLease({ ttlDeadline: NOW + 200_000 })] },
        afterAdmission: () => {
          if (!fenceAfterAdmission) return;
          fenceAfterAdmission = false;
          callsAtFence.push(native.calls().length);
          setup.admission.fenceBinding('released');
        },
      });
      const bound = await setup.bind();
      fenceAfterAdmission = true;
      expect(await bound.operations.readClipboard({})).toBe('managed clipboard');
      expect(callsAtFence).toEqual([2]);
      await expect(bound.operations.readClipboard({})).rejects.toMatchObject({
        details: { reason: 'managed-lease-teardown-required' },
      });
      expect(native.calls()).toHaveLength(2);
      await setup.bindings[Symbol.asyncDispose]();
      expect(setup.dispose).toHaveBeenCalledOnce();
    });
  },
);
