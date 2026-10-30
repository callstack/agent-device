import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { resolveIosSimulatorDeviceSetPath } from '@agent-device/kernel/device-isolation';
import { shellQuote } from '@agent-device/kernel/device-shell';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { isRecord } from '@agent-device/kernel/record';
import { parseBooleanLiteral } from '@agent-device/kernel/source-value';
import type { ScopedSimctlCommand } from '@agent-device/contracts/platform-runtime-host';
import { bootFailureHint, classifyBootFailure } from '@agent-device/provision-kit/boot-diagnostics';
import {
  createLiveTestHostEnvironment,
  loadRealHostKitCapabilities,
  runRealHostCommand,
} from '@agent-device/test-kit';
import type { AppleRunnerHost } from '../host.ts';
import type { IosPhysicalDeviceRunnerControl } from '../runner-physical-device.ts';

function unavailable(capability: string): never {
  throw new Error(`AppleRunnerHost.${capability} is not available in this test`);
}

/**
 * The Apple-owned capabilities the runner consumes, as explicit test adapters. The runner package
 * cannot reach the Apple tool provider, simctl, or physical-device control that implement them, so
 * a suite that needs one overrides it with {@link appleRunnerTestHost}; any other call fails loudly
 * instead of running a real tool.
 */
function appleToolingTestAdapters(): Pick<
  AppleRunnerHost,
  | 'runAppleToolCommand'
  | 'runXcrun'
  | 'readApplePlistJson'
  | 'hasScopedAppleToolProvider'
  | 'buildSimctlArgsForDevice'
  | 'simulatorAddressFor'
  | 'resolveIosPhysicalDeviceControl'
> {
  const simulatorSetPathFor = (device: DeviceInfo): string | undefined =>
    isIosFamily(device) && device.kind === 'simulator'
      ? resolveIosSimulatorDeviceSetPath(device.simulatorSetPath)
      : undefined;
  return {
    runAppleToolCommand: async () => unavailable('runAppleToolCommand'),
    runXcrun: async () => unavailable('runXcrun'),
    // The one genuine tool: xctestrun product resolution reads real plists through `plutil`.
    readApplePlistJson: async (plistPath, signal) => {
      try {
        const result = await runRealHostCommand(
          'plutil',
          ['-convert', 'json', '-o', '-', plistPath],
          { allowFailure: true, signal },
        );
        return result.exitCode !== 0 || !result.stdout.trim()
          ? null
          : (JSON.parse(result.stdout) as Record<string, unknown>);
      } catch {
        signal?.throwIfAborted();
        return null;
      }
    },
    hasScopedAppleToolProvider: () => false,
    buildSimctlArgsForDevice: (device, args) => {
      const setPath = simulatorSetPathFor(device);
      return Object.freeze([
        'simctl',
        ...(setPath ? ['--set', setPath] : []),
        ...args,
      ]) as unknown as ScopedSimctlCommand;
    },
    simulatorAddressFor: (device) => ({
      udid: device.id,
      simulatorSetPath: simulatorSetPathFor(device),
    }),
    resolveIosPhysicalDeviceControl: (device): IosPhysicalDeviceRunnerControl => ({
      backend: device.iosPhysicalDeviceBackend === 'xctest' ? 'xctest' : 'coredevice',
      resolveTunnel: async () => ({ tunnelIp: null }),
      readDeviceReadiness: async () => ({
        available: false,
        reason: 'device_readiness_unreadable',
        hint: 'No device readiness is available in this test.',
      }),
    }),
  };
}

/**
 * The host the apple-runner vitest project binds behind the test-host seam: real host-kit and
 * kernel capabilities (so retry, lock, process and request semantics are genuine), the live process
 * environment, and the explicit Apple adapters above. It reads no platform-apple or root code.
 */
export async function createAppleRunnerTestHostDefaults(): Promise<AppleRunnerHost> {
  return {
    ...(await loadRealHostKitCapabilities()),
    ...appleToolingTestAdapters(),
    hostEnvironment: createLiveTestHostEnvironment,
    shellQuote,
    withKeyedLock,
    parseBooleanLiteral,
    isRecord,
    classifyBootFailure,
    bootFailureHint,
    leaseOwnerStateDir: () => undefined,
    hasDeviceClaimAuthority: () => false,
  };
}
