import { createRequire } from 'node:module';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import { composePlatformPlugins } from './platform-runtime/platform-plugins.ts';
import { createPlatformPluginHost } from './platform-runtime/plugin-host.ts';
import type {
  WebPlatformRegistration,
  WebPlatformSelection,
} from '@agent-device/contracts/platform-plugin';
import type { PlatformHost } from '@agent-device/plugins/contract';

const pluginRequire = createRequire(
  new URL('../packages/platform-web/package.json', import.meta.url),
);
const { default: webPlatformPlugin } = (await import(
  pluginRequire.resolve('@agent-device/web/agent-device')
)) as {
  default(): { contributes: [{ setup(host: PlatformHost): WebPlatformRegistration }] };
};

export function webSelectionFixture(
  host: HostEnvironment = createLiveTestHostEnvironment(),
  stateDir = '/test-web-state',
  resources?: Pick<PlatformHost, 'ownedProcessRecords' | 'openWebSessionNames'>,
): WebPlatformSelection {
  const active = webPlatformPlugin().contributes[0].setup(
    createPlatformPluginHost(host, stateDir, resources),
  );
  return { active, get: () => active };
}
export function webPlatformCompositionFixture(...args: Parameters<typeof webSelectionFixture>) {
  return composePlatformPlugins([webSelectionFixture(...args).get()], []);
}

import type { WebProvider } from '@agent-device/contracts/web-provider';

/** A web provider whose every operation succeeds with nothing; a test overrides the ones it reads. */
export function makeWebProvider(overrides: Partial<WebProvider> = {}): WebProvider {
  return {
    open: async () => {},
    close: async () => {},
    snapshot: async () => ({ nodes: [] }),
    screenshot: async () => {},
    setViewport: async () => {},
    click: async () => {},
    fill: async () => {},
    typeText: async () => {},
    scroll: async () => {},
    ...overrides,
  };
}
