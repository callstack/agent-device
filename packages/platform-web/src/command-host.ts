import type { PlatformHost } from 'agent-device/plugins';

/** What the host answered a command: its streams and its exit code. */
export type WebCommandResult = Awaited<ReturnType<PlatformHost['runCommand']>>;

/**
 * How one managed-backend call runs. The environment arrives whole: the backend needs its own
 * `HOME`, socket dir and launch marker per command, so the caller builds that environment from the
 * host it was given rather than letting a spawn inherit a bare one.
 */
export type WebRunOptions = Readonly<{
  env?: PlatformHost['env'];
  allowFailure?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Written to the child's stdin, for the command that reads its work from it (`batch`). */
  stdin?: string;
}>;

/**
 * The plugin's route to host commands, bound to the `PlatformHost` the core handed `setup()`. The
 * core owns the spawn and the exec trace, so a `--debug` log shows this family's backend calls under
 * its request id.
 *
 * Every spawn, executable probe and process-table read goes through that host rather than this
 * bundle's own copy of the host kit: the daemon's command scope never enters the bundled copy, so a
 * spawn made from it would run with the daemon process environment instead of the host environment
 * captured for the request, and would drop the family's traces. Only host-kit *types* are imported
 * here, which cost the bundle nothing.
 */
export type WebCommandRunner = Readonly<{
  run(
    executable: string,
    args: readonly string[],
    options?: WebRunOptions,
  ): Promise<WebCommandResult>;
}>;

/** Binds the host the plugin was set up with. Nothing is read from it until a command runs. */
export function createWebCommandRunner(host: PlatformHost): WebCommandRunner {
  return Object.freeze({
    run: async (executable, args, options) =>
      await host.runCommand(executable, [...args], { ...options }),
  });
}
