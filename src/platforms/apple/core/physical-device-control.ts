import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { execFailureDetails } from '../../../utils/exec.ts';
import { terminateIosDeviceApp } from './devicectl.ts';
import {
  ensureCoreDeviceReady,
  launchCoreDeviceApp,
  resolveCoreDeviceTunnelIp,
} from './physical-device-coredevice.ts';
import {
  iosPhysicalDeviceBackendRegistry,
  type IosPhysicalDeviceBackend,
  type IosPhysicalDeviceBackendRegistry,
} from './physical-device-control-registry.ts';
import type {
  AppleRunnerCommandExecutor,
  AppleRunnerCommandOptions,
} from './runner/runner-provider.ts';
import { runXcrun } from './tool-provider.ts';

export { parseIosDeviceDetailsPayload, resolveIosReadyHint } from './physical-device-coredevice.ts';

const IOS_DEVICE_READY_TIMEOUT_MS = 15_000;
const IOS_DEVICE_READY_COMMAND_TIMEOUT_BUFFER_MS = 3_000;

type IosPhysicalDeviceLaunchOptions = {
  payloadUrl?: string;
  launchArgs?: string[];
  runnerOptions?: AppleRunnerCommandOptions;
  runRunnerCommand: AppleRunnerCommandExecutor;
};

export type IosPhysicalDeviceControl = {
  readonly backend: IosPhysicalDeviceBackend;
  ensureReady(device: DeviceInfo): Promise<void>;
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
  resolveRunnerTunnelIp(device: DeviceInfo, timeoutBudgetMs?: number): Promise<string | null>;
};

const CONTROLS: Record<IosPhysicalDeviceBackend, IosPhysicalDeviceControl> = {
  coredevice: {
    backend: 'coredevice',
    ensureReady: ensureCoreDeviceReady,
    launchApp: launchCoreDeviceApp,
    terminateApp: async (device, bundleId) => await terminateIosDeviceApp(device, bundleId),
    resolveRunnerTunnelIp: resolveCoreDeviceTunnelIp,
  },
  xctest: {
    backend: 'xctest',
    ensureReady: ensureXctestDeviceReady,
    launchApp: launchXctestDeviceApp,
    terminateApp: terminateXctestDeviceApp,
    resolveRunnerTunnelIp: async () => null,
  },
};

export function resolveIosPhysicalDeviceControl(
  device: DeviceInfo,
  registry: Pick<
    IosPhysicalDeviceBackendRegistry,
    'backendForDevice'
  > = iosPhysicalDeviceBackendRegistry,
): IosPhysicalDeviceControl {
  return CONTROLS[registry.backendForDevice(device)];
}

async function ensureXctestDeviceReady(device: DeviceInfo): Promise<void> {
  const timeoutSeconds = Math.max(1, Math.ceil(IOS_DEVICE_READY_TIMEOUT_MS / 1000));
  const args = ['xcdevice', 'wait', '--both', `--timeout=${timeoutSeconds}`, device.id];
  const result = await runXcrun(args, {
    allowFailure: true,
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
