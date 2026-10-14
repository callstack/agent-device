import type { DeviceReadinessRuntimeHost } from '@agent-device/contracts/device-readiness-runtime';
import { listLocalDeviceInventory } from '@agent-device/device-selection/device-inventory-context';
import { runCmdDetached } from '@agent-device/host-kit/command';
import { stopPidsWithEscalation } from '@agent-device/host-kit/process';

const FOCUS_RETURN_WINDOW_MS = 30_000;

// The macOS emulator has no flag to open its window without activating, so this JXA script waits
// for the emulator to become frontmost and reactivates the app that was frontmost before it.
const RETURN_FOCUS_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const emulatorPid = Number(argv[0]);
  const deadline = Date.now() + Number(argv[1]);
  const workspace = $.NSWorkspace.sharedWorkspace;
  let previousPid = 0;
  while (Date.now() < deadline) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
    const front = workspace.frontmostApplication;
    const frontPid = front.isNil() ? 0 : front.processIdentifier;
    if (frontPid !== emulatorPid) {
      previousPid = frontPid;
      continue;
    }
    const previous = $.NSRunningApplication.runningApplicationWithProcessIdentifier(previousPid);
    if (previousPid !== 0 && !previous.isNil()) previous.activateWithOptions(0);
    return;
  }
}`;

export function createAndroidEmulatorHost(
  hostPlatform: NodeJS.Platform = process.platform,
): DeviceReadinessRuntimeHost['androidEmulator'] {
  return Object.freeze({
    discover: async (request, signal) => {
      signal.throwIfAborted();
      const devices = await listLocalDeviceInventory(request);
      signal.throwIfAborted();
      return devices;
    },
    launch: (avdName, headless) => {
      const args = ['-avd', avdName];
      if (headless) args.push('-no-window', '-no-audio');
      const pid = runCmdDetached('emulator', args);
      if (!headless && hostPlatform === 'darwin') {
        runCmdDetached('osascript', [
          '-l',
          'JavaScript',
          '-e',
          RETURN_FOCUS_SCRIPT,
          String(pid),
          String(FOCUS_RETURN_WINDOW_MS),
        ]);
      }
      return pid;
    },
    terminate: async (pid) => {
      await stopPidsWithEscalation({ pids: [pid], termTimeoutMs: 1_500, killTimeoutMs: 1_500 });
    },
  });
}
