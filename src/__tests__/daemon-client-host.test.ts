import { afterEach, expect, test, vi } from 'vitest';

const built = vi.hoisted(() => ({
  clientHosts: [] as unknown[],
  ensuringHosts: [] as unknown[],
}));

// The transports the client and the CLI build are stopped before they reach a daemon: which host
// each is built for is what these tests pin. That a transport reads its host is pinned in the
// daemon-client package.
vi.mock('@agent-device/daemon-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/daemon-client')>()),
  createDaemonTransport: (host: unknown) => {
    built.clientHosts.push(host);
    return async () => {
      throw new Error('stop before talking to a daemon');
    };
  },
  createEnsuredDaemonTransport: (options: { host?: unknown } = {}) => {
    built.ensuringHosts.push(options.host);
    return async () => {
      throw new Error('stop before talking to a daemon');
    };
  },
}));

import { runCli } from '../cli.ts';
import { createAgentDeviceClient } from '../agent-device-client.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  built.clientHosts.length = 0;
  built.ensuringHosts.length = 0;
});

test('a client reports and uses the same state dir when its host and the process disagree', async () => {
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '/process/state');
  const host = { env: { AGENT_DEVICE_STATE_DIR: '/client/state' }, cwd: '/client/workspace' };
  const client = createAgentDeviceClient({}, { host });

  await expect(client.sessions.stateDir()).resolves.toBe('/client/state');
  await expect(client.devices.list()).rejects.toThrow('stop before talking');

  expect(built.clientHosts).toEqual([host]);
  expect(built.clientHosts[0]).toBe(host);
});

test('a CLI run builds its transport from the host it was given', async () => {
  const host = { env: { AGENT_DEVICE_STATE_DIR: '/cli/state' }, cwd: '/cli/workspace' };
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const transportForHost = vi.fn(() => async () => ({ ok: true as const, data: { devices: [] } }));

  await runCli(['devices', '--json'], { sendToDaemon: vi.fn(), transportForHost }, host);

  expect(transportForHost).toHaveBeenCalledWith(host);
});

test('a CLI run with the default transport builds its ensuring transport from the given host', async () => {
  const host = { env: { AGENT_DEVICE_STATE_DIR: '/cli/state' }, cwd: '/cli/workspace' };
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);

  await runCli(['devices', '--json'], undefined, host).catch(() => undefined);

  expect(built.ensuringHosts.at(-1)).toBe(host);
});
