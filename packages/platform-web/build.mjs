import { build } from 'tsdown';
import {
  assertManagedPlatformPluginFactory,
  managedPlatformPluginBuildConfig,
} from '@agent-device/build-config';
import webPlatformPlugin from './src/index.ts';

assertManagedPlatformPluginFactory(
  new URL('./package.json', import.meta.url),
  webPlatformPlugin,
  'web',
);

await build(managedPlatformPluginBuildConfig);
