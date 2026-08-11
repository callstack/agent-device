import type { NetworkIncludeMode } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { defineUse } from './platform-runtime-operations.ts';

export const networkDumpUse = defineUse({ required: ['networkDump'] });

/** Fact-only capability projection; it is not an execution-plan variant. */
export const networkAdmissionUse = defineUse({
  required: [],
  preferred: ['networkDump'],
});

export type NetworkRuntimeAction = 'dump' | 'log';

export type NetworkRuntimePlan = Readonly<{
  action: NetworkRuntimeAction;
  include: NetworkIncludeMode;
  use: typeof networkDumpUse;
}>;

export type NetworkRuntimePlanInput = Readonly<{
  action?: string;
  include?: string;
}>;

const ACTIONS = ['dump', 'log'] as const;
const INCLUDES = ['summary', 'headers', 'body', 'all'] as const;

export function resolveNetworkRuntimePlan(input: NetworkRuntimePlanInput): NetworkRuntimePlan {
  const action = (input.action ?? 'dump').toLowerCase();
  const include = (input.include ?? 'summary').toLowerCase();
  if (!isNetworkRuntimeAction(action)) {
    throw new AppError('INVALID_ARGS', 'network requires dump or log');
  }
  if (!isNetworkIncludeMode(include)) {
    throw new AppError('INVALID_ARGS', 'network --include must be summary, headers, body, or all');
  }
  return Object.freeze({ action, include, use: networkDumpUse });
}

function isNetworkRuntimeAction(value: string): value is NetworkRuntimeAction {
  return ACTIONS.some((action) => action === value);
}

function isNetworkIncludeMode(value: string): value is NetworkIncludeMode {
  return INCLUDES.some((include) => include === value);
}
