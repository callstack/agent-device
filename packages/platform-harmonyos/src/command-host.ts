import path from 'node:path';
import type { PlatformHost } from 'agent-device/plugins';

/** What the host answered a command: its streams and its exit code. */
export type HarmonyCommandResult = Awaited<ReturnType<PlatformHost['runCommand']>>;

export type HarmonyRunOptions = Readonly<{
  allowFailure?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

/**
 * The plugin's route to host commands, bound to the `PlatformHost` the core handed `setup()`. The
 * core owns executable resolution, the spawn environment, and the exec trace, so a `--debug` log
 * shows what this family ran under its request id.
 *
 * Every spawn and every toolchain probe goes through that host rather than this bundle's own copy of
 * the host kit: the daemon's command scope never enters the bundled copy, so a spawn made from it
 * would run with the daemon process environment instead of the host environment captured for the
 * request, and would drop the family's traces. Only host-kit *types* are imported here, which cost
 * the bundle nothing.
 *
 * Each command is launched with the documented HarmonyOS toolchain roots prepended to `PATH`, so this
 * family resolves the same HDC an interactive shell does while the core names no HarmonyOS
 * configuration.
 */
export type HarmonyCommandRunner = Readonly<{
  /** `executable` is an absolute path from a configured root, or a name the host `PATH` resolves. */
  run(
    executable: string,
    args: readonly string[],
    options?: HarmonyRunOptions,
  ): Promise<HarmonyCommandResult>;
  /**
   * HDC to spawn: an absolute path from a documented toolchain root when one carries it, else the
   * bare `hdc` for the host `PATH` to resolve. Host-minted commands need the path, because the core
   * builds their environment without this family's roots.
   */
  resolveHdc(): Promise<string>;
  /** True when a documented root carries an executable HDC, so no `PATH` lookup is needed. */
  toolchainHdc(): Promise<string | undefined>;
}>;

/**
 * Binds the host the plugin was set up with. Toolchain roots are probed per command, so tooling
 * installed while a daemon runs is picked up without a restart.
 */
export function createHarmonyCommandRunner(host: PlatformHost): HarmonyCommandRunner {
  const env = host.env;
  const isExecutable = (candidate: string) => host.isFileExecutable(candidate);
  return Object.freeze({
    run: async (executable, args, options) =>
      await host.runCommand(executable, [...args], {
        ...options,
        env: await harmonySpawnEnvironment(env, isExecutable),
      }),
    resolveHdc: async () => (await harmonyToolchainHdc(env, isExecutable)) ?? 'hdc',
    toolchainHdc: async () => await harmonyToolchainHdc(env, isExecutable),
  });
}

/**
 * DevEco's command-line tools do not amend `PATH` for non-interactive processes. Honoring the
 * documented roots here means the daemon spawns the HDC an interactive shell resolves, without the
 * core naming HarmonyOS configuration and without this plugin reading the host environment or the
 * filesystem itself (ADR 0019): both come from the host it was set up with.
 */
async function harmonySpawnEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  isExecutable: (candidate: string) => Promise<boolean>,
): Promise<Readonly<Record<string, string>>> {
  const root = await harmonyToolchainRoot(env, isExecutable);
  const currentEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const entries = root
    ? [root, ...currentEntries.filter((entry) => entry !== root)]
    : currentEntries;
  const spawnEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) spawnEnv[key] = value;
  }
  spawnEnv.PATH = entries.join(path.delimiter);
  return spawnEnv;
}

/** HDC from the first documented root that carries it, if any. */
async function harmonyToolchainHdc(
  env: Readonly<Record<string, string | undefined>>,
  isExecutable: (candidate: string) => Promise<boolean>,
): Promise<string | undefined> {
  const root = await harmonyToolchainRoot(env, isExecutable);
  return root ? path.join(root, 'hdc') : undefined;
}

/**
 * The first documented root holding an executable HDC, checked in the documented order so
 * `HDC_SDK_PATH` wins over `DEVECO_SDK_HOME`, which wins over the command-line tools home.
 */
async function harmonyToolchainRoot(
  env: Readonly<Record<string, string | undefined>>,
  isExecutable: (candidate: string) => Promise<boolean>,
): Promise<string | undefined> {
  const roots = [
    env.HDC_SDK_PATH,
    env.DEVECO_SDK_HOME
      ? path.join(env.DEVECO_SDK_HOME, 'default', 'openharmony', 'toolchains')
      : undefined,
    env.HARMONYOS_COMMAND_LINE_TOOLS
      ? path.join(env.HARMONYOS_COMMAND_LINE_TOOLS, 'sdk', 'default', 'openharmony', 'toolchains')
      : undefined,
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const root of roots) {
    if (await isExecutable(path.join(root, 'hdc'))) return root;
  }
  return undefined;
}
