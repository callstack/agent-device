import { AppError } from '../../../../kernel/errors.ts';
import { emitDiagnostic } from '../../../../utils/diagnostics.ts';
import type { RunnerCommand } from './runner-contract.ts';

// Caps how many times one daemon request may pay for a full runner recycle
// (invalidate + fresh xcodebuild boot, ~25s each). The #1105 wedge showed a
// single press request doing TWO full recycles before the client envelope
// killed the daemon: after one recycle the screen is proven hostile to
// capture, so the request must fail fast with an actionable hint instead of
// burning another boot. The request's FIRST boot (cold daemon) is not a
// recycle and stays free.
const MAX_RUNNER_RECYCLES_PER_REQUEST = 1;
const LEDGER_ENTRY_TTL_MS = 10 * 60_000;
const LEDGER_MAX_ENTRIES = 512;

type RunnerRecycleLedgerEntry = {
  touchedSession: boolean;
  recycles: number;
  lastAtMs: number;
};

const ledger = new Map<string, RunnerRecycleLedgerEntry>();

/** Requests are the recycle scope; direct calls without a request fall back to the command id. */
export function runnerRecycleLedgerKey(
  options: { requestId?: string },
  command: Pick<RunnerCommand, 'commandId'>,
): string | undefined {
  const requestId = options.requestId?.trim();
  if (requestId) return `request:${requestId}`;
  const commandId = command.commandId?.trim();
  if (commandId) return `command:${commandId}`;
  return undefined;
}

/** Marks that this request has used a runner session (so a later boot counts as a recycle). */
export function markRunnerRequestTouchedSession(key: string | undefined): void {
  if (!key) return;
  const entry = readEntry(key);
  entry.touchedSession = true;
  writeEntry(key, entry);
}

export function hasRunnerRequestTouchedSession(key: string | undefined): boolean {
  if (!key) return false;
  return ledger.get(key)?.touchedSession === true;
}

/**
 * Checks whether a request may attempt a recycle boot. The caller must pair a
 * successful boot with `commitRunnerRecycle`; failed boots stay free so a
 * transient xcodebuild/simulator startup failure does not spend the request's
 * only hostile-screen recovery slot.
 */
export function tryBeginRunnerRecycle(key: string | undefined): boolean {
  if (!key) return true;
  const entry = readEntry(key);
  if (entry.recycles >= MAX_RUNNER_RECYCLES_PER_REQUEST) {
    writeEntry(key, entry);
    return false;
  }
  writeEntry(key, entry);
  return true;
}

/** Consumes one recycle after the replacement runner has booted successfully. */
export function commitRunnerRecycle(key: string | undefined): void {
  if (!key) return;
  const entry = readEntry(key);
  entry.recycles += 1;
  writeEntry(key, entry);
}

export function buildRunnerRecycleBudgetExhaustedError(
  command: Pick<RunnerCommand, 'command' | 'commandId'>,
  options: { requestId?: string; logPath?: string },
): AppError {
  emitDiagnostic({
    level: 'warn',
    phase: 'ios_runner_recycle_budget_exhausted',
    data: {
      command: command.command,
      commandId: command.commandId,
      requestId: options.requestId,
      maxRecycles: MAX_RUNNER_RECYCLES_PER_REQUEST,
    },
  });
  return new AppError(
    'COMMAND_FAILED',
    `iOS runner was already restarted during this request and "${command.command}" still failed, so agent-device stopped instead of paying for another runner boot.`,
    {
      command: command.command,
      commandId: command.commandId,
      recovery: 'runner_recycle_budget_exhausted',
      hint: 'The current screen is overwhelming the iOS accessibility capture (usually heavy or animating content). The app session is preserved: run `screenshot` for visual truth and interact with coordinate commands, or navigate to another screen and retry. Re-running the same command immediately will likely wedge again.',
      logPath: options.logPath,
    },
  );
}

// Test isolation requires clearing process-global recycle accounting between cases.
export function resetRunnerRecycleLedgerForTests(): void {
  ledger.clear();
}

function readEntry(key: string): RunnerRecycleLedgerEntry {
  pruneLedger();
  return ledger.get(key) ?? { touchedSession: false, recycles: 0, lastAtMs: Date.now() };
}

function writeEntry(key: string, entry: RunnerRecycleLedgerEntry): void {
  entry.lastAtMs = Date.now();
  ledger.delete(key);
  ledger.set(key, entry);
}

function pruneLedger(): void {
  const cutoff = Date.now() - LEDGER_ENTRY_TTL_MS;
  for (const [key, entry] of ledger) {
    if (entry.lastAtMs < cutoff) ledger.delete(key);
  }
  while (ledger.size > LEDGER_MAX_ENTRIES) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
}
