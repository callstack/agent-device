import type {
  HostCommandRequest,
  HostCommandRunner,
} from '@agent-device/contracts/platform-runtime-host';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { runCmd, whichCmd } from '@agent-device/host-kit/command';
import { guardedHostCommandArgv } from './platform-runtime-host-device-shell.ts';

/**
 * Uses host.env for lookup and explicit request overlays. Only request.cwd sets the spawn directory.
 * Without request.env, the enclosing command host owns environment inheritance.
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
