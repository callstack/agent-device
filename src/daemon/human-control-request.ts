import { resolveTargetDevice, type ResolveDeviceFlags } from '../core/dispatch-resolve.ts';
import { uniqueStrings } from '@agent-device/kernel/collections';
import { humanControlEffectForRequest } from './daemon-command-registry.ts';
import type { HumanControlRegistry } from './human-control.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonRequest, SessionState } from './types.ts';

export async function runRequestWithHumanControl<T>(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  registry: HumanControlRegistry | undefined;
  task: () => Promise<T>;
}): Promise<T> {
  const { req, sessionName, sessionStore, registry, task } = params;
  if (!registry || humanControlEffectForRequest(req) !== 'mutate') return await task();

  const aliases = await resolveRequestDeviceAliases(req, sessionStore.get(sessionName));
  return await registry.runDeviceMutation(aliases, task);
}

async function resolveRequestDeviceAliases(
  req: DaemonRequest,
  session: SessionState | undefined,
): Promise<string[]> {
  const requestAliases = readRequestDeviceAliases(req);
  if (session) {
    return uniqueDefinedStrings([
      session.device.id,
      session.device.name,
      session.lease?.deviceKey,
      ...requestAliases,
    ]);
  }

  const directHoldAliases = uniqueDefinedStrings(requestAliases);
  try {
    const device = await resolveTargetDevice(resolveDeviceFlags(req));
    return uniqueDefinedStrings([device.id, device.name, ...directHoldAliases]);
  } catch {
    // Preserve the command's normal device-resolution error. Requests carrying a
    // remote deviceKey or explicit UDID/serial are still gated by those aliases.
    return directHoldAliases;
  }
}

function resolveDeviceFlags(req: DaemonRequest): ResolveDeviceFlags {
  return {
    ...(req.flags ?? {}),
    leaseProvider: req.meta?.leaseProvider,
    deviceKey: req.meta?.deviceKey,
    clientId: req.meta?.clientId,
  };
}

function readRequestDeviceAliases(req: DaemonRequest): Array<string | undefined> {
  return [
    req.meta?.deviceKey,
    req.internal?.admittedLease?.deviceKey,
    req.flags?.udid,
    req.flags?.serial,
    req.flags?.device,
  ].map((value) => (typeof value === 'string' ? value : undefined));
}

function uniqueDefinedStrings(values: Array<string | undefined>): string[] {
  return uniqueStrings(
    values
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim()),
  );
}
