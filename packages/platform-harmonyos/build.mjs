import { build } from 'tsdown';
import {
  assertManagedPlatformPluginFactory,
  managedPlatformPluginBuildConfig,
} from '@agent-device/build-config';
import harmonyPlatformPlugin from './src/index.ts';

assertManagedPlatformPluginFactory(
  new URL('./package.json', import.meta.url),
  harmonyPlatformPlugin,
  'HarmonyOS',
);

await build(managedPlatformPluginBuildConfig);
