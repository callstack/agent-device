// Heavy gates take the host validation lock that `pnpm check:affected --run` and `pnpm check` hold,
// so concurrent worktrees queue instead of oversubscribing the host.
//
// A gate that already runs under that lock sees the inherited owner receipt and runs directly.
// GitHub runners are single-tenant and run the gate directly.

import { runCmdStreaming } from '@agent-device/host-kit/command';
import {
  acquireValidationLock,
  runLockedCommand,
  VALIDATION_PARENT_ENV,
} from '../check-affected/host-lock.ts';
import { getCheckSpec } from '../check-affected/checks.ts';
import { abortOnTerminationSignal } from '../check-affected/termination.ts';

export type GateExecution = {
  id: string;
  command: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  lockDirPath?: string;
  report?: (message: string) => void;
};

export function requiresHostLock(id: string, env: NodeJS.ProcessEnv): boolean {
  return (
    getCheckSpec(id).hostLocked &&
    (process.platform === 'darwin' || process.platform === 'linux') &&
    env.GITHUB_ACTIONS !== 'true' &&
    !env[VALIDATION_PARENT_ENV]
  );
}

export async function executeGate(execution: GateExecution): Promise<number> {
  const { id, command, cwd, env } = execution;
  const stream = {
    onStdoutChunk: (chunk: string) => void process.stdout.write(chunk),
    onStderrChunk: (chunk: string) => void process.stderr.write(chunk),
  };
  if (!requiresHostLock(id, env)) {
    const [executable, ...args] = command as [string, ...string[]];
    return (await runCmdStreaming(executable, args, { cwd, env, allowFailure: true, ...stream }))
      .exitCode;
  }

  const controller = new AbortController();
  const { cancellation, dispose } = abortOnTerminationSignal(controller);
  let lock: Awaited<ReturnType<typeof acquireValidationLock>> | undefined;
  try {
    lock = await acquireValidationLock(
      controller.signal,
      execution.lockDirPath,
      execution.report,
      env,
    );
    const exitCode = await runLockedCommand(lock, `gate:${id}`, command, {
      cwd,
      env,
      signal: controller.signal,
      ...stream,
    });
    return cancellation.code || exitCode;
  } catch (error) {
    if (cancellation.code) return cancellation.code;
    throw error;
  } finally {
    try {
      await lock?.release();
    } finally {
      dispose();
    }
  }
}
