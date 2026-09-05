import { vi } from 'vitest';
import type { ManagedLease } from '@agent-device/contracts/managed-device-allocation';
import type { DeviceBindingRequest } from '@agent-device/contracts/platform-runtime';
import { clipboardReadUse } from '@agent-device/contracts/platform-runtime-operations';
import { gatewayFixtureScope } from '../../../platform-runtime-gateway.fixtures.ts';
import { createComposedPlatformRuntimeGateway } from '../../../platform-runtime-gateway.ts';
import { platformRuntimeModules } from '../../../platform-runtime.ts';
import { managedAutomationHost } from '../../../platform-runtime-managed-owner.fixtures.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../../__tests__/test-utils/device-claim-store.ts';
import { createDeviceClaimAdmission } from '../../device-claim-admission.ts';
import { acquireAllocatorHeldDeviceClaim } from '../../device-claim-allocator.ts';
import { createRequestRuntimeBindings } from '../../request-runtime-binding.ts';
import { managedCommandHorizon } from '../command-horizon.ts';
import type { ManagedLeaseAdmission } from '../lease-admission.ts';
import { NOW, granted, renewedLease, setupAdmission } from './lease-admission.fixtures.ts';

const stores = isolatedDeviceClaimStores('managed-request-admission-');

export const renewedRequestLease = (overrides: Partial<ManagedLease> = {}): ManagedLease =>
  renewedLease({
    device: { address: 'emulator-15037' },
    environment: { ANDROID_ADB_SERVER_PORT: '15037' },
    ...overrides,
  });

export async function setupRequest(
  options: Parameters<typeof setupAdmission>[0] & {
    missingClaim?: boolean;
    missingAdmission?: boolean;
    readinessDuringBind?: boolean;
    beforePublication?: Promise<void>;
    beforeDisposal?: Promise<void>;
    afterAdmission?: () => void;
    controller?: AbortController;
  } = {},
) {
  const setup = setupAdmission({
    ...options,
    platform: 'android',
    grant: options.grant ?? granted({ lease: renewedRequestLease({ ttlDeadline: NOW + 5_000 }) }),
  });
  const { admission, reachability } = setup;
  const requestLease: ManagedLeaseAdmission = {
    ...admission,
    run: async (horizon, signal, task) => {
      const result = await admission.run(horizon, signal, task);
      if (result.status === 'admitted') options.afterAdmission?.();
      return result;
    },
  };
  const { stateDir } = stores();
  const nativeHost = managedAutomationHost();
  const probe = vi.fn(nativeHost.androidTools.probeClipboardShellSupport);
  const host = {
    ...nativeHost,
    androidTools: { ...nativeHost.androidTools, probeClipboardShellSupport: probe },
  };
  const dispose = vi.fn(async () => {});
  const requests: DeviceBindingRequest[] = [];
  const android = platformRuntimeModules.get('android')!;
  const module = {
    ...android,
    loadRuntime: async (runtimeHost: Parameters<typeof android.loadRuntime>[0]) => {
      const local = await android.loadRuntime(runtimeHost);
      return {
        ...local,
        bind: async (request: DeviceBindingRequest) => {
          requests.push(request);
          if (options.readinessDuringBind) await request.scope.managedDevice?.admit(async () => {});
          const binding = await local.bind(request);
          await options.beforePublication;
          return {
            ...binding,
            [Symbol.asyncDispose]: async () => {
              await dispose();
              await options.beforeDisposal;
              await binding[Symbol.asyncDispose]();
            },
          };
        },
      };
    },
  };
  const gateway = createComposedPlatformRuntimeGateway({
    modules: new Map([['android', module]]),
    loadHost: async () => host,
    managedOwners: [admission.owner],
  });
  const claims = createDeviceClaimAdmission({
    policy: 'observe',
    command: 'clipboard',
    workspace: stateDir,
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  if (!options.missingClaim)
    await acquireAllocatorHeldDeviceClaim({
      device: reachability.device,
      principal: {
        stateDir,
        instanceId: setup.allocator.instanceId,
        identityIncarnationId: setup.grant.identityIncarnationId!,
      },
    });
  const horizon = managedCommandHorizon(
    { command: 'clipboard', session: 'managed', positionals: ['read'] },
    NOW,
  );
  const scope = {
    ...gatewayFixtureScope,
    signal: (options.controller ?? new AbortController()).signal,
  };
  const bindings = createRequestRuntimeBindings({
    gateway,
    scope,
    admitDeviceClaim: claims.admit,
    resolveManagedLease: options.missingAdmission
      ? undefined
      : () => ({ lease: requestLease, horizon }),
  });
  const bind = () =>
    bindings.bindExactDevice(
      reachability.device,
      admission.owner,
      admission.fence,
      clipboardReadUse,
      scope,
    );
  return { ...setup, probe, dispose, requests, bindings, bind, horizon };
}
