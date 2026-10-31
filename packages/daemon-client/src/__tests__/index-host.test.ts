import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const ensured = vi.hoisted(() => ({ settings: undefined as unknown }));

vi.mock('../daemon-client-lifecycle.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daemon-client-lifecycle.ts')>()),
  ensureManagedDaemon: async (settings: unknown) => {
    ensured.settings = settings;
    throw new Error('stop before talking to a daemon');
  },
}));
vi.mock('../daemon-client-metadata.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daemon-client-metadata.ts')>()),
  observeLocalDaemon: async (settings: unknown) => {
    ensured.settings = settings;
    throw new Error('stop before talking to a daemon');
  },
}));

import { createDaemonTransport } from '../index.ts';
import type { DaemonClientSettings } from '../daemon-client-lifecycle.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const request = { session: 'default', command: 'devices', positionals: [] };

test('a transport resolves its daemon from the host it was built for, not the process', async () => {
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '/process/state');
  const host = {
    env: { AGENT_DEVICE_STATE_DIR: 'client-state', AGENT_DEVICE_DAEMON_SERVER_MODE: 'http' },
    cwd: '/client/workspace',
  };

  await expect(createDaemonTransport(host)(request)).rejects.toThrow('stop before talking');

  const settings = ensured.settings as DaemonClientSettings;
  expect(settings.host).toBe(host);
  expect(settings.paths.baseDir).toBe(path.resolve('/client/workspace', 'client-state'));
  expect(settings.serverMode).toBe('http');
});
