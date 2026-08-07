import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { readRemoteConnectionState } from '../../src/remote/remote-connection-state.ts';
import { runSourceCliJsonSync } from './cli-json.ts';

test('separate CLI processes do not adopt and overwrite the ambient remote session', () => {
  const root = mkdtempForTestSync('agent-device-connect-process-isolation-');
  const stateDir = path.join(root, 'state');
  const firstConfig = writeRemoteConfig(root, 'first', 'iPhone 15 Pro', '17');
  const secondConfig = writeRemoteConfig(root, 'second', 'iPad Pro 11 2025', '26');

  const first = connectInSeparateProcess(stateDir, firstConfig);
  const second = connectInSeparateProcess(stateDir, secondConfig);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstSession = readConnectedSession(first.json);
  const secondSession = readConnectedSession(second.json);
  assert.notEqual(secondSession, firstSession);
  assert.equal(
    readRemoteConnectionState({ stateDir, session: firstSession })?.remoteConfigPath,
    firstConfig,
  );
  assert.equal(
    readRemoteConnectionState({ stateDir, session: secondSession })?.remoteConfigPath,
    secondConfig,
  );
});

function writeRemoteConfig(
  root: string,
  runId: string,
  device: string,
  providerOsVersion: string,
): string {
  const configPath = path.join(root, `${runId}.remote.json`);
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      daemonBaseUrl: 'https://daemon.example.test/agent-device',
      tenant: 'browserstack',
      runId,
      sessionIsolation: 'tenant',
      platform: 'ios',
      device,
      providerOsVersion,
    })}\n`,
  );
  return configPath;
}

function connectInSeparateProcess(stateDir: string, remoteConfig: string) {
  return runSourceCliJsonSync([
    'connect',
    '--remote-config',
    remoteConfig,
    '--state-dir',
    stateDir,
    '--force',
    '--json',
  ]);
}

function readConnectedSession(output: unknown): string {
  const session = (output as { data?: { session?: unknown } } | undefined)?.data?.session;
  assert.ok(typeof session === 'string');
  return session;
}
