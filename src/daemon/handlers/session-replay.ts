import type { DaemonResponse } from '../types.ts';
import { runReplayScriptSource } from './session-replay-runtime.ts';
import {
  runReplayTestSuiteCommand,
  type ReplayTestSuiteCommandParams,
} from './session-test-suite-command.ts';

/**
 * The replay family's routing decision, and only that: a `replay` request is one script run, a
 * `test` request is a suite of them, and anything else belongs to another handler family. Both
 * arms' orchestration lives in its own module (`session-replay-runtime.ts`,
 * `session-test-suite-command.ts`).
 */
export async function handleSessionReplayCommands(
  params: ReplayTestSuiteCommandParams,
): Promise<DaemonResponse | null> {
  const { req, sessionName, logPath, sessionStore, invoke } = params;

  if (req.command === 'replay') {
    return await runReplayScriptSource({
      req,
      sessionName,
      logPath,
      sessionStore,
      invoke,
    });
  }

  if (req.command === 'test') {
    return await runReplayTestSuiteCommand(params);
  }

  return null;
}
