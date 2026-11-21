import type { PlatformHost } from 'agent-device/plugins';
import { hostHomeDirectoryFromEnv } from '@agent-device/host-kit/host-file';
import { resolveVegaExecutable, type VegaExecutableHost } from './vega-executable.ts';
import type {
  VegaCommandOptions,
  VegaCommandResult,
} from '@agent-device/contracts/vega-tool-provider';

export type {
  VegaCommandOptions,
  VegaCommandResult,
} from '@agent-device/contracts/vega-tool-provider';

/**
 * The plugin's route to the Vega CLI, bound to the `PlatformHost` the core handed `setup()`. The
 * core owns resolving the CLI against the request environment, the spawn environment, and the exec
 * trace, so a `--debug` log shows this family's CLI calls under its request id.
 *
 * Every call goes through that host rather than this bundle's own copy of the host kit: the daemon's
 * command scope never enters the bundled copy, so a spawn made from it would run with the daemon
 * process environment instead of the host environment captured for the request, and would drop this
 * family's traces.
 */
export type VegaCommandRunner = Readonly<{
  /** The CLI to run: `vega` when the host's `PATH` resolves it, else the host home's default install. */
  resolveExecutable(): Promise<string | undefined>;
  /**
   * Runs one CLI call through the host. A CLI the host cannot start arrives as the host's typed
   * `TOOL_MISSING` rejection; {@link VegaCommandRunner.resolveExecutable} is how a caller predicts
   * that before it asks for a spawn.
   */
  run(args: readonly string[], options?: VegaCommandOptions): Promise<VegaCommandResult>;
}>;

/**
 * Binds the host the plugin was set up with. The CLI is resolved per call, so a CLI installed while a
 * daemon runs is picked up without a restart.
 */
export function createVegaCommandRunner(host: PlatformHost): VegaCommandRunner {
  const executableHost = vegaExecutableHost(host);
  let resolved: string | undefined;
  const resolveExecutable = async () => {
    // Only a found CLI is memoized: a refusal is not, so a CLI installed after a miss still resolves.
    if (resolved) return resolved;
    resolved = await resolveVegaExecutable(executableHost);
    return resolved;
  };
  return Object.freeze({
    resolveExecutable,
    run: async (args, options) =>
      await host.runCommand((await resolveExecutable()) ?? 'vega', [...args], {
        ...(options?.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
  });
}

/**
 * The two host ports one Vega lookup needs — the host `PATH` and the host's own home — so no part of
 * this family searches `PATH` or reads the process home by itself (ADR 0019).
 */
function vegaExecutableHost(host: PlatformHost): VegaExecutableHost {
  return Object.freeze({
    which: async (executable: string) =>
      (await host.isExecutableOnPath(executable)) ? executable : undefined,
    isExecutableFile: (candidate: string) => host.isFileExecutable(candidate),
    homeDirectory: hostHomeDirectoryFromEnv(host.env),
  });
}
