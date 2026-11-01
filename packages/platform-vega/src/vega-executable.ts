import path from 'node:path';
import { isExecutablePath, whichCmd } from '@agent-device/host-kit/command';
import { hostHomeDirectoryFromEnv } from '@agent-device/host-kit/host-file';
import type { EnvMap } from '@agent-device/kernel/source-value';

/**
 * The host ports one Vega executable lookup needs — the same three the device-inventory host
 * exposes (`commands.which`, `files.isExecutable`, `homeDirectory`) — so inventory, doctor and
 * the CLI adapter all resolve through one resolver over their runtime host (#3794). A host that
 * names no home omits `homeDirectory`; then the default-install probe is skipped, never guessed
 * from the process (#3753).
 */
export type VegaExecutableHost = Readonly<{
  which: (executable: string) => Promise<string | undefined>;
  isExecutableFile: (candidate: string) => Promise<boolean>;
  homeDirectory: string | undefined;
}>;

/** One lookup: PATH first, then the host home's default install, else nothing. */
export function resolveVegaExecutable(host: VegaExecutableHost): Promise<string | undefined> {
  return lookupVegaExecutable(host);
}

async function lookupVegaExecutable(host: VegaExecutableHost): Promise<string | undefined> {
  if (await host.which('vega')) return 'vega';
  if (host.homeDirectory === undefined) return undefined;
  const defaultInstall = path.join(host.homeDirectory, 'vega', 'bin', 'vega');
  return (await host.isExecutableFile(defaultInstall)) ? defaultInstall : undefined;
}

/**
 * Derives the resolver's ports from a runtime host environment: PATH through the host env, the
 * home through the host env's own HOME/USERPROFILE, never the process home. A host env that names
 * no home yields no `homeDirectory`, and the resolver then skips the default-install probe.
 * `createDeviceInventoryHost` derives its `homeDirectory` with the same helper, so the inventory
 * route and this one agree.
 */
export function createVegaExecutableHostFromEnv(env: EnvMap): VegaExecutableHost {
  return Object.freeze({
    which: async (executable: string) =>
      (await whichCmd(executable, env)) ? executable : undefined,
    isExecutableFile: async (candidate: string) => await isExecutablePath(candidate),
    homeDirectory: hostHomeDirectoryFromEnv(env),
  });
}
