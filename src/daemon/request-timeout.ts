import type { DaemonRequest } from './types.ts';
import { resolveCommandTimeoutPolicy } from '../core/command-descriptor/registry.ts';
import { REQUEST_TIMEOUT_BUDGET_MARGIN_MS } from '../core/command-descriptor/timeout-policy.ts';
import type {
  CommandTimeoutBudget,
  CommandTimeoutPolicy,
} from '../core/command-descriptor/types.ts';

type BoundedTimeoutPolicy = CommandTimeoutPolicy & { envelopeMs: number };
type FlagTimeoutBudget = Extract<CommandTimeoutBudget, { source: 'flag' }>;
type RequestFlags = Omit<DaemonRequest, 'token'>['flags'];

// Derives the request envelope from the command's declared timeout policy
// (ADR 0008) instead of the former per-command-name special cases.
export function resolveDaemonRequestTimeoutMs(
  req: Omit<DaemonRequest, 'token'>,
): number | undefined {
  const policy = resolveCommandTimeoutPolicy(req.command);
  if (policy.envelopeMs === 'unbounded') return undefined;
  const boundedPolicy: BoundedTimeoutPolicy = { ...policy, envelopeMs: policy.envelopeMs };
  return (
    resolvePositionalBudgetTimeoutMs(boundedPolicy, req.positionals ?? []) ??
    resolveFlagBudgetTimeoutMs(boundedPolicy, req.flags) ??
    boundedPolicy.envelopeMs
  );
}

function resolvePositionalBudgetTimeoutMs(
  policy: BoundedTimeoutPolicy,
  positionals: string[],
): number | undefined {
  if (policy.budget.source !== 'positional-parser') return undefined;
  // The user budget travels inside the positionals (e.g. `wait ... 180000`).
  // Without extending the envelope past it, the request dies at the default
  // timeout with the runner/daemon torn down as collateral (#1075).
  const budgetMs = policy.budget.parser(positionals);
  return budgetMs === null ? undefined : widenToUserBudget(policy, budgetMs);
}

function resolveFlagBudgetTimeoutMs(
  policy: BoundedTimeoutPolicy,
  flags: RequestFlags,
): number | undefined {
  if (policy.budget.source !== 'flag') return undefined;
  // 'widen' budgets (interaction --settle, #1101) bound an internal wait the
  // request must outlive after selector resolution/action overhead. They are
  // settle-gated for touch-command back-compat: a bare timeoutMs without
  // --settle was historically ignored. Plain 'bound' budgets (replay,
  // prepare, snapshot) replace the envelope verbatim.
  if (policy.budget.envelope === 'widen') {
    return resolveWideningFlagBudget(policy, policy.budget, flags);
  }
  return typeof flags?.timeoutMs === 'number' ? flags.timeoutMs : policy.envelopeMs;
}

function resolveWideningFlagBudget(
  policy: BoundedTimeoutPolicy,
  budget: FlagTimeoutBudget,
  flags: RequestFlags,
): number {
  if (flags?.settle !== true) return policy.envelopeMs;
  const budgetMs = typeof flags.timeoutMs === 'number' ? flags.timeoutMs : budget.defaultBudgetMs;
  return typeof budgetMs === 'number' ? widenPastBaseEnvelope(policy, budgetMs) : policy.envelopeMs;
}

function widenToUserBudget(policy: BoundedTimeoutPolicy, budgetMs: number): number {
  return Math.max(policy.envelopeMs, budgetMs + REQUEST_TIMEOUT_BUDGET_MARGIN_MS);
}

function widenPastBaseEnvelope(policy: BoundedTimeoutPolicy, budgetMs: number): number {
  return Math.max(
    policy.envelopeMs,
    policy.envelopeMs + budgetMs + REQUEST_TIMEOUT_BUDGET_MARGIN_MS,
  );
}
