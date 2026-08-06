import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: vi.fn() };
});

import { dispatchCommand } from '../dispatch.ts';
import { runAppleRunnerCommand } from '../../platforms/apple/core/runner/runner-client.ts';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';

const mockRunAppleRunnerCommand = vi.mocked(runAppleRunnerCommand);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunAppleRunnerCommand.mockResolvedValue({
    nodes: [{ index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } }],
  });
});

// #1634 P2: proves the whole daemon-side wire — dispatch context ->
// handleSnapshotCommand -> interactor -> emitted RunnerCommand. Removing the
// forwarding at any of those hops turns this red; the daemon corroboration
// test (mocked dispatch) and the Swift plan-gate test cover the layers on
// either side of it.
test('dispatch snapshot forwards snapshotPreferredBackend to the runner command', async () => {
  await dispatchCommand(IOS_SIMULATOR, 'snapshot', [], undefined, {
    snapshotPreferredBackend: 'private-ax',
  });

  const call = mockRunAppleRunnerCommand.mock.calls.find(
    ([, command]) => command.command === 'snapshot',
  );
  assert.ok(call, 'expected a snapshot runner command');
  assert.equal(call[1].preferredBackend, 'private-ax');
});

test('dispatch snapshot without a pin emits no preferredBackend', async () => {
  await dispatchCommand(IOS_SIMULATOR, 'snapshot', [], undefined, {});

  const call = mockRunAppleRunnerCommand.mock.calls.find(
    ([, command]) => command.command === 'snapshot',
  );
  assert.ok(call, 'expected a snapshot runner command');
  assert.equal(call[1].preferredBackend, undefined);
});
