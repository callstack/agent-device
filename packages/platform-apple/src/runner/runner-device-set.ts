import type { DeviceInfo } from '@agent-device/kernel/device';
import { simulatorAddressFor } from './host.ts';
import { memoizedRunnerXcodeVersion } from './runner-toolchain-probe.ts';

/** The scoped simulator set that holds this runner's simulator, or undefined for the default set. */
export function runnerSimulatorSetPath(device: DeviceInfo): string | undefined {
  return simulatorAddressFor(device).simulatorSetPath;
}

/** Whether a runner started for one device serves the other: one udid in one simulator set. */
export function isSameRunnerSimulator(runnerDevice: DeviceInfo, device: DeviceInfo): boolean {
  const runner = simulatorAddressFor(runnerDevice);
  const requested = simulatorAddressFor(device);
  return runner.udid === requested.udid && runner.simulatorSetPath === requested.simulatorSetPath;
}

/**
 * `-destination` for a runner xcodebuild phase. xcodebuild has no `--set` option: it resolves a
 * simulator in a scoped set only through the `DVTSimulatorSetLocation` Xcode user default, which it
 * accepts as an argument in the `-Key=value` form alone.
 */
export function xcodebuildDestinationArgs(device: DeviceInfo, destination: string): string[] {
  const simulatorSetPath = runnerSimulatorSetPath(device);
  return simulatorSetPath === undefined
    ? ['-destination', destination]
    : ['-destination', destination, `-DVTSimulatorSetLocation=${simulatorSetPath}`];
}

/** What a runner xcodebuild failure reports about the scoped set it resolved its destination in. */
type RunnerSimulatorSetFailureDetails = { simulatorSetPath?: string; xcodeVersion?: string };

/**
 * The scoped set a runner xcodebuild phase resolved its destination in, with the selected Xcode when
 * the runner cache decision already read it; empty for the default set.
 */
export function runnerSimulatorSetFailureDetails(
  device: DeviceInfo,
): RunnerSimulatorSetFailureDetails {
  const simulatorSetPath = runnerSimulatorSetPath(device);
  if (simulatorSetPath === undefined) return {};
  const xcodeVersion = memoizedRunnerXcodeVersion(device);
  return xcodeVersion === undefined ? { simulatorSetPath } : { simulatorSetPath, xcodeVersion };
}

/**
 * Supplies the classification details for one device's launch to `classifyRunnerStartupFailure`.
 * Besides the scoped set and the Xcode version this process already read, it carries the simulator ID
 * needed to describe a missing destination.
 *
 * This is an input shape, not a published shape: callers spread it into the error they classify and
 * publish only {@link runnerSimulatorSetFailureDetails} beside their failure.
 */
export function runnerLaunchLogClassificationDetails(
  device: DeviceInfo,
): RunnerSimulatorSetFailureDetails & { simulatorUdid: string } {
  return { ...runnerSimulatorSetFailureDetails(device), simulatorUdid: device.id };
}
