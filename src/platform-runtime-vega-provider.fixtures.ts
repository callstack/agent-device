import { createRequire } from 'node:module';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import { composePlatformPlugins } from './platform-runtime/platform-plugins.ts';
import { createPlatformPluginHost } from './platform-runtime/plugin-host.ts';
import type {
  VegaPlatformRegistration,
  VegaPlatformSelection,
} from '@agent-device/contracts/platform-plugin';
import type { PlatformHost } from '@agent-device/plugins/contract';

const pluginRequire = createRequire(
  new URL('../packages/platform-vega/package.json', import.meta.url),
);
const { default: vegaPlatformPlugin } = (await import(
  pluginRequire.resolve('@agent-device/vega/agent-device')
)) as {
  default(): { contributes: [{ setup(host: PlatformHost): VegaPlatformRegistration }] };
};

export function vegaSelectionFixture(
  host: HostEnvironment = createLiveTestHostEnvironment(),
  stateDir = '/test-vega-state',
): VegaPlatformSelection {
  const active = vegaPlatformPlugin().contributes[0].setup(
    createPlatformPluginHost(host, stateDir),
  );
  return { active, get: () => active };
}

export function vegaPlatformCompositionFixture(...args: Parameters<typeof vegaSelectionFixture>) {
  return composePlatformPlugins([vegaSelectionFixture(...args).get()], []);
}
