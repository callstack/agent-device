import { createRequire } from 'node:module';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import type {
  MacOsPlatformLeafRegistration,
  MacOsPlatformLeafSelection,
} from '@agent-device/contracts/macos-platform-leaf';
import type { PlatformModuleSelection } from '@agent-device/contracts/platform-plugin';
import type { PlatformHost } from '@agent-device/plugins/contract';
import type { PluginCandidate } from '@agent-device/plugins/registry';
import { bindPlatformLeaves, composePlatformPlugins } from './platform-runtime/platform-plugins.ts';
import { createPlatformPluginHost } from './platform-runtime/plugin-host.ts';

const pluginRequire = createRequire(
  new URL('../packages/platform-macos/package.json', import.meta.url),
);
const { default: macOsPlatformPlugin } = (await import(
  pluginRequire.resolve('@agent-device/macos/agent-device')
)) as {
  default(): { contributes: [{ setup(host: PlatformHost): MacOsPlatformLeafRegistration }] };
};

/** The macOS package as a host that embeds the runtime hands it to the daemon composition. */
export function macOsPluginCandidateFixture(): PluginCandidate {
  return { source: 'embedder', package: '@agent-device/macos', load: () => macOsPlatformPlugin() };
}

/** The macOS leaf as the managed `@agent-device/macos` package registers it. */
export function macOsLeafSelectionFixture(
  host: HostEnvironment = createLiveTestHostEnvironment(),
  stateDir = '/test-macos-state',
): MacOsPlatformLeafSelection {
  const active = macOsPlatformPlugin().contributes[0].setup(
    createPlatformPluginHost(host, stateDir),
  );
  return { active, get: () => active };
}

/**
 * The platform selection of a process with the macOS package installed and no other platform
 * plugin. It binds the leaf to the bundled Apple owner, as the daemon's composition does.
 */
export function macOsPlatformCompositionFixture(
  ...args: Parameters<typeof macOsLeafSelectionFixture>
): PlatformModuleSelection {
  const platforms = composePlatformPlugins([], [], undefined, [
    macOsLeafSelectionFixture(...args).get(),
  ]);
  bindPlatformLeaves(platforms);
  return platforms;
}
