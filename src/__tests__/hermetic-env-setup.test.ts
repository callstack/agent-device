import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_VITEST_MAX_WORKERS,
  resolveVitestMaxWorkers,
  VITEST_MAX_WORKERS_OVERRIDE_ENV,
} from '../../scripts/lib/vitest-concurrency.ts';
import vitestConfig from '../../vitest.config.ts';

const HERMETIC_ENV_SETUP = 'src/__tests__/hermetic-env-setup.ts';
const AMBIENT_DAEMON_VARS = [
  'AGENT_DEVICE_DAEMON_BASE_URL',
  'AGENT_DEVICE_DAEMON_AUTH_TOKEN',
] as const;
const VITEST_CLAIMS_DIR = path.join(os.tmpdir(), `agent-device-vitest-claims-${process.pid}`);

type ProjectShape = { test?: { name?: string; setupFiles?: readonly string[] } };

test('vitest caps aggregate worker concurrency for parallel worktrees', () => {
  assert.equal(vitestConfig.test?.maxWorkers, resolveVitestMaxWorkers());
  assert.equal(DEFAULT_VITEST_MAX_WORKERS, 4);
  assert.equal(resolveVitestMaxWorkers({}), 4);
  assert.equal(resolveVitestMaxWorkers({ CI: 'true' }), undefined);
});

// The opt-in solo-run escape hatch (#1962). These live here rather than beside the
// resolver so the mutation lane's `vitest related` graph is not widened by a new
// test file: this one is already in the unit-core suite and already imports it.
test('a solo run may raise the local worker cap, clamped and CI-ignored', () => {
  // Clamped to availableParallelism(), never honored literally: cpus().length would
  // ignore CPU affinity and cgroup limits and inflate the ceiling this enforces.
  assert.equal(
    resolveVitestMaxWorkers({ [VITEST_MAX_WORKERS_OVERRIDE_ENV]: '999' }),
    os.availableParallelism(),
  );
  // 1 is <= availableParallelism() on every host, so this takes the override branch.
  assert.equal(resolveVitestMaxWorkers({ [VITEST_MAX_WORKERS_OVERRIDE_ENV]: '1' }), 1);
  // CI derives its own count, so the override is inert there even when both are set.
  assert.equal(
    resolveVitestMaxWorkers({ CI: 'true', [VITEST_MAX_WORKERS_OVERRIDE_ENV]: '8' }),
    undefined,
  );
});

test('an unusable worker override falls through to the default cap', () => {
  for (const value of ['not-a-number', '0', '-4', '2.5', '', '  ']) {
    assert.equal(
      resolveVitestMaxWorkers({ [VITEST_MAX_WORKERS_OVERRIDE_ENV]: value }),
      DEFAULT_VITEST_MAX_WORKERS,
      `${JSON.stringify(value)} must degrade to the default cap rather than throw`,
    );
  }
});

// Wiring: the scrub only helps if every project loads it as a setup file. CI runs with the
// vars unset, so a dropped wiring is otherwise invisible — assert it structurally instead.
test('every vitest project wires the hermetic-env setup', () => {
  const projects = (vitestConfig.test?.projects ?? []) as unknown as ReadonlyArray<ProjectShape>;
  assert.ok(projects.length > 0, 'expected configured vitest projects');
  for (const project of projects) {
    const name = project.test?.name ?? '(unnamed)';
    const setupFiles = project.test?.setupFiles ?? [];
    assert.ok(
      setupFiles.includes(HERMETIC_ENV_SETUP),
      `project "${name}" must wire ${HERMETIC_ENV_SETUP} in setupFiles`,
    );
  }
});

// Behavior: re-import a fresh copy of the setup module with the daemon vars set, so the scrub
// is exercised on any host (CI included, where the vars are otherwise absent).
afterEach(() => {
  for (const name of AMBIENT_DAEMON_VARS) delete process.env[name];
});

test('importing hermetic-env-setup scrubs the ambient daemon connection vars', async () => {
  for (const name of AMBIENT_DAEMON_VARS) process.env[name] = 'leaked-from-host';
  vi.resetModules();
  await import('./hermetic-env-setup.ts');
  for (const name of AMBIENT_DAEMON_VARS) {
    assert.equal(process.env[name], undefined, `${name} must be scrubbed when the setup loads`);
  }
});

test('importing hermetic-env-setup isolates device claims from the host and other workers', async () => {
  process.env.AGENT_DEVICE_CLAIMS_DIR = '/host/device-claims';
  vi.resetModules();
  await import('./hermetic-env-setup.ts');
  assert.equal(process.env.AGENT_DEVICE_CLAIMS_DIR, VITEST_CLAIMS_DIR);
});
