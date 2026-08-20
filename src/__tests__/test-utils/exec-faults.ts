import type { CommandExecutorOverride, ExecOptions, ExecResult } from '../../utils/exec.ts';

export type RecordedCommand = Readonly<{
  command: string;
  args: readonly string[];
  options: ExecOptions;
}>;

export type FailNthCommandExecutor = Readonly<{
  override: CommandExecutorOverride;
  calls: () => readonly RecordedCommand[];
}>;

/**
 * Deterministic subprocess fault injection for provider tests. Every call is
 * recorded, exactly one ordinal rejects, and later calls still reach the
 * success result so a test can prove whether a caller replayed or stopped.
 */
export function createFailNthCommandExecutor(
  nthCall: number,
  failure: unknown = new Error('injected command failure'),
): FailNthCommandExecutor {
  if (!Number.isSafeInteger(nthCall) || nthCall < 1) {
    throw new RangeError('nthCall must be a positive safe integer');
  }

  let callCount = 0;
  const history: RecordedCommand[] = [];
  const override: CommandExecutorOverride = async (command, args, options) => {
    callCount += 1;
    history.push({ command, args: [...args], options: { ...options } });
    if (callCount === nthCall) throw failure;
    return successfulJsonResult();
  };

  return {
    override,
    calls: () => history,
  };
}

function successfulJsonResult(): ExecResult {
  return { stdout: JSON.stringify({ success: true, data: {} }), stderr: '', exitCode: 0 };
}
