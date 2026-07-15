import { AppError } from '../../kernel/errors.ts';
import { runCmdSync } from '../../utils/exec.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { isAgentDeviceDaemonProcess } from '../daemon-process.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { resolveCommandTimeoutPolicy } from '../../core/command-descriptor/registry.ts';
import type {
  CommandTimeoutBudget,
  CommandTimeoutPolicy,
} from '../../core/command-descriptor/types.ts';
import type { DaemonRequest } from '../types.ts';
import type { DaemonPaths } from '../config.ts';
import {
  removeDaemonInfo,
  removeDaemonLock,
  stopDaemonProcessForTakeover,
  type DaemonInfo,
} from './daemon-client-metadata.ts';

const IOS_RUNNER_XCODEBUILD_KILL_PATTERNS = [
  'xcodebuild .*AgentDeviceRunnerUITests/RunnerTests/testCommand',
  'xcodebuild .*AgentDeviceRunner\\.env\\.session-',
  'xcodebuild build-for-testing .*apple/runner/AgentDeviceRunner/AgentDeviceRunner\\.xcodeproj',
];

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

export function handleRequestTimeout(
  info: DaemonInfo,
  statePaths: DaemonPaths,
  requestId: string | undefined,
  command: string | undefined,
  remote: boolean,
  timeoutMs: number,
): AppError {
  const cleanup = remote ? { terminated: 0 } : cleanupTimedOutIosRunnerBuilds();
  const resetDaemon = !remote && shouldResetDaemonAfterRequestTimeout(command);
  const daemonReset = resetDaemon
    ? resetDaemonAfterTimeout(info, statePaths)
    : { forcedKill: false };
  emitDiagnostic({
    level: 'error',
    phase: 'daemon_request_timeout',
    data: {
      timeoutMs,
      requestId,
      command,
      timedOutRunnerPidsTerminated: cleanup.terminated,
      timedOutRunnerCleanupError: cleanup.error,
      daemonPidReset: resetDaemon ? info.pid : undefined,
      daemonPidForceKilled: resetDaemon ? daemonReset.forcedKill : undefined,
      daemonPreservedAfterTimeout: !remote && !resetDaemon,
      daemonBaseUrl: info.baseUrl,
    },
  });
  return new AppError('COMMAND_FAILED', 'Daemon request timed out', {
    timeoutMs,
    requestId,
    hint: resolveRequestTimeoutHint({ remote, resetDaemon, command }),
  });
}

// Whether a timed-out request tears down the local daemon is declared on the
// command's descriptor (ADR 0008, `timeoutPolicy.onTimeout`): read-only
// capture/polling commands preserve the daemon so sessions survive and evidence
// commands still work; everything else resets it. Unknown/undefined commands
// fall back to the default reset-daemon policy.
export function shouldResetDaemonAfterRequestTimeout(command: string | undefined): boolean {
  return resolveCommandTimeoutPolicy(command).onTimeout === 'reset-daemon';
}

function resolveRequestTimeoutHint(params: {
  remote: boolean;
  resetDaemon: boolean;
  command: string | undefined;
}): string {
  const { remote, resetDaemon, command } = params;
  if (remote) {
    return 'Retry with --debug and verify the remote daemon URL, auth token, and remote host logs.';
  }
  if (!resetDaemon) {
    const iosPrepareHint =
      command === PUBLIC_COMMANDS.snapshot
        ? ' If this was the first Apple-platform snapshot on the device, run agent-device prepare ios-runner with the same --platform before snapshot/test so runner startup is handled explicitly.'
        : '';
    return `Retry with --debug and check daemon diagnostics logs. The timed-out ${command ?? 'request'} request was canceled and Apple runner work was aborted when detected; the daemon was kept alive so the session can still be closed or inspected.${iosPrepareHint}`;
  }
  return 'Retry with --debug and check daemon diagnostics logs. Timed-out Apple runner xcodebuild processes were terminated when detected.';
}

function cleanupTimedOutIosRunnerBuilds(): { terminated: number; error?: string } {
  let terminated = 0;
  try {
    for (const pattern of IOS_RUNNER_XCODEBUILD_KILL_PATTERNS) {
      const result = runCmdSync('pkill', ['-f', pattern], { allowFailure: true });
      if (result.exitCode === 0) terminated += 1;
    }
    return { terminated };
  } catch (error) {
    return {
      terminated,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resetDaemonAfterTimeout(info: DaemonInfo, paths: DaemonPaths): { forcedKill: boolean } {
  let forcedKill = false;
  try {
    if (isAgentDeviceDaemonProcess(info.pid, info.processStartTime)) {
      process.kill(info.pid, 'SIGKILL');
      forcedKill = true;
    }
  } catch {
    void stopDaemonProcessForTakeover(info);
  } finally {
    removeDaemonInfo(paths.infoPath);
    removeDaemonLock(paths.lockPath);
  }
  return { forcedKill };
}

// Margin over a user-supplied budget so the daemon-side timeout result (with
// diagnostics) wins the race against the client envelope. Never shrinks the
// envelope below the command's declared base.
const REQUEST_TIMEOUT_BUDGET_MARGIN_MS = 30_000;
