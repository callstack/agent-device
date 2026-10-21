import { normalizeBatchCommandName } from '@agent-device/command-registry/batch-policy';
import type {
  AppDeviceResolver,
  ComposedDeviceInventoryGateways,
  DeviceInventoryGateway,
  ProviderAwareDeviceInventoryGateway,
} from '@agent-device/contracts/platform-module';
import type { DeviceLease } from '@agent-device/contracts/device';
import {
  canonicalDeviceId,
  hostDeviceIdOf,
  hostDeviceIdPrefix,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import {
  resolveDaemonPolicyCommandName,
  type DaemonPolicy,
  type DaemonPolicyCapability,
} from '@agent-device/daemon-contracts/daemon-policy-file';
import type { DaemonRequest } from './daemon-request.ts';

/**
 * ADR 0029 enforcement: every request the daemon admits, including `batch` steps and `replay`
 * actions, which re-enter request admission rather than the HTTP edge. The policy file itself is
 * loaded and validated by `@agent-device/daemon-contracts/daemon-policy-file`.
 */

/** Refuses a request the policy denies before it resolves a device or takes a lock. */
export function assertDaemonPolicyAdmitsRequest(policy: DaemonPolicy, req: DaemonRequest): void {
  assertInvocationAdmitted(policy, req.command, req.flags ?? {});
  if (req.command !== 'batch') return;
  // Refuse the whole batch before any step runs; each step is admitted again when it runs.
  for (const step of req.flags?.batchSteps ?? []) {
    assertInvocationAdmitted(policy, normalizeBatchCommandName(step.command), {
      ...step.input,
      ...step.flags,
    });
  }
}

function assertInvocationAdmitted(
  policy: DaemonPolicy,
  command: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  assertCommandAdmitted(policy, command);
  if (command === 'close' && fields.shutdown === true) {
    assertDaemonPolicyAllowsCapability(policy, 'device-shutdown');
  }
  if (!policy.deviceIds) return;
  for (const value of [fields.udid, fields.serial]) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!id || isDeviceIdAllowed(policy.deviceIds, id)) continue;
    throw policyDenied(policy, 'device', `Device ${id} is outside this daemon's policy.`, {
      deviceId: id,
    });
  }
}

/**
 * A device the policy may bind: one it names, or an app device of a host it names (ADR 0035). An
 * app device it names admits that app alone, never its host or the host's other apps.
 */
function isDeviceIdAllowed(deviceIds: ReadonlySet<string>, id: string): boolean {
  // Policy ids load canonicalized, so the compared id is too.
  const canonical = canonicalDeviceId(id);
  return deviceIds.has(canonical) || deviceIds.has(hostDeviceIdOf(canonical));
}

function isDeviceAllowedByDaemonPolicy(policy: DaemonPolicy, device: DeviceInfo): boolean {
  return !policy.deviceIds || isDeviceIdAllowed(policy.deviceIds, device.id);
}

/**
 * A device inventory lists: one the policy may bind, or a host one of whose app devices it may
 * bind, because selection derives the app device from its host. Binding still admits only what
 * {@link isDeviceAllowedByDaemonPolicy} does, so listing a host never authorizes the whole host.
 */
function isDeviceDiscoverableUnderDaemonPolicy(policy: DaemonPolicy, device: DeviceInfo): boolean {
  if (!policy.deviceIds || isDeviceAllowedByDaemonPolicy(policy, device)) return true;
  const appDevicePrefix = hostDeviceIdPrefix(device.id);
  return [...policy.deviceIds].some((id) => id.startsWith(appDevicePrefix));
}

/** Refuses a resolved device the policy does not allow, before the request binds it. */
export function assertDaemonPolicyAdmitsDevice(policy: DaemonPolicy, device: DeviceInfo): void {
  if (isDeviceAllowedByDaemonPolicy(policy, device)) return;
  throw policyDenied(policy, 'device', `Device ${device.id} is outside this daemon's policy.`, {
    deviceId: device.id,
  });
}

