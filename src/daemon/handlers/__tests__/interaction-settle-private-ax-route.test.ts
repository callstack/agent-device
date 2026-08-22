import { beforeEach, expect, test, vi } from 'vitest';
import { makeSnapshotState } from '../../../__tests__/test-utils/snapshot-builders.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { contextFromFlags as buildDaemonContext } from '../../context.ts';
import { handleInteractionCommands } from '../interaction.ts';

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return {
    ...actual,
    runAppleRunnerCommand: vi.fn(async () => ({})),
  };
});

import { runAppleRunnerCommand } from '../../../platforms/apple/core/runner/runner-client.ts';

const mockRunnerCommand = vi.mocked(runAppleRunnerCommand);
const nodes = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    rect: { x: 20, y: 100, width: 120, height: 44 },
    hittable: true,
  },
  ...Array.from({ length: 4 }, (_, offset) => ({
    index: offset + 2,
    parentIndex: 0,
    type: 'Button',
    label: `Action ${offset + 1}`,
    rect: { x: 20, y: 160 + offset * 50, width: 120, height: 44 },
    hittable: true,
  })),
];
const privateAxQuality = {
  state: 'recovered' as const,
  backend: 'private-ax' as const,
  reasonCode: 'requested-backend' as const,
};

beforeEach(() => {
  mockRunnerCommand.mockReset();
  mockRunnerCommand.mockImplementation(async (_device, command) => {
    if (command.command === 'snapshot') return { nodes, snapshotQuality: privateAxQuality };
    return {};
  });
});

test('daemon press --settle pins private-ax on emitted snapshot runner requests', async () => {
  const sessionName = 'press-settle-private-ax-route';
  const sessionStore = makeSessionStore();
  sessionStore.set(
    sessionName,
    makeIosSession(sessionName, {
      appBundleId: 'com.example.fixture',
      snapshot: makeSnapshotState(nodes, {
        backend: 'xctest',
        snapshotQuality: { ...privateAxQuality, reasonCode: 'deferred' },
      }),
    }),
  );

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'press',
      positionals: ['label=Continue'],
      flags: { settle: true, settleQuietMs: 25, timeoutMs: 1_000 },
    },
    sessionName,
    sessionStore,
    contextFromFlags: (flags, appBundleId, traceLogPath) =>
      buildDaemonContext('', flags, appBundleId, traceLogPath),
  });

  expect(response?.ok).toBe(true);
  const snapshotCommands = mockRunnerCommand.mock.calls
    .map(([, command]) => command)
    .filter((command) => command.command === 'snapshot');
  expect(snapshotCommands.length).toBeGreaterThanOrEqual(3);
  const preferredBackends = snapshotCommands.map((command) => command.preferredBackend);
  expect(preferredBackends).toEqual([
    undefined,
    ...Array.from({ length: preferredBackends.length - 1 }, () => 'private-ax' as const),
  ]);
});
