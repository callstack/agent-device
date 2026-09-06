import type { CommandTimeoutBudget, CommandTimeoutPolicy } from './types.ts';

// Request-envelope constants, relocated from src/daemon/request-timeouts.ts when
// timeout policy joined the descriptor registry (ADR 0008): the envelopes are now
// declared per command on the descriptors, so their values live beside them.

const DAEMON_REQUEST_TIMEOUT_MS = 90_000;
export const PREPARE_REQUEST_TIMEOUT_MS = 240_000;

// Keep this above the longest platform install subprocess timeout so the client
// envelope does not abort a still-progressing device install first.
export const INSTALL_REQUEST_TIMEOUT_MS = 180_000;

// Margin over a daemon-side budget so the daemon's own timeout result (with
// diagnostics) wins the race against the client envelope. Never shrinks the
// envelope below the command's declared base.
const REQUEST_TIMEOUT_BUDGET_MARGIN_MS = 30_000;

/**
 * How long a lease lifecycle provider may spend allocating one lease (cloud
 * device allocation: BrowserStack iOS ~45–90s, AWS remote access ~2 min to
 * RUNNING). Handed to providers as `LeaseLifecycleContext.deadline`; the
 * client's `lease_allocate` envelope derives from it so they cannot drift.
 */
export const LEASE_ALLOCATION_BUDGET_MS = 300_000;

export const LEASE_ALLOCATE_REQUEST_TIMEOUT_MS =
  LEASE_ALLOCATION_BUDGET_MS + REQUEST_TIMEOUT_BUDGET_MARGIN_MS;

/**
 * The timeout policy most commands share: standard envelope, no user-supplied
 * budget, and a daemon reset on timeout (a hung request usually means daemon
 * state is suspect). Referenced explicitly by each descriptor — required, not
 * inherited — so adding a command forces a decision (ADR 0008). Also the
 * fallback for command names outside the registry (internal probes, unknown
 * commands), which matches the old hand lists: not listed meant default
 * envelope + reset-daemon.
 */
export const DEFAULT_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  budget: { source: 'none' },
  envelopeMs: DAEMON_REQUEST_TIMEOUT_MS,
  onTimeout: 'reset-daemon',
};

type BoundedTimeoutPolicy = CommandTimeoutPolicy & { envelopeMs: number };
type FlagTimeoutBudget = Extract<CommandTimeoutBudget, { source: 'flag' }>;
type RequestTimeoutInput = Readonly<{
  positionals?: string[];
  flags?: Readonly<{ timeoutMs?: number; settle?: boolean }>;
}>;

/** Resolves the request envelope from its declared policy and user-supplied budget. */
export function resolveCommandRequestTimeoutMs(
  policy: CommandTimeoutPolicy,
  input: RequestTimeoutInput,
): number | undefined {
  if (policy.envelopeMs === 'unbounded') return undefined;
  const boundedPolicy: BoundedTimeoutPolicy = { ...policy, envelopeMs: policy.envelopeMs };
  return (
    resolvePositionalBudgetTimeoutMs(boundedPolicy, input.positionals ?? []) ??
    resolveFlagBudgetTimeoutMs(boundedPolicy, input.flags) ??
    boundedPolicy.envelopeMs
  );
}

function resolvePositionalBudgetTimeoutMs(
  policy: BoundedTimeoutPolicy,
  positionals: string[],
): number | undefined {
  if (policy.budget.source !== 'positional-parser') return undefined;
  const budgetMs = policy.budget.parser(positionals);
  return budgetMs === null ? undefined : widenToUserBudget(policy, budgetMs);
}

function resolveFlagBudgetTimeoutMs(
  policy: BoundedTimeoutPolicy,
  flags: RequestTimeoutInput['flags'],
): number | undefined {
  if (policy.budget.source !== 'flag') return undefined;
  if (policy.budget.envelope === 'widen') {
    return resolveWideningFlagBudget(policy, policy.budget, flags);
  }
  return typeof flags?.timeoutMs === 'number' ? flags.timeoutMs : policy.envelopeMs;
}

function resolveWideningFlagBudget(
  policy: BoundedTimeoutPolicy,
  budget: FlagTimeoutBudget,
  flags: RequestTimeoutInput['flags'],
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
