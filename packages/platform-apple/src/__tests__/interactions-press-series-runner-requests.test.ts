import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertProducedRunnerRequests,
  bindTestCommandHost,
  IOS_SIMULATOR,
} from '@agent-device/test-kit';
import type { RunnerCommand } from '@agent-device/apple-runner';
import { createAppleInteractor } from '../interactor.ts';

bindTestCommandHost();

test('press-series continuations carry the original orientation on the runner wire', async () => {
  const requests: RunnerCommand[] = [];
  const interactor = createAppleInteractor(
    IOS_SIMULATOR,
    { appBundleId: 'com.example.app' },
    { env: process.env, cwd: process.cwd() },
    {
      hasLiveSession: () => true,
      runCommand: async (_device, request) => {
        requests.push(request);
        return {
          sequenceOrientation: 1,
          completedSteps: request.steps?.length ?? 0,
          sequenceResults: request.steps?.map(({ kind }) => ({ ok: true, kind })) ?? [],
        };
      },
    },
  );
  await interactor.pressPoint!(
    { x: 10, y: 20 },
    { button: 'primary', count: 21, intervalMs: 0, holdMs: 0, jitterPx: 0, doubleTap: false },
  );
  assert.equal(requests.length, 2);
  assertProducedRunnerRequests(import.meta.filename, [
    ['ios-simulator.runner-sequence.bound-orientation', requests[1]],
  ]);
});
