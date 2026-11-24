import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import { parseJsonOutputs } from '../../__tests__/test-utils/cli-json-outputs.ts';

const CLOUD = 'https://cloud.example';
const CLOUD_DAEMON = 'https://bridge.agent-device.dev/api';
async function connect(argv: string[]): Promise<{ code: number | null; stdout: string }> {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  try {
    const result = await runCliCapture([...argv, '--state-dir', stateDir, '--json'], {
      cwd: project,
      env: { HOME: home, AGENT_DEVICE_CLOUD_BASE_URL: CLOUD },
    });
    return { code: result.code, stdout: result.stdout };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function onlyOutput(stdout: string): {
  success?: unknown;
  data?: Record<string, unknown>;
  error?: { code?: string; details?: Record<string, unknown> };
} {
  const outputs = parseJsonOutputs(stdout);
  assert.equal(outputs.length, 1, stdout);
  return outputs[0] as ReturnType<typeof onlyOutput>;
}

test('connect browserstack answers the auth requirement before its own provider admission', async () => {
  // The named provider is admitted by the connect handler, which runs after the run authenticated:
  // a run that cannot authenticate answers with its auth refusal, as it did before this release.
  const { code, stdout } = await connect([
    'connect',
    'browserstack',
    '--session',
    'ci',
    '--daemon-base-url',
    CLOUD_DAEMON,
    '--no-login',
  ]);

  assert.equal(code, 1, stdout);
  const output = onlyOutput(stdout);
  assert.equal(output.error?.code, 'UNAUTHORIZED', stdout);
  assert.equal(output.error?.details?.installCommand, undefined, stdout);
});

test('a device command on a stored BrowserStack connection authenticates before its provider is admitted', async () => {
  // A stored connection names a provider the core can read through its adapter, so a device command on
  // it is not refused for a plugin it never needs: it answers with the daemon's own transport failure.
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'browserstack.remote.json');
  const now = new Date().toISOString();
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://127.0.0.1:1',
      tenant: 'team-a',
      runId: 'run-a',
      leaseProvider: 'browserstack',
      platform: 'android',
    }),
  );
  fs.mkdirSync(path.join(stateDir, 'remote-connections'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'remote-connections', 'browserstack-a.json'),
    JSON.stringify({
      version: 1,
      session: 'browserstack-a',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: '0'.repeat(64),
      daemon: { baseUrl: 'http://127.0.0.1:1' },
      tenant: 'team-a',
      runId: 'run-a',
      leaseProvider: 'browserstack',
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    }),
  );

  try {
    const result = await runCliCapture(
      ['apps', '--session', 'browserstack-a', '--state-dir', stateDir, '--no-login', '--json'],
      { cwd: project, env: { HOME: home } },
    );

    const output = onlyOutput(result.stdout);
    assert.equal(output.error?.details?.reason, undefined, result.stdout);
    assert.equal(output.error?.details?.installCommand, undefined, result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
