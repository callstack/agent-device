import { defineConfig } from 'tsdown';
import { providerPluginBuildConfig } from '@agent-device/build-config';

export default defineConfig({
  ...providerPluginBuildConfig,
  entry: { ...providerPluginBuildConfig.entry, 'adb-server': 'src/adb-server.mjs' },
  deps: { ...providerPluginBuildConfig.deps, alwaysBundle: [/^@agent-device\//, 'ws'] },
});
