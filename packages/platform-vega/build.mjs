import { build } from 'tsdown';
import {
  assertManagedPlatformPluginFactory,
  managedPlatformPluginBuildConfig,
} from '@agent-device/build-config';
import vegaPlatformPlugin from './src/index.ts';

assertManagedPlatformPluginFactory(
  new URL('./package.json', import.meta.url),
  vegaPlatformPlugin,
  'Vega',
);

await build(managedPlatformPluginBuildConfig);
