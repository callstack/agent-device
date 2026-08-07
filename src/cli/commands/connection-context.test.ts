import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  hashRemoteConfigFile,
  writeRemoteConnectionState,
} from '../../remote/remote-connection-state.ts';
import { resolveConnectContext } from './connection-context.ts';

test('unscoped connect contexts never adopt the ambient connection', () => {
  const { stateDir, remoteConfigPath } = makeContextFixture();
  const flags = connectFlags(stateDir);

  const first = resolveConnectContext({ stateDir, flags, remoteConfigPath });
  const second = resolveConnectContext({ stateDir, flags, remoteConfigPath });

  assert.match(first.session, /^adc-[a-f0-9]{32}$/);
  assert.notEqual(second.session, first.session);
  assert.equal(first.previous, null);
  assert.equal(second.previous, null);
});

test('an explicitly named connect context can replace its own connection', () => {
  const { stateDir, remoteConfigPath } = makeContextFixture();
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'browserstack-a',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      tenant: 'browserstack',
      runId: 'run-a',
      connectedAt: now,
      updatedAt: now,
    },
  });

  const context = resolveConnectContext({
    stateDir,
    remoteConfigPath,
    flags: { ...connectFlags(stateDir), session: 'browserstack-a', force: true },
  });

  assert.equal(context.session, 'browserstack-a');
  assert.equal(context.previous?.runId, 'run-a');
});

function makeContextFixture(): { stateDir: string; remoteConfigPath: string } {
  const root = mkdtempForTestSync('agent-device-connect-context-');
  const remoteConfigPath = path.join(root, 'remote.json');
  fs.writeFileSync(remoteConfigPath, '{}\n');
  return { stateDir: path.join(root, 'state'), remoteConfigPath };
}

function connectFlags(stateDir: string) {
  return {
    json: true,
    help: false,
    version: false,
    stateDir,
    tenant: 'browserstack',
    runId: 'run-a',
  };
}
