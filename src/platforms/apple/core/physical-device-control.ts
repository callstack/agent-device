import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '../../../utils/exec.ts';
import type { AppsFilter } from '@agent-device/contracts/device';
import type { IosAppInfo, IosDeviceAppProcesses } from './app-info.ts';
import {
  installCoreDeviceApp,
  listCoreDeviceApps,
  resolveCoreDeviceAppProcesses,
  terminateCoreDeviceApp,
  uninstallCoreDeviceApp,
} from './physical-device-apps.ts';
import {
  ensureCoreDeviceReady,
  launchCoreDeviceApp,
  resolveCoreDeviceTunnelIp,
} from './physical-device-coredevice.ts';
import { copyCoreDeviceRunnerFile } from './physical-device-files.ts';
import {
  IOS_DEVICE_READY_COMMAND_TIMEOUT_BUFFER_MS,
  IOS_DEVICE_READY_TIMEOUT_MS,
} from './physical-device-constants.ts';
import type {
  AppleRunnerCommandExecutor,
  AppleRunnerCommandOptions,
} from '@agent-device/platform-apple/runner';
import {
  captureCoreDeviceScreenshot,
  captureXctestDeviceScreenshot,
  type IosPhysicalDeviceScreenshotOptions,
} from './physical-device-screenshot.ts';
import { runXcrun } from './tool-provider.ts';

export type IosPhysicalDeviceBackend = 'coredevice' | 'xctest';
/**
 * Only the CoreDevice tunnel address is resolved here. Which transport a runner
 * command uses is decided by the route resolver, which reaches this at all only
 * after usbmux has reported the device unattached.
 */
export type IosPhysicalDeviceTunnel = { tunnelIp: string | null };

type IosPhysicalDeviceLaunchOptions = {
  payloadUrl?: string;
  launchArgs?: string[];
  runnerOptions?: AppleRunnerCommandOptions;
  runRunnerCommand: AppleRunnerCommandExecutor;
};

export type IosPhysicalDeviceControl = {
  readonly backend: IosPhysicalDeviceBackend;
  assertAppInstallationSupported(device: DeviceInfo): void;
  ensureReady(device: DeviceInfo, signal?: AbortSignal): Promise<void>;
  listApps(device: DeviceInfo, filter: AppsFilter): Promise<IosAppInfo[]>;
  installApp(device: DeviceInfo, installablePath: string, signal?: AbortSignal): Promise<void>;
  uninstallApp(device: DeviceInfo, bundleId: string, signal?: AbortSignal): Promise<void>;
  launchApp(
    device: DeviceInfo,
    bundleId: string,
    options: IosPhysicalDeviceLaunchOptions,
  ): Promise<void>;
  terminateApp(
    device: DeviceInfo,
    bundleId: string,
    options: {
      runnerOptions?: AppleRunnerCommandOptions;
      runRunnerCommand: AppleRunnerCommandExecutor;
    },
  ): Promise<void>;
  resolveAppProcesses(device: DeviceInfo, bundleId: string): Promise<IosDeviceAppProcesses>;
  captureScreenshot(
    device: DeviceInfo,
    outPath: string,
    options: IosPhysicalDeviceScreenshotOptions,
  ): Promise<void>;
  copyRunnerFile(
    device: DeviceInfo,
    remotePath: string,
    outPath: string,
    timeoutMs?: number,
  ): Promise<void>;
  resolveTunnel(device: DeviceInfo, timeoutBudgetMs?: number): Promise<IosPhysicalDeviceTunnel>;
};

const CONTROLS: Record<IosPhysicalDeviceBackend, IosPhysicalDeviceControl> = {
  coredevice: {
    backend: 'coredevice',
    assertAppInstallationSupported: () => {},
    ensureReady: ensureCoreDeviceReady,
    listApps: listCoreDeviceApps,
    installApp: installCoreDeviceApp,
    uninstallApp: uninstallCoreDeviceApp,
    launchApp: launchCoreDeviceApp,
    terminateApp: async (device, bundleId) => await terminateCoreDeviceApp(device, bundleId),
    resolveAppProcesses: resolveCoreDeviceAppProcesses,
    captureScreenshot: captureCoreDeviceScreenshot,
    copyRunnerFile: copyCoreDeviceRunnerFile,
    resolveTunnel: async (device, timeoutBudgetMs) => ({
      tunnelIp: await resolveCoreDeviceTunnelIp(device, timeoutBudgetMs),
    }),
  },
  xctest: {
    backend: 'xctest',
    assertAppInstallationSupported: assertXctestAppInstallationUnsupported,
    ensureReady: ensureXctestDeviceReady,
    listApps: rejectXctestAppInventory,
    installApp: rejectXctestAppInstallation,
    uninstallApp: rejectXctestAppInstallation,
    launchApp: launchXctestDeviceApp,
    terminateApp: terminateXctestDeviceApp,
    resolveAppProcesses: rejectXctestProcessLookup,
    captureScreenshot: captureXctestDeviceScreenshot,
    copyRunnerFile: rejectXctestRunnerFileCopy,
    resolveTunnel: rejectXctestTunnelLookup,
  },
};

