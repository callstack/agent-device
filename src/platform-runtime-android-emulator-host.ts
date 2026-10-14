import type { DeviceReadinessRuntimeHost } from '@agent-device/contracts/device-readiness-runtime';
import { listLocalDeviceInventory } from '@agent-device/device-selection/device-inventory-context';
import { runCmd, runCmdDetached } from '@agent-device/host-kit/command';
import { stopPidsWithEscalation } from '@agent-device/host-kit/process';

const LSAPPINFO_PID = /"pid"=(\d+)/;

// The macOS emulator has no flag to open its window without activating, so this JXA script waits
// for the emulator to become frontmost and reactivates the app that was frontmost before it.
// argv: emulator pid, frontmost pid before launch, watch budget in ms.
const RETURN_FOCUS_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const emulatorPid = Number(argv[0]);
  let previousPid = Number(argv[1]);
  const deadline = Date.now() + Number(argv[2]);
  const workspace = $.NSWorkspace.sharedWorkspace;
  while (Date.now() < deadline) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
    const front = workspace.frontmostApplication;
    const frontPid = front.isNil() ? 0 : front.processIdentifier;
    if (frontPid !== emulatorPid) {
      if (frontPid !== 0) previousPid = frontPid;
      continue;
    }
    const previous = $.NSRunningApplication.runningApplicationWithProcessIdentifier(previousPid);
    if (!previous.isNil()) previous.activateWithOptions(0);
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
    launch: async (avdName, headless, bootBudgetMs) => {
      const args = ['-avd', avdName];
      if (headless) args.push('-no-window', '-no-audio');
      const frontmostPid =
        !headless && hostPlatform === 'darwin'
          ? await readFrontmostAppPid().catch(() => undefined)
          : undefined;
      const pid = runCmdDetached('emulator', args);
      if (frontmostPid !== undefined) {
        runCmdDetached('osascript', [
          '-l',
          'JavaScript',
          '-e',
          RETURN_FOCUS_SCRIPT,
          String(pid),
          String(frontmostPid),
          String(bootBudgetMs),
        ]);
      }
      return pid;
    },
    terminate: async (pid) => {
      await stopPidsWithEscalation({ pids: [pid], termTimeoutMs: 1_500, killTimeoutMs: 1_500 });
    },
  });
}

async function readFrontmostAppPid(): Promise<number | undefined> {
  const front = await runCmd('/usr/bin/lsappinfo', ['front'], {
    allowFailure: true,
    timeoutMs: 1_000,
  });
  const asn = front.stdout.trim();
  if (!asn) return undefined;
  const info = await runCmd('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn], {
    allowFailure: true,
    timeoutMs: 1_000,
  });
  const pid = LSAPPINFO_PID.exec(info.stdout)?.[1];
  return pid === undefined ? undefined : Number(pid);
}
