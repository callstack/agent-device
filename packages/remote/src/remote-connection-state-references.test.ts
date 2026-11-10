import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import {
  hashRemoteConfigFile,
  isRemoteConfigReferenced,
  writeRemoteConnectionState,
} from './remote-connection-state.ts';

test('a missing record directory references no profile', () => {
  const stateDir = path.join(mkdtempForTestSync('agent-device-remote-refs-missing-'), 'state');

  expect(isRemoteConfigReferenced({ stateDir, remoteConfigPath: '/profile.json' })).toBe(false);
});

test('a record directory that cannot be read counts as a reference', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-refs-unreadable-');
  // A regular file where the record directory belongs: listing it fails with ENOTDIR.
  fs.writeFileSync(path.join(stateDir, 'remote-connections'), '');

  expect(isRemoteConfigReferenced({ stateDir, remoteConfigPath: '/profile.json' })).toBe(true);
});

test('a record that does not parse counts as a reference', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-refs-malformed-');
  fs.mkdirSync(path.join(stateDir, 'remote-connections'));
  fs.writeFileSync(path.join(stateDir, 'remote-connections', 'broken.json'), '{');

  expect(isRemoteConfigReferenced({ stateDir, remoteConfigPath: '/profile.json' })).toBe(true);
});

test('a valid record for another profile is not a reference', () => {
  const stateDir = mkdtempForTestSync('agent-device-remote-refs-other-');
  const configPath = path.join(stateDir, 'other.json');
  fs.writeFileSync(configPath, '{}');
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'other',
      remoteConfigPath: configPath,
      remoteConfigHash: hashRemoteConfigFile(configPath),
      tenant: 'acme',
      runId: 'run-1',
      connectedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  });

  expect(isRemoteConfigReferenced({ stateDir, remoteConfigPath: '/profile.json' })).toBe(false);
});
