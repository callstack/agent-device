import { expect, test, vi } from 'vitest';
import { createAppleApplicationTools } from '../platform-runtime-apple-application-tools.ts';

const detachIosSimulatorRunnerSessionsForShutdown = vi.hoisted(() => vi.fn(async () => 0));
const stopAllIosRunnerSessions = vi.hoisted(() => vi.fn(async () => {}));

// The factory awaits the real Apple runner graph on purpose: that wait is what let a second,
// concurrent dynamic import of this specifier overtake the still-unresolved mock and hand the
// caller the UNMOCKED module (#2314).
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, detachIosSimulatorRunnerSessionsForShutdown, stopAllIosRunnerSessions };
});

// Two ports of these tools run at once whenever the open path leaves its runner prewarm
// unawaited, so every port must reach the runner module through the one memoized loader. A port
// that opens its own `import(...)` resolves the specifier a second time, and a unit test that
// loses the mock this way starts the real local XCTest runner — whose stale-process cleanup
// `pkill`s xcodebuild on the developer's host, failing whichever test is running when it lands.
test('concurrent runner ports share one module resolution, so the mock always applies', async () => {
  const tools = createAppleApplicationTools();

  await Promise.all([
    tools.detachRunnerSessionsForShutdown(),
    tools.finalizeRunnerSessionsForShutdown(),
  ]);

  expect(detachIosSimulatorRunnerSessionsForShutdown).toHaveBeenCalledTimes(1);
  expect(stopAllIosRunnerSessions).toHaveBeenCalledTimes(1);
});
