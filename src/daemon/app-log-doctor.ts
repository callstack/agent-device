import { isIosFamily, isMacOs, type DeviceInfo } from '../kernel/device.ts';
import { runXcrun } from '../platforms/apple/core/tool-provider.ts';
import { runAndroidAdb } from '../platforms/android/adb.ts';
import { runCmd } from '../utils/exec.ts';
import {
  checkIosDeviceConsoleCaptureSupport,
  IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED_NOTE,
  IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED_NOTE,
} from './app-log-ios.ts';

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
  checks.adbAvailable = await safeCheck(async () => {
    const adb = await runAndroidAdb(device, ['shell', 'echo', 'ok'], {
      allowFailure: true,
      timeoutMs: 1_000,
    });
    return adb.exitCode === 0;
  });
  if (!appBundleId) return checks;

  checks.androidPidVisible = await safeCheck(async () => {
    const pidof = await runAndroidAdb(device, ['shell', 'pidof', appBundleId], {
      allowFailure: true,
      timeoutMs: 1_000,
    });
    return pidof.stdout.trim().length > 0;
  });
  return checks;
}

async function runIosSimulatorAppLogDoctor(): Promise<Record<string, boolean>> {
  const simctlAvailable = await safeCheck(async () => {
    const simctl = await runXcrun(['simctl', 'help'], { allowFailure: true });
    return simctl.exitCode === 0;
  });
  return { simctlAvailable };
}

async function runIosDeviceAppLogDoctor(): Promise<AppLogDoctorResult> {
  const checks: Record<string, boolean> = {};
  const notes: string[] = [];
  checks.devicectlAvailable = await safeCheck(async () => {
    const devicectl = await runXcrun(['devicectl', '--version'], { allowFailure: true });
    return devicectl.exitCode === 0;
  });
  if (!checks.devicectlAvailable) return { checks, notes };

  const consoleCapture = await checkIosDeviceConsoleCaptureSupport();
  checks.devicectlConsoleCapture = consoleCapture.supported;
  if (!consoleCapture.supported) {
    if (consoleCapture.reason === 'probe-failed') {
      notes.push(IOS_DEVICE_CONSOLE_CAPTURE_PROBE_FAILED_NOTE);
    } else {
      notes.push(IOS_DEVICE_CONSOLE_CAPTURE_UNSUPPORTED_NOTE);
    }
  }
  return { checks, notes };
}

async function runMacOsAppLogDoctor(): Promise<Record<string, boolean>> {
  const logAvailable = await safeCheck(async () => {
    const log = await runCmd('log', ['help'], { allowFailure: true });
    return log.exitCode === 0;
  });
  return { logAvailable };
}

async function safeCheck(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}
