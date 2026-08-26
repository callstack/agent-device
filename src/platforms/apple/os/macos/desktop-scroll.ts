import type { RunnerCallOptions, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerCommand } from '../../core/runner/runner-contract.ts';
import {
  normalizeAppleScrollResultWithResolvedFrame,
  scrollRunnerFields,
  type AppleScrollOptions,
} from '../../core/scroll.ts';

type RunRunnerCommand = (
  device: DeviceInfo,
  command: RunnerCommand,
  options?: RunnerCallOptions,
) => Promise<Record<string, unknown>>;

export async function runMacosDesktopScroll(
  runRunnerCommand: RunRunnerCommand,
  device: DeviceInfo,
  ctx: RunnerContext,
  runnerOpts: RunnerCallOptions,
  direction: ScrollDirection,
  options?: AppleScrollOptions,
): Promise<Record<string, unknown>> {
  const runnerResult = await runRunnerCommand(
    device,
    {
      command: 'desktopScroll',
      direction,
      ...scrollRunnerFields(options, { includeDuration: true, includeReleaseBehavior: false }),
      appBundleId: ctx.appBundleId,
    },
    runnerOpts,
  );
  return normalizeAppleScrollResultWithResolvedFrame(runnerResult, direction, options, {
    includeDuration: true,
  });
}
