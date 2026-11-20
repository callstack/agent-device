import { build } from 'tsdown';
import { providerPluginBuildConfig } from '@agent-device/build-config';

await build({
  ...providerPluginBuildConfig,
  config: false,
  dts: true,
  tsconfig: '../../tsconfig.lib.json',
  entry: { 'agent-device': 'src/index.ts' },
  deps: {
    ...providerPluginBuildConfig.deps,
    neverBundle: ['agent-device/plugins'],
  },
});