export function resolveIosPhysicalDeviceControl(device: DeviceInfo): IosPhysicalDeviceControl {
  return CONTROLS[device.iosPhysicalDeviceBackend === 'xctest' ? 'xctest' : 'coredevice'];
}

function assertXctestAppInstallationUnsupported(device: DeviceInfo): never {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'Installing apps is unavailable on this XCTest-backed physical iOS device.',
    {
      deviceId: device.id,
      backend: 'xctest',
      hint: 'Install the app with Xcode, then open it in agent-device by bundle ID.',
    },
  );
}

async function rejectXctestAppInstallation(device: DeviceInfo): Promise<never> {
  return assertXctestAppInstallationUnsupported(device);
}

async function rejectXctestAppInventory(device: DeviceInfo): Promise<never> {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'App inventory is unavailable on this XCTest-backed physical iOS device.',
    {
      deviceId: device.id,
      backend: 'xctest',
      hint: 'Use an installed app bundle ID when opening the device.',
    },
  );
}

async function rejectXctestProcessLookup(device: DeviceInfo): Promise<never> {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'Process lookup is unavailable on this XCTest-backed physical iOS device.',
    {
      deviceId: device.id,
      backend: 'xctest',
      hint: 'Use a CoreDevice-backed iOS device for performance sampling.',
    },
  );
}

async function rejectXctestTunnelLookup(device: DeviceInfo): Promise<never> {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'XCTest-backed physical iOS devices have no CoreDevice tunnel.',
    {
      deviceId: device.id,
      backend: 'xctest',
      hint: 'Connect the device by cable so it is reachable through usbmux.',
    },
  );
}

async function rejectXctestRunnerFileCopy(device: DeviceInfo): Promise<never> {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'Runner file copy is unavailable on this XCTest-backed physical iOS device.',
    {
      deviceId: device.id,
      backend: 'xctest',
    },
  );
}

async function ensureXctestDeviceReady(device: DeviceInfo, signal?: AbortSignal): Promise<void> {
  const timeoutSeconds = Math.max(1, Math.ceil(IOS_DEVICE_READY_TIMEOUT_MS / 1000));
  const args = ['xcdevice', 'wait', '--both', `--timeout=${timeoutSeconds}`, device.id];
  const result = await runXcrun(args, {
    allowFailure: true,
    signal,
    timeoutMs: IOS_DEVICE_READY_TIMEOUT_MS + IOS_DEVICE_READY_COMMAND_TIMEOUT_BUFFER_MS,
  });
  if (result.exitCode === 0) return;
  throw new AppError(
    'COMMAND_FAILED',
    'iOS device is not ready for XCTest automation',
    execFailureDetails(result, {
      cmd: 'xcrun',
      args,
      deviceId: device.id,
      backend: 'xctest',
      hint: 'Keep the device unlocked, trusted, connected, and visible in `xcrun xcdevice list`, then retry.',
    }),
  );
}

async function launchXctestDeviceApp(
  device: DeviceInfo,
  bundleId: string,
  options: IosPhysicalDeviceLaunchOptions,
): Promise<void> {
  if (options.payloadUrl || (options.launchArgs && options.launchArgs.length > 0)) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'XCTest-backed physical iOS devices do not support deep links or launch arguments during open.',
      {
        deviceId: device.id,
        backend: 'xctest',
        hint: 'Open the installed app by bundle ID without a URL or --launch-args.',
      },
    );
  }
  await options.runRunnerCommand(
    device,
    { command: 'activate', appBundleId: bundleId },
    options.runnerOptions ?? {},
  );
}

async function terminateXctestDeviceApp(
  device: DeviceInfo,
  bundleId: string,
  options: {
    runnerOptions?: AppleRunnerCommandOptions;
    runRunnerCommand: AppleRunnerCommandExecutor;
  },
): Promise<void> {
  await options.runRunnerCommand(
    device,
    { command: 'terminate', appBundleId: bundleId },
    options.runnerOptions ?? {},
  );
}
