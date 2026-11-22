import { build } from 'tsdown';
import {
  assertManagedPlatformPluginFactory,
  managedPlatformPluginBuildConfig,
} from '@agent-device/build-config';
import macOsPlatformPlugin from './src/index.ts';

assertManagedPlatformPluginFactory(
  new URL('./package.json', import.meta.url),
  macOsPlatformPlugin,
  'macOS',
);

await build(managedPlatformPluginBuildConfig);
