import { expect, test, vi } from 'vitest';

const toolchains = vi.hoisted(() => ({
  appleEvaluations: 0,
  appleAvailabilityChecks: [] as string[],
  appleRuns: [] as Array<{ args: string[]; signal?: AbortSignal }>,
}));

vi.mock('./platforms/apple/core/tool-provider.ts', () => {
  toolchains.appleEvaluations += 1;
  return {
    resolveAppleToolProvider: () => ({
      whichCommand: async (command: string) => {
        toolchains.appleAvailabilityChecks.push(command);
        return true;
      },
    }),
    runXcrun: async (args: string[], options: { signal?: AbortSignal }) => {
      toolchains.appleRuns.push({ args, signal: options.signal });
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
});

import { createDeviceInventoryHost } from './platform-runtime-host.ts';

test('inventory host loads scoped Apple mechanics only on first Apple tool use', async () => {
  const host = createDeviceInventoryHost();
  const signal = new AbortController().signal;

  expect(toolchains.appleEvaluations).toBe(0);
  await expect(host.appleTools.isXcrunAvailable(signal)).resolves.toBe(true);
  expect(toolchains.appleEvaluations).toBe(1);
  expect(toolchains.appleAvailabilityChecks).toEqual(['xcrun']);

  await expect(
    host.appleTools.run(
      { tool: 'devicectl', args: ['list', 'devices'], allowFailure: true, timeoutMs: 42 },
      signal,
    ),
  ).resolves.toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
  expect(toolchains.appleEvaluations).toBe(1);
  expect(toolchains.appleRuns).toEqual([{ args: ['devicectl', 'list', 'devices'], signal }]);
});
