import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { BenchmarkCellAdmissionError, BenchmarkInfrastructureError } from './lifecycle.ts';
import { runLocalMeasurements } from './local-runner.ts';

const failures = vi.hoisted(() => ({
  admission: undefined as unknown,
  cleanup: undefined as unknown,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: () => ({ status: 0, stdout: '', stderr: '' }),
}));
vi.mock('./cell-admission.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cell-admission.ts')>()),
  prepareCellState: () => {},
  admitReadyCell: () => {
    throw failures.admission;
  },
}));
vi.mock('./lifecycle.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lifecycle.ts')>()),
  stopDaemon: () => {
    if (failures.cleanup) throw failures.cleanup;
  },
}));

test.for([false, true])(
  'cell-state refusal survives cleanup (cleanup failed: %s)',
  async (cleanupFails) => {
    const admission = new BenchmarkCellAdmissionError('cell-state', 'Registration is unproven.');
    const cleanup = new BenchmarkInfrastructureError('Daemon cleanup refused.');
    failures.admission = admission;
    failures.cleanup = cleanupFails ? cleanup : undefined;
    await assert.rejects(
      runLocalMeasurements({
        repoRoot: process.cwd(),
        stateDir: '/unused/state',
        derivedPath: '/unused/derived',
        udid: 'unused',
        samples: 1,
        states: ['warm'],
        fixtures: [{ id: 'quiet', label: 'Unused', app: 'unused', anchorText: 'Unused' }],
      }),
      (error: unknown) => {
        if (!cleanupFails) return error === admission;
        return (
          error instanceof BenchmarkCellAdmissionError &&
          error.reason === 'cell-state' &&
          error.cause instanceof AggregateError &&
          error.cause.errors[0] === admission &&
          error.cause.errors[1] === cleanup
        );
      },
    );
  },
);
