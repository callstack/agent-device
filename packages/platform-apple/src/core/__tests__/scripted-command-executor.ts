import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';
import { requireExecSuccess, withCommandExecutorOverride } from '@agent-device/host-kit/command';

/**
 * The host commands the production adapters would spawn, answered from a script instead.
 *
 * This is the seam `runCmd` consults before it spawns anything, so the Apple tool provider runs its
 * real local adapter over it — including the screenshot protocol parse and its own failure
 * construction — and nothing is launched.
 *
 * The script answers with the tool's result, exactly as a spawned process reports it. A non-zero
 * exit that the caller did not ask to tolerate fails here, through the same host-kit
 * `requireExecSuccess` the exec layer uses, so a scripted failure carries the shape a real one does.
 */
export type ScriptedCommandCall = {
  cmd: string;
  args: readonly string[];
  options: ExecOptions;
};

export type ScriptedCommandScript = (call: ScriptedCommandCall) => ExecResult;

export type ScriptedCommandExecutor = {
  /** The commands the code under test asked the host to run, in order. */
  calls(): ScriptedCommandCall[];
};

/** Every command the script answers, whether or not the caller tolerated its failure. */
export async function withScriptedCommands<T>(
  script: ScriptedCommandScript,
  run: (executor: ScriptedCommandExecutor) => Promise<T>,
): Promise<T> {
  const recorded: ScriptedCommandCall[] = [];
  const executor: ScriptedCommandExecutor = {
    calls: () => recorded.map((call) => ({ ...call })),
  };
  return await withCommandExecutorOverride(
    async (cmd, args, options) => {
      const call = { cmd, args, options };
      recorded.push(call);
      const result = script(call);
      if (options.allowFailure) return result;
      return requireExecSuccess(result, `${cmd} exited with code ${result.exitCode}`, {
        cmd,
        args,
      });
    },
    async () => await run(executor),
  );
}

/** A command that succeeded and printed `stdout`, the shape a working `simctl` answers with. */
export function commandStdout(stdout: string): ExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

/** The command failed: `stderr` is what the tool printed, `exitCode` what it exited with. */
export function commandFailed(stderr: string, exitCode: number, stdout = ''): ExecResult {
  return { exitCode, stdout, stderr };
}

/** Whether one recorded command is the `simctl list devices -j` boot-state read. */
export function isSimctlListDevices(call: ScriptedCommandCall): boolean {
  return call.args[0] === 'simctl' && call.args.includes('list') && call.args.includes('-j');
}

/** Whether one recorded command is this simulator's screenshot capture: `simctl [--set …] io <udid> screenshot …`. */
export function isSimctlScreenshot(call: ScriptedCommandCall): boolean {
  const ioIndex = call.args.indexOf('io');
  return call.args[0] === 'simctl' && ioIndex >= 0 && call.args[ioIndex + 2] === 'screenshot';
}
