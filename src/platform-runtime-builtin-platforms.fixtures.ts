import type { PlatformModuleSelection } from '@agent-device/contracts/platform-plugin';
import { composePlatformPlugins } from './platform-runtime/platform-plugins.ts';

/** The platform selection of a process with no installed platform plugin. */
export function builtinPlatformSelectionFixture(): PlatformModuleSelection {
  return composePlatformPlugins([], []);
}
