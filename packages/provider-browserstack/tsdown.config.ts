import { defineConfig } from 'tsdown';
import { providerPluginBuildConfig } from '@agent-device/build-config';

export default defineConfig({
  ...providerPluginBuildConfig,
  entry: {
    'agent-device': 'src/index.ts',
    'connection-verification': 'src/browserstack-connection-verification.ts',
  },
});
