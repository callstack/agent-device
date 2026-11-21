import path from 'node:path';
import type { PlatformHost } from 'agent-device/plugins';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { sleep } from '@agent-device/host-kit/retry';
import type {
  LinuxCommandOptions,
  LinuxCommandResult,
  LinuxDetachedExit,
} from '@agent-device/contracts/linux-tool-provider';

/**
 * The plugin's route to host commands, bound to the `PlatformHost` the core handed `setup()`. The
 * core owns the spawn environment, the exec trace and the filesystem probe, so a `--debug` log shows
 * what this family ran under its request id, and a tool the host cannot execute answers the same way
 * for an availability probe as for the spawn that probe authorized.
 *
 * Every spawn and every availability check goes through that host rather than this bundle's own copy
 * of the host kit: the daemon's command scope never enters the bundled copy, so a spawn made from it
 * would run with the daemon process environment instead of the host environment captured for the
 * request, and would drop the family's traces.
 */
export type LinuxCommandRunner = Readonly<{
  run(
    cmd: string,
    args: readonly string[],
    options?: LinuxCommandOptions,
  ): Promise<LinuxCommandResult>;
  /** True when the host resolves `cmd` on its `PATH`, or when `cmd` names an executable path. */
  which(cmd: string): Promise<boolean>;
  /**
   * Starts `cmd` detached with its output discarded and answers how it ended. A desktop app outlives
   * the command that opened it, so nothing awaits this beyond its exit report.
   */
  launchDetached(
    cmd: string,
    args: readonly string[],
  ): Readonly<{ exited: Promise<LinuxDetachedExit> }>;
  /** Records one family diagnostic in the request's diagnostic store. */
  diagnose(
    event: Readonly<{
      level: 'debug' | 'info' | 'warn' | 'error';
      phase: string;
      data: Record<string, unknown>;
    }>,
  ): void;
  /** Paces synthesized input steps, on the host clock the family's requests already run under. */
  sleep(milliseconds: number): Promise<void>;
}>;

export function createLinuxCommandRunner(host: PlatformHost): LinuxCommandRunner {
  const env = host.env;
  return Object.freeze({
    run: async (cmd, args, options) => await host.runCommand(cmd, [...args], { ...options, env }),
    which: async (cmd) => await hostResolvesExecutable(host, env, cmd),
    launchDetached: (cmd, args) => {
      // A host that cannot start a process outliving the request cannot open a desktop app: waiting
      // on a spawned binary would hold the request open for the app's whole life, so the family
      // refuses on the spot rather than approximating it with a blocking spawn.
      if (!host.launchDetached) {
        throw new AppError('UNSUPPORTED_OPERATION', `Cannot start ${cmd} on this host.`, {
          reason: 'host-launch-unavailable',
          command: cmd,
        });
      }
      return {
        exited: host
          .launchDetached(cmd, [...args], { env })
          .then((launched) => launched.exited)
          .catch((error: unknown) => ({ pid: 0, error: normalizeError(error).message })),
      };
    },
    diagnose: (event) => host.emitDiagnostic(event),
    sleep: async (milliseconds) => await sleep(milliseconds),
  });
}

/**
 * Whether the host can execute `cmd`. An absolute name is asked of the host directly; a bare name is
 * looked up in the host `PATH` entries through the same host authority, so a probe and a spawn cannot
 * disagree about a tool, and neither reads the filesystem on its own (ADR 0019).
 */
async function hostResolvesExecutable(
  host: PlatformHost,
  env: Readonly<Record<string, string | undefined>>,
  cmd: string,
): Promise<boolean> {
  const candidate = cmd.trim();
  if (!candidate) return false;
  if (candidate.startsWith('/')) return await host.isFileExecutable(candidate);
  const directories = (env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const directory of directories) {
    if (await host.isFileExecutable(joinHostPath(directory, candidate))) return true;
  }
  return false;
}

function joinHostPath(directory: string, file: string): string {
  return path.join(directory, file);
}
