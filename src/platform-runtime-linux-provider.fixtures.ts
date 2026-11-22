import { createRequire } from 'node:module';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import { composePlatformPlugins } from './platform-runtime/platform-plugins.ts';
import { createPlatformPluginHost } from './platform-runtime/plugin-host.ts';
import type {
  LinuxPlatformRegistration,
  LinuxPlatformSelection,
} from '@agent-device/contracts/platform-plugin';
import type { PlatformHost } from '@agent-device/plugins/contract';

const pluginRequire = createRequire(
  new URL('../packages/platform-linux/package.json', import.meta.url),
);
const { default: linuxPlatformPlugin } = (await import(
  pluginRequire.resolve('@agent-device/linux/agent-device')
)) as {
  default(): { contributes: [{ setup(host: PlatformHost): LinuxPlatformRegistration }] };
};

export function linuxSelectionFixture(
  host: HostEnvironment = createLiveTestHostEnvironment(),
  stateDir = '/test-linux-state',
): LinuxPlatformSelection {
  return linuxSelectionFromPlatformHost(createPlatformPluginHost(host, stateDir));
}

/**
 * The Linux selection a caller installs for one `PlatformHost`.
 *
 * The family answers every desktop intent through the host its `setup` receives, so a test that wants
 * to drive it names that host rather than a provider: the plugin's own inventory, runtime, interactor
 * and tool plumbing are then the code under test.
 */
export function linuxSelectionFromPlatformHost(host: PlatformHost): LinuxPlatformSelection {
  const active = linuxPlatformPlugin().contributes[0].setup(host);
  return { active, get: () => active };
}

export function linuxPlatformCompositionFixture(...args: Parameters<typeof linuxSelectionFixture>) {
  return composePlatformPlugins([linuxSelectionFixture(...args).get()], []);
}
