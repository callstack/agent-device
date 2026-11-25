import { defineConfig } from 'tsdown';
import { providerPluginBuildConfig } from '@agent-device/build-config';

export default defineConfig({
  ...providerPluginBuildConfig,
  entry: {
    ...providerPluginBuildConfig.entry,
    'loopback-download-worker': 'src/loopback-download-worker.ts',
  },
  dts: true,
  tsconfig: '../../tsconfig.lib.json',
  deps: {
    ...providerPluginBuildConfig.deps,
    neverBundle: ['agent-device/plugins', 'agent-device/plugins/device-host'],
  },
});