export function assertDaemonPolicyAllowsCapability(
  policy: DaemonPolicy,
  capability: DaemonPolicyCapability,
): void {
  if (!policy.deniedCapabilities.has(capability)) return;
  throw policyDenied(policy, 'capability', `This daemon's policy denies ${capability}.`, {
    capability,
  });
}

/**
 * `leases.require`: a request must be admitted under a lease of the required backend. A request
 * that names no lease is refused rather than admitted unleased.
 */
export function assertDaemonPolicyAdmitsLease(
  policy: DaemonPolicy,
  lease: Pick<DeviceLease, 'backend'> | undefined,
): void {
  const required = policy.requiredLeaseBackend;
  if (!required || lease?.backend === required) return;
  throw policyDenied(policy, 'lease', `This daemon's policy requires a ${required} lease.`, {
    leaseBackend: required,
  });
}

/** Device inventory, and therefore device selection, sees only the devices the policy allows. */
export function restrictDeviceInventoryToDaemonPolicy(
  gateways: ComposedDeviceInventoryGateways,
  policy: DaemonPolicy,
): ComposedDeviceInventoryGateways {
  if (!policy.deviceIds) return gateways;
  const allowed = (devices: readonly DeviceInfo[]) =>
    devices.filter((device) => isDeviceDiscoverableUnderDaemonPolicy(policy, device));
  const localOnly: DeviceInventoryGateway = Object.freeze({
    discover: async (request, scope) => allowed(await gateways.localOnly.discover(request, scope)),
  });
  // A provider that answers with only out-of-scope devices must not hide allowed local devices.
  const discoverWithSource: ProviderAwareDeviceInventoryGateway['discoverWithSource'] = async (
    request,
    scope,
  ) => {
    const discovery = await gateways.providerFirst.discoverWithSource(request, scope);
    const devices = allowed(discovery.devices);
    if (devices.length > 0 || discovery.source === 'local') return { ...discovery, devices };
    return { devices: await localOnly.discover(request, scope), source: 'local' };
  };
  const providerFirst: ProviderAwareDeviceInventoryGateway = Object.freeze({
    discover: async (request, scope) => (await discoverWithSource(request, scope)).devices,
    discoverWithSource,
  });
  const inner = gateways.resolveAppDevice;
  // On a host the policy does not allow, resolving an app name must not report what the host has
  // installed. Only an allowed app device is returned; a failed resolution and an app the policy
  // does not allow both leave the host selected, which binding then refuses the same way.
  const resolveAppDevice: AppDeviceResolver | undefined = inner
    ? async (host, appTarget) => {
        if (isDeviceAllowedByDaemonPolicy(policy, host)) return await inner(host, appTarget);
        try {
          const device = await inner(host, appTarget);
          return device && isDeviceAllowedByDaemonPolicy(policy, device) ? device : undefined;
        } catch (error) {
          if (isRequestCanceledError(error)) throw error;
          return undefined;
        }
      }
    : undefined;
  return Object.freeze({ ...gateways, localOnly, providerFirst, resolveAppDevice });
}

function assertCommandAdmitted(policy: DaemonPolicy, command: string): void {
  const rules = policy.commands;
  if (!rules) return;
  const name = resolveDaemonPolicyCommandName(command);
  if (name === undefined) return;
  const listed = rules.names.has(name);
  if (rules.mode === 'allow' ? listed : !listed) return;
  throw policyDenied(policy, 'command', `This daemon's policy denies the ${name} command.`, {
    command: name,
  });
}

function policyDenied(
  policy: DaemonPolicy,
  rule: 'command' | 'device' | 'capability' | 'lease',
  message: string,
  details: Record<string, unknown>,
): AppError {
  return new AppError('UNAUTHORIZED', message, {
    ...details,
    reason: 'DAEMON_POLICY_DENIED',
    rule,
    policyDigest: policy.digest,
    retriable: false,
    hint: "The daemon operator's policy denies this request; retrying will not help. Use an allowed command and device, or ask the operator to change the policy.",
  });
}
