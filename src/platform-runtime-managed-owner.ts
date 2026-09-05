import {
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOperationFact,
  type RuntimeOperationKey,
  type RuntimeOperationUnavailability,
  type RuntimeOwnerRef,
  sameRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import {
  createFullyUnavailablePlatformRuntimeFacts,
  createUnavailablePlatformRuntimeFacts,
} from '@agent-device/contracts/platform-runtime-unavailable';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import {
  assertManagedDeviceIdentity,
  withManagedDeviceScope,
} from '@agent-device/provision-kit/managed-device-scope';
import type { Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

export type ManagedLocalRuntimeOwnerRef = Extract<RuntimeOwnerRef, { kind: 'managed-local' }>;

type ManagedOperationKey = RuntimeOperationKey<PlatformRuntimeOperations>;

const REVIEWED_MANAGED_OPERATIONS: Partial<Record<ManagedOperationKey, 'both' | 'android'>> = {
  ensureReady: 'both',
  deployApp: 'both',
  materializeAppSource: 'both',
  deployMaterializedApp: 'both',
  sendPushNotification: 'both',
  setSetting: 'both',
  readClipboard: 'both',
  writeClipboard: 'both',
  captureScreenshot: 'android',
};

const unavailable: RuntimeOperationUnavailability = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'This operation has no verified managed-device automation path.',
});

export function createManagedLocalRuntimeOwner(params: {
  owner: ManagedLocalRuntimeOwnerRef;
  loadLocal: (family: Platform) => Promise<PlatformRuntimeOwner>;
}): PlatformRuntimeOwner {
  return Object.freeze({
    owner: params.owner,
    // Selection is exact-only by construction: ordinary selection never consults this owner, and
    // claiming a device here would be the one way it could.
    ownsDevice: () => false,
    inspectFacts: async (device) => {
      return createUnavailablePlatformRuntimeFacts(
        device,
        params.owner,
        createFullyUnavailablePlatformRuntimeFacts(unavailable),
      );
    },
    bind: async (request) => {
      if (
        request.intent.kind !== 'exact-owner' ||
        !sameRuntimeOwner(request.intent.owner, params.owner)
      ) {
        throw new AppError(
          'COMMAND_FAILED',
          'A managed local owner binds only under an exact-owner intent naming it',
          { reason: 'runtime-contract-invalid' },
        );
      }
      const managed = request.scope.managedDevice;
      if (
        !managed ||
        !sameRuntimeOwner(managed.owner, params.owner) ||
        managed.fence.token !== request.intent.fence.token ||
        managed.fence.generation !== request.intent.fence.generation
      ) {
        throw new AppError(
          'COMMAND_FAILED',
          'Managed automation requires its exact request authority.',
          { reason: 'runtime-contract-invalid' },
        );
      }
      assertManagedDeviceIdentity(managed, request.device);
      const run = <T>(task: () => Promise<T>) =>
        managed.run(() => withManagedDeviceScope(managed, task));
      const local = await params.loadLocal(request.device.platform);
      const binding = await run(() =>
        local.bind({
          device: request.device,
          intent: { kind: 'ordinary' },
          scope: request.scope,
        }),
      );
      const facts = projectManagedFacts(binding.facts);
      return Object.freeze({
        device: binding.device,
        owner: params.owner,
        facts,
        operations: admittedOperations(
          withMethodScope({ ...binding.operations }, (task) =>
            run(async () => {
              request.scope.signal.throwIfAborted();
              await managed.ensureReady();
              request.scope.signal.throwIfAborted();
              return await task();
            }),
          ),
          facts,
        ),
        [Symbol.asyncDispose]: async () =>
          await run(async () => await binding[Symbol.asyncDispose]()),
      });
    },
    // The delegated family owner is registered with the gateway in its own right, which is what
    // shuts it down; this wrapper holds nothing else.
    shutdown: async () => undefined,
  });
}

function projectManagedFacts(
  facts: RuntimeFacts<PlatformRuntimeOperations>,
): RuntimeFacts<PlatformRuntimeOperations> {
  const operations = Object.fromEntries(
    Object.entries(facts.operations).map(([key, fact]) => {
      const reviewed = REVIEWED_MANAGED_OPERATIONS[key as ManagedOperationKey];
      const supported =
        facts.device.family === 'android' ||
        (facts.device.family === 'apple' && facts.device.appleOs === 'ios');
      return [
        key,
        supported && (reviewed === 'both' || reviewed === facts.device.family) ? fact : unavailable,
      ];
    }),
  );
  return Object.freeze({
    device: facts.device,
    operations: Object.freeze(operations),
  }) as RuntimeFacts<PlatformRuntimeOperations>;
}

/** Facts are the only admission authority, so an operation cannot outlive its own fact. */
function admittedOperations(
  operations: DeviceBinding<PlatformRuntimeOperations>['operations'],
  facts: RuntimeFacts<PlatformRuntimeOperations>,
): DeviceBinding<PlatformRuntimeOperations>['operations'] {
  const admitted: Record<string, unknown> = {};
  for (const [key, operation] of Object.entries(operations)) {
    const fact: RuntimeOperationFact | undefined = facts.operations[key as ManagedOperationKey];
    if (fact?.available === true) admitted[key] = operation;
  }
  return Object.freeze(admitted) as DeviceBinding<PlatformRuntimeOperations>['operations'];
}
