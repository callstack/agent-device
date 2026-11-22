import type { PlatformHost } from 'agent-device/plugins';
import type { MacOsLeafTools } from '@agent-device/contracts/macos-platform-leaf';

/**
 * What every macOS operation runs with: the host the plugin was set up with, and the Apple tool
 * routes the Apple owner resolved for the request that called it. Commands go through `tools`, so a
 * request that scopes its own Apple tools reaches them. Locks, diagnostics, and machine facts go
 * through `host`. Nothing here starts a process from the plugin's own copy of the host kit.
 */
export type MacOsToolbox = Readonly<{ host: PlatformHost; tools: MacOsLeafTools }>;

export type MacOsRunCommand = MacOsLeafTools['runCommand'];
