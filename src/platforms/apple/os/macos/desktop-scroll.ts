import type { DeviceInfo } from '../../../../kernel/device.ts';
import type { RunnerCallOptions, RunnerContext } from '../../../../core/interactor-types.ts';
import type { ScrollDirection } from '../../../../core/scroll-gesture.ts';
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
      ...scrollRunnerFields(options, { includeDuration: true }),
      appBundleId: ctx.appBundleId,
    },
    runnerOpts,
  );
  return normalizeAppleScrollResultWithResolvedFrame(runnerResult, direction, options, {
    includeDuration: true,
  });
}
