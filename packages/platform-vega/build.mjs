import { readFileSync } from 'node:fs';
import { build } from 'tsdown';
import { providerPluginBuildConfig } from '@agent-device/build-config';
import vegaPlatformPlugin from './src/index.ts';

const { 'agent-device': manifest } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
const { apiVersion, contributes } = vegaPlatformPlugin();
const [platform] = contributes;
if (
  apiVersion !== manifest.apiVersion ||
  contributes.length !== 1 ||
  platform.kind !== 'platform' ||
  platform.family !== manifest.platform
) {
  throw new Error('The managed Vega factory must match its package claim');
}

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
