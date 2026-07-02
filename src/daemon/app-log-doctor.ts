import { isIosFamily, isMacOs, type DeviceInfo } from '../kernel/device.ts';
import { runXcrun } from '../platforms/apple/core/tool-provider.ts';
import { runAndroidAdb } from '../platforms/android/adb.ts';
import { runCmd } from '../utils/exec.ts';
import { checkIosDeviceConsoleCaptureSupport } from './app-log-ios.ts';

export type AppLogDoctorResult = {
  checks: Record<string, boolean>;
  notes: string[];
};

export async function runAppLogDoctor(
  device: DeviceInfo,
  appBundleId?: string,
): Promise<AppLogDoctorResult> {
  const checks: Record<string, boolean> = {};
  const notes = buildAppLogDoctorNotes(appBundleId);

  if (device.platform === 'android') {
    Object.assign(checks, await runAndroidAppLogDoctor(device, appBundleId));
  }
  if (isIosFamily(device) && device.kind === 'simulator') {
    Object.assign(checks, await runIosSimulatorAppLogDoctor());
  }
  if (isIosFamily(device) && device.kind === 'device') {
    const result = await runIosDeviceAppLogDoctor();
    Object.assign(checks, result.checks);
    notes.push(...result.notes);
  }
  if (isMacOs(device)) {
    Object.assign(checks, await runMacOsAppLogDoctor());
  }
  return { checks, notes };
}

function buildAppLogDoctorNotes(appBundleId: string | undefined): string[] {
  if (appBundleId) return [];
  return ['No app bundle is tracked in this session. Run open <app> first for app-scoped logs.'];
}

async function runAndroidAppLogDoctor(
  device: DeviceInfo,
  appBundleId?: string,
): Promise<Record<string, boolean>> {
  const checks: Record<string, boolean> = {};
  try {
    const adb = await runAndroidAdb(device, ['shell', 'echo', 'ok'], {
      allowFailure: true,
      timeoutMs: 1_000,
    });
    checks.adbAvailable = adb.exitCode === 0;
  } catch {
    checks.adbAvailable = false;
  }
  if (!appBundleId) return checks;

  try {
    const pidof = await runAndroidAdb(device, ['shell', 'pidof', appBundleId], {
      allowFailure: true,
      timeoutMs: 1_000,
    });
    checks.androidPidVisible = pidof.stdout.trim().length > 0;
  } catch {
    checks.androidPidVisible = false;
  }
  return checks;
}

async function runIosSimulatorAppLogDoctor(): Promise<Record<string, boolean>> {
  try {
    const simctl = await runXcrun(['simctl', 'help'], { allowFailure: true });
    return { simctlAvailable: simctl.exitCode === 0 };
  } catch {
    return { simctlAvailable: false };
  }
}

async function runIosDeviceAppLogDoctor(): Promise<AppLogDoctorResult> {
  const checks: Record<string, boolean> = {};
  const notes: string[] = [];
  try {
    const devicectl = await runXcrun(['devicectl', '--version'], { allowFailure: true });
    checks.devicectlAvailable = devicectl.exitCode === 0;
  } catch {
    checks.devicectlAvailable = false;
  }
  if (!checks.devicectlAvailable) return { checks, notes };

  const consoleCapture = await checkIosDeviceConsoleCaptureSupport();
  checks.devicectlConsoleCapture = consoleCapture.supported;
  if (!consoleCapture.supported) {
    if (consoleCapture.reason === 'probe-failed') {
      notes.push(
        'Could not verify iOS physical-device app console capture support. Retry after devicectl is responsive, then rerun logs doctor.',
      );
    } else {
      notes.push(
        'Installed devicectl does not expose scriptable iOS physical-device app console capture. Markers can still be written, but app output is not being captured by agent-device on this toolchain.',
      );
    }
  }
  return { checks, notes };
}

async function runMacOsAppLogDoctor(): Promise<Record<string, boolean>> {
  try {
    const log = await runCmd('log', ['help'], { allowFailure: true });
    return { logAvailable: log.exitCode === 0 };
  } catch {
    return { logAvailable: false };
  }
}
