import type { RunnerCommand } from './runner-contract.ts';
import type { RunnerCommandAccounting } from './runner-session-types.ts';

/**
 * The runner journal vocabulary, so charge settlement, status recovery, and the drain of a canceled
 * command cannot disagree about what a state means. `runner-swift-settlement-fixtures.ts` pins these
 * names to `RunnerCommandLifecycleState`, and the recovery wiring rows are derived from that same
 * declaration, so a state the runner gains has to be ruled here before it can decide a handoff.
 *
 * `completed` and `failed` close an entry — from the response's `ok` in `finish`, or a thrown error in
 * `fail` — so execution ended. `accepted` and `started` are written as execution opens, so they share
 * one in-flight verdict. `notAccepted` is what `status` reports for an id the journal never held,
 * which this daemon cannot read as terminal.
 */
const RUNNER_TERMINAL_LIFECYCLE_STATES: ReadonlySet<string> = new Set(['completed', 'failed']);
export const RUNNER_IN_FLIGHT_LIFECYCLE_STATES: ReadonlySet<string> = new Set([
  'accepted',
  'started',
]);

/**
 * Discharges the abandoned charge terminal status proves landed (#2965). A status reply is served
 * inline, so it is no evidence that queued work finished; this is the only place a status answer may
 * settle a charge, and only the one its `statusCommandId` names.
 *
 * @returns whether the evidence paid a debt, or `undefined` when the state is not terminal and no
 *   settlement was attempted.
 */
export function settleRunnerChargeForTerminalStatus(
  session: { commandCharges: RunnerCommandAccounting },
  command: Pick<RunnerCommand, 'commandId'>,
  lifecycleState: string,
): boolean | undefined {
  if (!RUNNER_TERMINAL_LIFECYCLE_STATES.has(lifecycleState)) return undefined;
  return session.commandCharges.settleTerminalEvidence(command.commandId);
}
