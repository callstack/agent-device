import { AppError } from '@agent-device/kernel/errors';
import { parseHumanControlHoldInput, type HumanControlHold } from '../human-control-contract.ts';
import { releaseHumanControlHold, type HumanControlRegistry } from '../human-control.ts';
import type { DaemonRequest, DaemonResponse } from '../types.ts';

export async function handleHumanControlCommand(params: {
  req: DaemonRequest;
  registry: HumanControlRegistry | undefined;
  onHoldReleased?: (hold: HumanControlHold) => void;
}): Promise<DaemonResponse> {
  const { req, registry, onHoldReleased } = params;
  if (!registry) {
    throw new AppError('COMMAND_FAILED', 'Human-control registry is unavailable.');
  }
  const [action, holdId, rawInput] = req.positionals ?? [];
  if (action === 'list') return { ok: true, data: { holds: registry.list() } };
  if (action === 'put') return await putHold(registry, holdId, rawInput);
  if (action === 'remove') return removeHold(registry, holdId, onHoldReleased);
  throw new AppError('INVALID_ARGS', 'human_control requires list, put, or remove.');
}

async function putHold(
  registry: HumanControlRegistry,
  holdId: string | undefined,
  rawInput: string | undefined,
): Promise<DaemonResponse> {
  if (!holdId || rawInput === undefined) {
    throw new AppError('INVALID_ARGS', 'human_control put requires a hold id and payload.');
  }
  const hold = await registry.upsert(holdId, parseHumanControlHoldInput(parsePayload(rawInput)));
  return { ok: true, data: { hold, state: 'active' } };
}

function removeHold(
  registry: HumanControlRegistry,
  holdId: string | undefined,
  onHoldReleased: ((hold: HumanControlHold) => void) | undefined,
): DaemonResponse {
  if (!holdId) {
    throw new AppError('INVALID_ARGS', 'human_control remove requires a hold id.');
  }
  const hold = releaseHumanControlHold(registry, holdId);
  if (hold) onHoldReleased?.(hold);
  return { ok: true, data: { released: Boolean(hold), ...(hold ? { hold } : {}) } };
}

function parsePayload(rawInput: string): unknown {
  try {
    return JSON.parse(rawInput) as unknown;
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      'Human-control payload must be valid JSON.',
      undefined,
      error,
    );
  }
}
