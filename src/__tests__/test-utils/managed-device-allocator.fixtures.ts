import type {
  ManagedDeviceAllocatorPort,
  ManagedLease,
  ManagedLeaseEnvironmentKey,
  ManagedLeaseEnvironmentOutcome,
  ManagedLeasePlatform,
} from '@agent-device/contracts/managed-device-allocation';

/** The port's calls to the allocator. `readLeaseEnvironment` reads a grant already in hand. */
export type ScriptedAllocatorMethod = keyof Omit<
  ManagedDeviceAllocatorPort,
  'instanceId' | 'readLeaseEnvironment'
>;

export type ScriptedAllocatorCall = Readonly<{
  method: ScriptedAllocatorMethod;
  input: unknown;
}>;

export type ScriptedManagedDeviceAllocator = ManagedDeviceAllocatorPort &
  Readonly<{ calls: ScriptedAllocatorCall[] }>;

/**
 * The only implementation of the allocator port in the foundations: it replays one scripted step
 * per call, in the order the script lists them for that method, and refuses a call the script did
 * not anticipate. No transport, no timers, and no lifecycle rules of its own — a test that wants
 * an allocator behavior states it as a step.
 */
export function createScriptedManagedDeviceAllocator(
  options: {
    instanceId?: string;
    script?: Partial<Record<ScriptedAllocatorMethod, readonly unknown[]>>;
  } = {},
): ScriptedManagedDeviceAllocator {
  const calls: ScriptedAllocatorCall[] = [];
  const remaining = new Map<ScriptedAllocatorMethod, unknown[]>(
    Object.entries(options.script ?? {}).map(([method, steps]) => [
      method as ScriptedAllocatorMethod,
      [...(steps ?? [])],
    ]),
  );
  const next = async <Result>(method: ScriptedAllocatorMethod, input: unknown): Promise<Result> => {
    calls.push(Object.freeze({ method, input }));
    const steps = remaining.get(method) ?? [];
    if (steps.length === 0) throw new Error(`Unscripted allocator call: ${method}`);
    const step = steps.shift();
    if (step instanceof Error) throw step;
    return step as Result;
  };
  return Object.freeze({
    instanceId: options.instanceId ?? 'scripted-allocator',
    calls,
    requestLease: async (input) => await next('requestLease', input),
    getLeaseRequestStatus: async (request) => await next('getLeaseRequestStatus', request),
    supersedeLeaseRequest: async (input) => await next('supersedeLeaseRequest', input),
    cancelLeaseRequest: async (request) => await next('cancelLeaseRequest', request),
    renewLease: async (input) => await next('renewLease', input),
    releaseLease: async (input) => await next('releaseLease', input),
    confirmLeaseActivation: async (proof) => await next('confirmLeaseActivation', proof),
    getManagedIdentityStatus: async (identity) => await next('getManagedIdentityStatus', identity),
    acknowledgeManagedIdentityRemoval: async (identity) =>
      await next('acknowledgeManagedIdentityRemoval', identity),
    readLeaseEnvironment: ({ platform, lease }) => readLeaseEnvironment(platform, lease),
  });
}

function readLeaseEnvironment(
  platform: ManagedLeasePlatform,
  lease: ManagedLease,
): ManagedLeaseEnvironmentOutcome {
  if (platform === 'ios') {
    const deviceSetPath = lease.environment.SIMLOCK_IOS_DEVICE_SET;
    return deviceSetPath === undefined || deviceSetPath.length === 0
      ? environmentInvalid(platform, 'SIMLOCK_IOS_DEVICE_SET')
      : Object.freeze({ ok: true, environment: Object.freeze({ platform, deviceSetPath }) });
  }
  const raw = lease.environment.ANDROID_ADB_SERVER_PORT;
  const adbServerPort = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(adbServerPort) && adbServerPort > 0
    ? Object.freeze({ ok: true, environment: Object.freeze({ platform, adbServerPort }) })
    : environmentInvalid(platform, 'ANDROID_ADB_SERVER_PORT');
}

function environmentInvalid(
  platform: ManagedLeasePlatform,
  key: ManagedLeaseEnvironmentKey,
): ManagedLeaseEnvironmentOutcome {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: 'LEASE_ENVIRONMENT_INVALID', platform, key }),
  });
}
