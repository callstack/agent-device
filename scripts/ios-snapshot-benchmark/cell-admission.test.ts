import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { prepareSampleState } from './cell-admission.ts';
import { BenchmarkCellAdmissionError } from './lifecycle.ts';

vi.mock('./lifecycle.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lifecycle.ts')>()),
  readSimulatorState: () => 'Booted',
  readRunningAppPids: () => {
    throw new Error('daemon admission must stop before the app probe');
  },
}));

test('an unproven registration stops a warm benchmark cell with its typed admission reason', async () => {
  const stateDir = mkdtempForTestSync('benchmark-daemon-admission-');
  fs.writeFileSync(resolveDaemonPaths(stateDir).lockPath, 'not a lock directory');
  await assert.rejects(
    prepareSampleState({
      repoRoot: process.cwd(),
      stateDir,
      derivedPath: stateDir,
      udid: 'unused',
      samples: 1,
      state: 'warm',
      fixture: {
        id: 'quiet',
        label: 'Unused',
        app: 'unused',
        anchorText: 'Unused',
      },
    }),
    (error: unknown) =>
      error instanceof BenchmarkCellAdmissionError &&
      error.reason === 'cell-state' &&
      error.cause instanceof AppError &&
      error.cause.details?.reason === 'daemon_registration_unproven',
  );
});
