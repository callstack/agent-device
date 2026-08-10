import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  DEFAULT_VITEST_MAX_WORKERS,
  resolveVitestMaxWorkers,
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
  assert.equal(resolveVitestMaxWorkers({}), DEFAULT_VITEST_MAX_WORKERS);
  assert.equal(resolveVitestMaxWorkers({ CI: 'true' }), undefined);
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

test('importing hermetic-env-setup isolates advisory claims from the host and other workers', async () => {
  process.env.AGENT_DEVICE_CLAIMS_DIR = '/host/device-claims';
  vi.resetModules();
  await import('./hermetic-env-setup.ts');
  assert.equal(process.env.AGENT_DEVICE_CLAIMS_DIR, VITEST_CLAIMS_DIR);
});
