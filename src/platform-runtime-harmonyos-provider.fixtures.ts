import { createRequire } from 'node:module';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import { composePlatformPlugins } from './platform-runtime/platform-plugins.ts';
import { createPlatformPluginHost } from './platform-runtime/plugin-host.ts';
import type {
  HarmonyPlatformRegistration,
  HarmonyPlatformSelection,
} from '@agent-device/contracts/platform-plugin';
import type { PlatformHost } from '@agent-device/plugins/contract';

const pluginRequire = createRequire(
  new URL('../packages/platform-harmonyos/package.json', import.meta.url),
);
const { default: harmonyPlatformPlugin } = (await import(
  pluginRequire.resolve('@agent-device/harmonyos/agent-device')
)) as {
  default(): { contributes: [{ setup(host: PlatformHost): HarmonyPlatformRegistration }] };
};

export function harmonySelectionFixture(
  host: HostEnvironment = createLiveTestHostEnvironment(),
  stateDir = '/test-harmony-state',
): HarmonyPlatformSelection {
  const active = harmonyPlatformPlugin().contributes[0].setup(
    createPlatformPluginHost(host, stateDir),
  );
  return { active, get: () => active };
}

export function harmonyPlatformCompositionFixture(
  ...args: Parameters<typeof harmonySelectionFixture>
) {
  return composePlatformPlugins([harmonySelectionFixture(...args).get()], []);
}
