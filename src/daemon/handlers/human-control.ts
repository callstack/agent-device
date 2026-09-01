import { AppError } from '@agent-device/kernel/errors';
import { getRequestSignal } from '@agent-device/host-kit/request';
import { parseHumanControlHoldInput } from '../human-control-contract.ts';
import type { LeaseRegistry } from '../lease-registry.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';

export async function handleHumanControlCommand(params: {
  req: DaemonRequest;
  registry: LeaseRegistry;
}): Promise<DaemonResponse> {
  const { req, registry } = params;
  const lease = req.internal?.admittedLease;
  if (!lease) {
    throw new AppError('UNAUTHORIZED', 'Human control requires an admitted remote lease.');
  }
  const authority = { kind: 'lease', leaseId: lease.leaseId } as const;
  const positionals = req.positionals ?? [];
  const [action, holdId = '', rawInput = ''] = positionals;
  switch (action) {
    case 'list':
      assertArgumentCount(positionals, 1);
      return { ok: true, data: { holds: registry.listHumanControlHolds(authority) } };
    case 'put': {
      assertArgumentCount(positionals, 3);
      const hold = await registry.putHumanControlHold(
        authority,
        holdId,
        readHoldInput(rawInput),
        getRequestSignal(req.meta?.requestId),
      );
      return { ok: true, data: { hold, state: 'active' } };
    }
    case 'remove': {
      assertArgumentCount(positionals, 2);
      const hold = registry.removeHumanControlHold(authority, holdId);
      return { ok: true, data: { released: Boolean(hold), ...(hold ? { hold } : {}) } };
    }
    default:
      throw invalidArguments();
  }
}

function readHoldInput(raw: string) {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      'Human-control payload must be valid JSON.',
      undefined,
      error,
    );
  }
  return parseHumanControlHoldInput(input);
}

function assertArgumentCount(positionals: string[], expected: number): void {
  if (positionals.length !== expected) throw invalidArguments();
}

function invalidArguments(): AppError {
  return new AppError(
    'INVALID_ARGS',
    'human_control requires list, put <id> <payload>, or remove <id>.',
  );
}
