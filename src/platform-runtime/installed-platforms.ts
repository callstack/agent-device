import type { OptionalPlatform } from '@agent-device/contracts/platform-module';
import { OPTIONAL_PLATFORMS } from '@agent-device/contracts/platform-module';
import type { PlatformModuleSelection } from '@agent-device/contracts/platform-plugin';
import { getOptionalPlatformPluginDeclaration } from '@agent-device/contracts/plugin-installation';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { PROVIDER_PLUGIN_POLICY } from '../provider-plugin-policy.ts';
import { builtinPlatformCandidates, composePlatformPlugins } from './platform-plugins.ts';
import { createPlatformPluginHost } from './plugin-host.ts';

export type InstalledPlatforms = Readonly<{
  platforms: PlatformModuleSelection;
  /** Runs every set-up plugin's cleanup. The caller that started the registry owns this call. */
  close(): Promise<void>;
}>;

/**
 * The platform selection of a process that runs outside the daemon: the bundled families reserve
 * their claims, then the plugin store's platform packages set up under a `'platforms'`-scoped
 * registry, so no provider or replay backend loads. `family` narrows the store packages to the one
 * family a command needs; without it every installed platform package sets up. `stateDir` is the
 * state dir of the calling process, resolved as the daemon resolves its own.
 */
export async function startInstalledPlatforms(
  host: HostEnvironment,
  stateDir: string | undefined,
  family?: OptionalPlatform,
): Promise<InstalledPlatforms> {
  const [
    { resolveProviderPlugins, startProviderRegistry },
    { storePluginCandidates, createPluginSelectionGuard },
  ] = await Promise.all([
    import('@agent-device/plugins/registry'),
    import('@agent-device/plugins/store'),
  ]);
  const families: readonly OptionalPlatform[] = family ? [family] : OPTIONAL_PLATFORMS;
  const packages = new Set(
    families.map((optional) => getOptionalPlatformPluginDeclaration(optional)?.package),
  );
  const installed = await storePluginCandidates(host.env);
  const candidates = installed.filter(
    (candidate) =>
      packages.has(candidate.package) ||
      candidate.declaredClaims?.some(
        ({ kind, id, appleOs }) =>
          kind === 'platform' &&
          (family === undefined || (id === family && appleOs === undefined)),
      ),
  );
  const resolved = await resolveProviderPlugins([...builtinPlatformCandidates(), ...candidates]);
  const assertSelectionCurrent = createPluginSelectionGuard(installed, host.env);
  const daemonPaths = resolveDaemonPaths(stateDir, { env: host.env, cwd: host.cwd });
  const registry = await startProviderRegistry(
    resolved,
    host,
    {
      ...PROVIDER_PLUGIN_POLICY,
      assertSelectionCurrent,
      platformHost: createPlatformPluginHost(host, daemonPaths.baseDir, {
        sessionsDir: daemonPaths.sessionsDir,
      }),
    },
    'platforms',
  );
  try {
    return Object.freeze({
      platforms: composePlatformPlugins(
        registry.platforms,
        registry.inventory,
        assertSelectionCurrent,
        registry.platformLeaves,
      ),
      close: async () => {
        await registry.close();
      },
    });
  } catch (error) {
    await registry.close();
    throw error;
  }
}
