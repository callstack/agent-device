import { build } from 'tsdown';
import {
  assertManagedPlatformPluginFactory,
  managedPlatformPluginBuildConfig,
} from '@agent-device/build-config';
import linuxPlatformPlugin from './src/index.ts';

assertManagedPlatformPluginFactory(
  new URL('./package.json', import.meta.url),
  linuxPlatformPlugin,
  'Linux',
);

await build(managedPlatformPluginBuildConfig);
