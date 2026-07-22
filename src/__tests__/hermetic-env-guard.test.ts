import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vitestConfig from '../../vitest.config.ts';

// hermetic-env-setup.ts scrubs ambient AGENT_DEVICE_DAEMON_* vars so a host that
// actually runs agent-device matches CI, where they are unset. CI can never
// exercise that scrub — it starts clean — so without this guard, deleting the
// setup file or forgetting to wire a project would leave the whole suite green.
// This test closes that gap two ways: a static check that every project wires
// the setup, and a real vitest child, launched with the vars set, that proves a
// wired project sees them scrubbed (with a negative control proving the probe is
// sensitive to the vars in the first place).

const HERMETIC_ENV_SETUP = 'src/__tests__/hermetic-env-setup.ts';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const fixtureConfig = path.join(here, '__fixtures__', 'hermetic-env-guard', 'vitest.config.ts');

function runProbe(
  extraEnv: Record<string, string>,
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['vitest', 'run', '--config', fixtureConfig], {
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, output }));
  });
}

type ProjectShape = { test?: { name?: string; setupFiles?: readonly string[] } };

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

test('a wired vitest child scrubs ambient daemon env before tests run', async () => {
  // Both daemon vars set, plus a control var the setup must not touch — its
  // presence in the probe proves the child inherited the injected environment,
  // so a scrubbed daemon var is the setup working, not an env that never arrived.
  const dirtyEnv = {
    AGENT_DEVICE_DAEMON_BASE_URL: 'https://guard.example.test',
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'hermetic-guard-token',
    HERMETIC_GUARD_CONTROL: 'present',
  };

  // Run the wired probe and the unwired negative control concurrently: each is a
  // real vitest cold start (~1.4s), so serial spawns would exceed the unit
  // wall-clock budget for no reason — they are independent processes.
  const [wired, unwired] = await Promise.all([
    runProbe(dirtyEnv),
    runProbe({ ...dirtyEnv, HERMETIC_GUARD_DISABLE_SETUP: '1' }),
  ]);

  assert.equal(
    wired.status,
    0,
    `expected the wired probe to pass with the vars scrubbed:\n${wired.output}`,
  );

  // Negative control: same vars, setup NOT wired — the probe must fail, proving
  // it genuinely detects the leak (so the pass above is the setup, not a no-op).
  assert.notEqual(
    unwired.status,
    0,
    `expected the probe to fail when the setup is not wired (leak must be detectable):\n${unwired.output}`,
  );
});
