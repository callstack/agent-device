import type { MacOsRunner } from '@agent-device/contracts/macos-platform-leaf';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAppleRunnerCommand } from './runner-client.ts';

/**
 * The Apple XCTest runner bound to one macOS device. The owner keeps the runner's build, session,
 * and transport; the leaf sends only the runner's macOS wire cases through this capability.
 */
export function macOsRunner(
  device: DeviceInfo,
  run: typeof runAppleRunnerCommand = runAppleRunnerCommand,
): MacOsRunner {
  return { run: async (command, options) => await run(device, command, options) };
}
