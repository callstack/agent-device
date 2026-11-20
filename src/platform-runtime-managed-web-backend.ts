import type { ManagedWebBackend } from '@agent-device/contracts/managed-web-backend';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { PlatformSetup } from '@agent-device/plugins/contract';

export function createManagedWebBackend(host: HostEnvironment): ManagedWebBackend {
  return Object.freeze({
    setup: (options) =>
      withWebPlatform(host, options.stateDir, (web) => web.operations.setup(options)),
    doctor: (options) =>
      withWebPlatform(host, options.stateDir, (web) => web.operations.doctor(options)),
  });
}

async function withWebPlatform<T>(
  host: HostEnvironment,
  stateDir: string | undefined,
  run: (web: PlatformSetup<'web'>) => Promise<T>,
): Promise<T> {
  const [
    { resolveProviderPlugins, startProviderRegistry },
    { storePluginCandidates, createPluginSelectionGuard },
    { getOptionalPlatformPluginDeclaration },
    { createPlatformPluginHost },
    { resolveDaemonPaths },
    { builtinPlatformCandidates, composePlatformPlugins },
    { PROVIDER_PLUGIN_POLICY },
  ] = await Promise.all([
    import('@agent-device/plugins/registry'),
    import('@agent-device/plugins/store'),
    import('@agent-device/contracts/plugin-installation'),
    import('./platform-runtime/plugin-host.ts'),
    import('@agent-device/daemon-contracts/daemon-resolution'),
    import('./platform-runtime/platform-plugins.ts'),
    import('./provider-plugin-policy.ts'),
  ]);
  const packageName = getOptionalPlatformPluginDeclaration('web')?.package;
  const installed = await storePluginCandidates(host.env);
  const candidates = installed.filter(
    (candidate) =>
      candidate.package === packageName ||
      candidate.declaredClaims?.some(({ kind, id }) => kind === 'platform' && id === 'web'),
  );
  const resolved = await resolveProviderPlugins([...builtinPlatformCandidates(), ...candidates]);
  const assertSelectionCurrent = createPluginSelectionGuard(installed, host.env);
  const registry = await startProviderRegistry(
    resolved,
    host,
    {
      ...PROVIDER_PLUGIN_POLICY,
      assertSelectionCurrent,
      platformHost: createPlatformPluginHost(
        host,
        resolveDaemonPaths(stateDir, { env: host.env, cwd: host.cwd }).baseDir,
      ),
    },
    'platforms',
  );
  try {
    return await run(
      composePlatformPlugins(
        registry.platforms,
        registry.inventory,
        assertSelectionCurrent,
      ).web.get(),
    );
  } finally {
    await registry.close();
  }
}
