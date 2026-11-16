import { defineConfig } from 'tsdown';
import { providerPluginBuildConfig } from '../../scripts/plugin-build-config.ts';

export default defineConfig({
  ...providerPluginBuildConfig,
  entry: {
    'agent-device': 'src/index.ts',
    'connection-verification': 'src/browserstack-connection-verification.ts',
  },
});
