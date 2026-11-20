import { BUILTIN_PLATFORM_PLUGINS } from './register-builtins.ts';
import { registerPlatformPluginSet } from '../platform-plugin-registry.ts';
import { missingPlatformPlugin } from '../platform-plugin-absence.ts';
import type { PlatformPlugin } from '@agent-device/contracts/platform-plugin';

export const builtinPlatformPlugins = registerPlatformPluginSet<PlatformPlugin>(
  BUILTIN_PLATFORM_PLUGINS,
  missingPlatformPlugin,
);
