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
import type { Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

export type ManagedLocalRuntimeOwnerRef = Extract<RuntimeOwnerRef, { kind: 'managed-local' }>;

type ManagedOperationKey = RuntimeOperationKey<PlatformRuntimeOperations>;

/**
 * What a managed local owner withholds, grouped by the mechanics that make it impossible rather
 * than by catalog family: an operation is here because executing it would boot, shut down, or
 * durably own the allocator's device.
 */
const WITHHELD_MANAGED_OPERATIONS = [
  {
    // The two deployment cells belong here for the same reason as the explicit boot cells: both
    // family deployment runtimes ensure device readiness first, and `deployAppUse` requires
    // `deployApp` alone, so nothing else would have caught `install` on a managed binding.
    hint: 'Managed-device lifecycle belongs to the allocator.',
    keys: [
      'ensureReady',
      'bootTarget',
      'bootTargetHeadless',
      'shutdownTarget',
      'deployApp',
      'deployMaterializedApp',
    ],
  },
  {
    // These four are lifecycle-bearing even though they read as application operations: open
    // preparation and Apple runner preparation boot the target unconditionally, and the close
    // pair carries the shutdown half of the same sequence.
    hint: 'Application open and close take device readiness and shutdown steps the allocator owns.',
    keys: [
      'prepareApplicationOpen',
      'prepareAppleRunner',
      'closeApplication',
      'finalizeApplicationClose',
    ],
  },
  {
    // A durable capture is adopted by comparing the envelope's owner with the binding's owner, and
    // the family runtime stamps envelopes with its own local owner — so a capture started under a
    // managed binding could never be reattached or cleaned up under it.
    hint: 'Durable captures are not adoptable under a managed local owner yet.',
    keys: [
      'appLogStart',
      'appLogReattach',
      'appLogCleanup',
      'screenRecordingStart',
      'screenRecordingReattach',
      'screenRecordingCleanup',
      'audioProbeStart',
      'audioProbeReattach',
      'audioProbeCleanup',
      'perfNativeCaptureStart',
      'perfNativeCaptureReattach',
      'perfNativeCaptureCleanup',
    ],
  },
  {
    // Below cell-selection granularity, the Apple family runtime can boot the simulator lazily:
    // screenshot capture retries through a boot on a shutdown failure, and settings, clipboard and
    // application launch each resolve a local interactor the same way. Closing that path is a
    // family-runtime change (the same class as the pre-binding readiness bypass named in "Named
    // out of scope" below); until then, a managed binding withholds these cells outright rather
    // than leave an allocator-owned device open to an implicit boot.
    hint: 'Managed-device lifecycle belongs to the allocator; this cell can lazily boot the device.',
    keys: ['captureScreenshot', 'setSetting', 'readClipboard', 'writeClipboard', 'openApplication'],
  },
] as const satisfies readonly Readonly<{ hint: string; keys: readonly ManagedOperationKey[] }>[];

/**
 * The exact-only runtime owner for one allocator instance. It owns no mechanics of its own: it
 * binds the device's local family owner, republishes that binding under the managed owner, and
 * withholds the cells whose declared work is device lifecycle.
 *
 * Withholding cells is not a complete lifecycle exclusion and does not claim to be. Screenshot
 * capture, settings, clipboard and application launch are withheld here even though their declared
 * work is not device lifecycle, because their Apple family-runtime implementations can boot the
 * simulator lazily below cell-selection granularity. Pre-binding readiness is the same class of
 * gap, one level up: `session-device-resolution` boots a device through direct simctl/adb before
 * any binding exists, gated only by provider ownership. Closing both is a family-runtime and
 * daemon change tracked as a follow-up, not attempted here.
 *
 * It delegates with an ordinary intent because a family owner refuses an exact-owner intent that
 * names anyone but itself. The managed intent's fence is not read here: the device-claim gate owns
 * what a managed binding fence proves.
 */
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
      const local = await params.loadLocal(device.platform);
      return projectManagedFacts(await local.inspectFacts(device));
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
      const local = await params.loadLocal(request.device.platform);
      const binding = await local.bind({
        device: request.device,
        intent: { kind: 'ordinary' },
        scope: request.scope,
      });
      const facts = projectManagedFacts(binding.facts);
      return Object.freeze({
        device: binding.device,
        owner: params.owner,
        facts,
        operations: admittedOperations(binding.operations, facts),
        [Symbol.asyncDispose]: async () => await binding[Symbol.asyncDispose](),
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
  const withheld: Partial<Record<ManagedOperationKey, RuntimeOperationFact>> = {};
  for (const group of WITHHELD_MANAGED_OPERATIONS) {
    const fact: RuntimeOperationUnavailability = Object.freeze({
      available: false,
      reason: 'owner-capability-missing',
      hint: group.hint,
    });
    for (const key of group.keys) withheld[key] = fact;
  }
  // The device shape is the family owner's answer, provider mode included: a managed owner
  // executes on a local device and may not launder a transport-composed one into a local claim.
  return Object.freeze({
    device: facts.device,
    operations: Object.freeze({ ...facts.operations, ...withheld }),
  });
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
