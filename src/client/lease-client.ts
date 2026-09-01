import type {
  HumanControlHold,
  InternalRequestOptions,
  Lease,
} from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import { INTERNAL_COMMANDS } from '../command-catalog.ts';
import { isRecord } from '@agent-device/kernel/record';
import type { AgentDeviceClient } from './client-types.ts';
import { readOptionalString, readRequiredString } from './client-normalizers.ts';

export function createLeaseClient(
  execute: (
    command: string,
    positionals?: string[],
    options?: InternalRequestOptions,
  ) => Promise<Record<string, unknown>>,
): AgentDeviceClient['leases'] {
  const control = async (positionals: string[], options?: InternalRequestOptions) =>
    await execute(INTERNAL_COMMANDS.humanControl, positionals, options);
  return {
    allocate: async (options) =>
      normalizeLease(
        await execute(INTERNAL_COMMANDS.leaseAllocate, [], { ...options, leaseId: undefined }),
      ),
    heartbeat: async (options) =>
      normalizeLease(await execute(INTERNAL_COMMANDS.leaseHeartbeat, [], options)),
    release: async (options) => {
      const data = await execute(INTERNAL_COMMANDS.leaseRelease, [], options);
      return {
        released: data.released === true,
        provider: isRecord(data.provider) ? data.provider : undefined,
      };
    },
    humanControl: {
      list: async (options) => {
        const data = await control(['list'], options);
        if (!Array.isArray(data.holds))
          throw new AppError('COMMAND_FAILED', 'Daemon did not return human-control holds.');
        return data.holds.map(normalizeHumanControlHold);
      },
      put: async (id, input = {}, options) => {
        const data = await control(['put', id, JSON.stringify(input)], options);
        return normalizeHumanControlHold(data.hold);
      },
      remove: async (id, options) => (await control(['remove', id], options)).released === true,
    },
  };
}

function normalizeHumanControlHold(value: unknown): HumanControlHold {
  if (
    !isRecord(value) ||
    !isRecord(value.scope) ||
    (value.state !== 'active' && value.state !== 'activating') ||
    typeof value.createdAt !== 'number' ||
    typeof value.updatedAt !== 'number'
  ) {
    throw new AppError('COMMAND_FAILED', 'Daemon returned an invalid human-control hold.');
  }
  return {
    id: readRequiredString(value, 'id'),
    scope: {
      backend: readRequiredString(value.scope, 'backend') as HumanControlHold['scope']['backend'],
      leaseProvider: readOptionalString(value.scope, 'leaseProvider'),
      deviceKey: readRequiredString(value.scope, 'deviceKey'),
    },
    state: value.state,
    reason: readOptionalString(value, 'reason'),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}),
  };
}

function normalizeLease(data: Record<string, unknown>): Lease {
  const rawLease = data.lease;
  if (!isRecord(rawLease)) {
    throw new Error('Invalid lease response from daemon');
  }
  return {
    leaseId: readRequiredString(rawLease, 'leaseId'),
    tenantId: readRequiredString(rawLease, 'tenantId'),
    runId: readRequiredString(rawLease, 'runId'),
    backend: readRequiredString(rawLease, 'backend') as Lease['backend'],
    leaseProvider: readOptionalString(rawLease, 'leaseProvider'),
    clientId: readOptionalString(rawLease, 'clientId'),
    deviceKey: readOptionalString(rawLease, 'deviceKey'),
    createdAt: typeof rawLease.createdAt === 'number' ? rawLease.createdAt : undefined,
    heartbeatAt: typeof rawLease.heartbeatAt === 'number' ? rawLease.heartbeatAt : undefined,
    expiresAt: typeof rawLease.expiresAt === 'number' ? rawLease.expiresAt : undefined,
  };
}
