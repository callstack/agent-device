import { expect, test, vi } from 'vitest';
import { recordingInput, simulator } from './runtime.fixtures.ts';
import { validateAppleSimulatorRecording } from './validation.ts';

test('requires an active non-runner app for app-scoped simulator recording', async () => {
  const isRunnerBundleId = vi.fn(async () => true);
  await expect(
    validateAppleSimulatorRecording(
      simulator,
      recordingInput({ scope: 'app', activeSessionApp: undefined }),
      isRunnerBundleId,
    ),
  ).rejects.toThrow('active app session');
  expect(isRunnerBundleId).not.toHaveBeenCalled();

  await expect(
    validateAppleSimulatorRecording(simulator, recordingInput({ scope: 'app' }), isRunnerBundleId),
  ).rejects.toThrow('real application session');
});
