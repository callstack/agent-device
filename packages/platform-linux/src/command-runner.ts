import type { PlatformHost } from 'agent-device/plugins';
import { normalizeError } from '@agent-device/kernel/errors';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  DetachedCommandExit,
  HostOperatingSystem,
} from '@agent-device/contracts/platform-runtime-host';
import type {
  LinuxCommandOptions,
  LinuxCommandResult,
} from '@agent-device/contracts/linux-tool-provider';

/**
 * The plugin's route to host commands, bound to the `PlatformHost` the core handed `setup()`. The
 * core owns the spawn environment, the exec trace and every host probe, so a `--debug` log shows what
 * this family ran under its request id, and a tool the host cannot execute answers the same way for
 * the availability probe as for the spawn that probe authorized.
 *
 * Every spawn, availability check and file probe goes through that host rather than this bundle's own
 * copy of the host kit: the daemon's command scope never enters the bundled copy, so a spawn made
 * from it would run with the daemon process environment instead of the host environment captured for
 * the request, and would drop the family's traces.
 */
export type LinuxCommandRunner = Readonly<{
  run(
    cmd: string,
    args: readonly string[],
    options?: LinuxCommandOptions,
  ): Promise<LinuxCommandResult>;
  /** The operating system of the host the family was set up with. */
  hostOs: HostOperatingSystem;
  /**
   * True when the host can execute `cmd`: it looks a bare name up in the host `PATH` and asks an
   * absolute path of the host filesystem. One host primitive answers both shapes.
   */
  which(cmd: string): Promise<boolean>;
  /**
   * True when the host has `path` at all, executable or not. The family asks this of the helper it
   * ships beside its own code: the file is not a host tool, so its absence names a broken install.
   */
  isFilePresent(path: string): Promise<boolean>;
  /**
   * Starts `cmd` detached with its output discarded and answers how it ended. A desktop app outlives
   * the command that opened it, so nothing awaits this beyond its exit report.
   */
  launchDetached(
    cmd: string,
    args: readonly string[],
  ): Readonly<{ exited: Promise<DetachedCommandExit> }>;
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
    hostOs: host.hostOs,
    // One host primitive answers both shapes: `whichCmd` behind it asks an absolute path of the
    // filesystem and looks a bare name up in the host `PATH`, so a probe and the spawn it authorizes
    // read one environment and one authority (ADR 0019).
    which: async (cmd) => await host.isExecutableOnPath(cmd),
    isFilePresent: async (path) => await host.isFilePresent(path),
    launchDetached: (cmd, args) => ({
      // The host owns the detached spawn, so the exit it reports arrives through the request's own
      // exec trace. A spawn that could not start rejects; that is an exit with `error`.
      exited: host
        .launchDetached(cmd, [...args], { env })
        .then((launched) => launched.exited)
        .catch((error: unknown) => ({ pid: 0, error: normalizeError(error).message })),
    }),
    diagnose: (event) => host.emitDiagnostic(event),
    sleep: async (milliseconds) => await sleep(milliseconds),
  });
}
