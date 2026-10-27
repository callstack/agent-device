import type {
  HostCommandRequest,
  HostCommandRunner,
} from '@agent-device/contracts/platform-runtime-host';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { runCmd, whichCmd } from '@agent-device/host-kit/command';
import { guardedHostCommandArgv } from './platform-runtime-host-device-shell.ts';

/**
 * The host command port both runtime hosts expose, built from the host environment each was handed
 * rather than the process one (#3794). A request that names no `env` is dispatched without an
 * environment, so the command host enclosing the call keeps owning what that command inherits.
 */
export function createHostCommandRunner(host: HostEnvironment): HostCommandRunner {
  const env = host.env;
  return Object.freeze({
    which: async (executable: string) =>
      (await whichCmd(executable, env)) ? executable : undefined,
    run: async (request: HostCommandRequest, signal?: AbortSignal) => {
      const result = await runCmd(request.executable, guardedHostCommandArgv(request), {
        allowFailure: request.allowFailure,
        cwd: request.cwd,
        env: request.env ? { ...env, ...request.env } : undefined,
        signal,
        timeoutMs: request.timeoutMs,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  });
}
