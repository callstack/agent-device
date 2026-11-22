import {
  normalizeAppleScrollResultWithResolvedFrame,
  scrollRunnerFields,
  type ScrollDirection,
} from '@agent-device/contracts/scroll-gesture';
import type { RunnerCallOptions, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { MacOsRunner } from '@agent-device/contracts/macos-platform-leaf';
import type { ScrollExecutionOptions } from '@agent-device/contracts/scroll-command';

/**
 * The XCTest app backend's macOS-only commands. The Apple owner keeps the runner and its two macOS
 * wire cases; this module maps a desktop scroll and an alternate click onto them through the
 * device-bound runner the owner hands in.
 */
export async function runMacOsDesktopScroll(
  runner: MacOsRunner,
  context: RunnerContext,
  runnerOptions: RunnerCallOptions,
  direction: ScrollDirection,
  options?: ScrollExecutionOptions,
): Promise<Record<string, unknown>> {
  const runnerResult = await runner.run(
    {
      command: 'desktopScroll',
      direction,
      ...scrollRunnerFields(options, { includeDuration: true, includeReleaseBehavior: false }),
      appBundleId: context.appBundleId,
    },
    runnerOptions,
  );
  return normalizeAppleScrollResultWithResolvedFrame(runnerResult, direction, options, {
    includeDuration: true,
  });
}

export async function runMacOsAlternateClick(
  runner: MacOsRunner,
  context: RunnerContext,
  runnerOptions: RunnerCallOptions,
  point: { x: number; y: number },
  button: 'secondary' | 'middle',
): Promise<Record<string, unknown>> {
  return await runner.run(
    { command: 'mouseClick', x: point.x, y: point.y, button, appBundleId: context.appBundleId },
    runnerOptions,
  );
}
