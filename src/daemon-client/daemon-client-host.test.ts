import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const ensured = vi.hoisted(() => ({ settings: undefined as unknown }));

vi.mock('./daemon-client-lifecycle.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./daemon-client-lifecycle.ts')>()),
  ensureManagedDaemon: async (settings: unknown) => {
    ensured.settings = settings;
    throw new Error('stop before talking to a daemon');
  },
}));
vi.mock('./daemon-client-startup.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./daemon-client-startup.ts')>()),
  observeLocalDaemon: async (settings: unknown) => {
    ensured.settings = settings;
    throw new Error('stop before talking to a daemon');
  },
}));

import { runCli } from '../cli.ts';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createDaemonTransport } from './daemon-client.ts';
import type { DaemonClientSettings } from './daemon-client-lifecycle.ts';

afterEach(() => {
  vi.restoreAllMocks();
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

test('a client reports and uses the same state dir when its host and the process disagree', async () => {
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '/process/state');
  const host = { env: { AGENT_DEVICE_STATE_DIR: '/client/state' }, cwd: '/client/workspace' };
  const client = createAgentDeviceClient({}, { host });

  await expect(client.sessions.stateDir()).resolves.toBe('/client/state');
  await expect(client.devices.list()).rejects.toThrow();

  expect((ensured.settings as DaemonClientSettings).paths.baseDir).toBe('/client/state');
});

test('a CLI run builds its transport from the host it was given', async () => {
  const host = { env: { AGENT_DEVICE_STATE_DIR: '/cli/state' }, cwd: '/cli/workspace' };
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const transportForHost = vi.fn(() => async () => ({ ok: true as const, data: { devices: [] } }));

  await runCli(['devices', '--json'], { sendToDaemon: vi.fn(), transportForHost }, host);

  expect(transportForHost).toHaveBeenCalledWith(host);
});

test('a CLI run with the default transport resolves its daemon from the given host', async () => {
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '/process/state');
  const host = { env: { AGENT_DEVICE_STATE_DIR: '/cli/state' }, cwd: '/cli/workspace' };
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);

  await runCli(['devices', '--json'], undefined, host).catch(() => undefined);

  expect((ensured.settings as DaemonClientSettings).paths.baseDir).toBe('/cli/state');
});
