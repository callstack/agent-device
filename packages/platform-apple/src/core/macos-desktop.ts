import type {
  MacOsLeafOperations,
  MacOsLeafTools,
} from '@agent-device/contracts/macos-platform-leaf';
import { requireMacOsLeaf } from '../macos-leaf.ts';
import {
  hasScopedAppleToolProvider,
  readApplePlistJson,
  resolveAppleToolProvider,
} from './tool-provider.ts';

/**
 * The macOS operations of the installed leaf, bound to the Apple tools of the calling request.
 * The leaf runs every command through these tools, so a request that scopes its own Apple tools
 * reaches the leaf, and no command starts from the plugin's bundled copy of the host kit.
 */
export function macOsDesktop(): MacOsLeafOperations {
  return requireMacOsLeaf().bind(currentMacOsLeafTools());
}

function currentMacOsLeafTools(): MacOsLeafTools {
  const provider = resolveAppleToolProvider();
  return {
    runCommand: provider.runCommand,
    // The host-kit process and exec modules load with the first call that needs them, so this
    // binding stays off the eager closure of the façades that reach it (ADR 0019).
    listProcesses: async ({ timeoutMs }) => {
      const { listHostProcesses } = await import('@agent-device/host-kit/process');
      return await listHostProcesses({ runCommand: provider.runCommand, timeoutMs });
    },
    startBackground: async (cmd, args) => {
      const { runCmdBackground } = await import('@agent-device/host-kit/command');
      const { child, wait } = runCmdBackground(cmd, args, {
        allowFailure: true,
        captureOutput: true,
      });
      return {
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        wait,
        terminate: async () => {
          child.kill('SIGTERM');
          await wait.catch(() => {});
        },
      };
    },
    ...(provider.macosHelper ? { helper: provider.macosHelper } : {}),
    ...(provider.macosHost ? { host: provider.macosHost } : {}),
    readPlistJson: readApplePlistJson,
    scoped: hasScopedAppleToolProvider(),
  };
}
