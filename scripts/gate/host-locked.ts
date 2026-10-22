// Heavy gates take the host validation lock that `pnpm check:affected --run` and `pnpm check` hold,
// so concurrent worktrees queue instead of oversubscribing the host.
//
// A gate that already runs under that lock sees the inherited owner receipt and runs directly.
// GitHub runners are single-tenant and run the gate directly.

import path from 'node:path';
import { runCmdStreaming } from '@agent-device/host-kit/command';
import { acquireValidationLock, VALIDATION_PARENT_ENV } from '../check-affected/host-lock.ts';
import { getCheckSpec } from '../check-affected/checks.ts';

const COMMAND_RUNNER = path.join(import.meta.dirname, '..', 'check-affected', 'command.ts');
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

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
  const [executable, ...args] = command as [string, ...string[]];
  const stream = {
    allowFailure: true,
    onStdoutChunk: (chunk: string) => void process.stdout.write(chunk),
    onStderrChunk: (chunk: string) => void process.stderr.write(chunk),
  };
  if (!requiresHostLock(id, env)) {
    return (await runCmdStreaming(executable, args, { cwd, env, ...stream })).exitCode;
  }

  const controller = new AbortController();
  let cancelled = 0;
  const cancel = (signal: keyof typeof SIGNAL_EXIT_CODES) => () => {
    cancelled = SIGNAL_EXIT_CODES[signal];
    controller.abort();
  };
  const handlers = (Object.keys(SIGNAL_EXIT_CODES) as (keyof typeof SIGNAL_EXIT_CODES)[]).map(
    (signal) => [signal, cancel(signal)] as const,
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);

  const receipt = `gate:${id}`;
  let lock: Awaited<ReturnType<typeof acquireValidationLock>> | undefined;
  let commandPid: number | undefined;
  try {
    lock = await acquireValidationLock(
      controller.signal,
      execution.lockDirPath,
      execution.report,
      env,
    );
    lock.recordCommand(receipt, null);
    const result = await runCmdStreaming(
      process.execPath,
      ['--experimental-strip-types', COMMAND_RUNNER, executable, ...args],
      {
        ...stream,
        cwd,
        env: { ...env, [VALIDATION_PARENT_ENV]: receipt },
        captureOutput: false,
        detached: true,
        kill: { signal: 'SIGTERM', graceMs: 5000 },
        signal: controller.signal,
        stdin: 'run\n',
        onSpawn: (child) => {
          commandPid = child.pid;
          if (commandPid) lock?.recordCommand(receipt, commandPid);
        },
      },
    );
    return cancelled || result.exitCode;
  } catch (error) {
    if (cancelled) return cancelled;
    throw error;
  } finally {
    try {
      await lock?.finishCommand(commandPid);
    } finally {
      await lock?.release();
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }
  }
}
