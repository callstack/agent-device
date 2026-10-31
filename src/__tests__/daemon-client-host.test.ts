import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { createTestHostEnvironment, supportsLoopbackBind } from '@agent-device/test-kit';
import { runCli } from '../cli.ts';
import { createAgentDeviceClient } from '@agent-device/client';
import {
  startRegisteredHttpDaemon,
  stateDirAndPaths,
  type RegisteredHttpDaemon,
} from './test-utils/registered-http-daemon.ts';

// A client or a CLI run takes the host it is given. These tests run the real client and the real
// default CLI against a real registered daemon on the host's state directory, while the process
// names another one: a daemon resolved from the process would be started, so launching is refused.
vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(() => {
    throw new Error('A daemon was launched: the host state directory was not used.');
  }),
}));
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';

let daemon: RegisteredHttpDaemon | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(runCmdDetachedMonitored).mockClear();
  await daemon?.close();
  daemon = undefined;
});

async function bootHostAndProcess() {
  daemon = await startRegisteredHttpDaemon();
  const { stateDir: processStateDir } = stateDirAndPaths();
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', processStateDir);
  const host = createTestHostEnvironment({ env: { AGENT_DEVICE_STATE_DIR: daemon.stateDir } });
  return { host, processStateDir };
}

test('a client reports and uses the state dir of its host when the process names another', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { host, processStateDir } = await bootHostAndProcess();
  const client = createAgentDeviceClient({}, { host });

  await expect(client.sessions.stateDir()).resolves.toBe(daemon!.paths.baseDir);
  await client.devices.list();

  expect(daemon!.commands()).toEqual(['devices']);
  expect(vi.mocked(runCmdDetachedMonitored)).not.toHaveBeenCalled();
  expect(fs.existsSync(`${processStateDir}/daemon.json`)).toBe(false);
});

test('a CLI run builds its transport from the host it was given', async () => {
  const host = { env: { AGENT_DEVICE_STATE_DIR: '/cli/state' }, cwd: '/cli/workspace' };
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const transportForHost = vi.fn(() => async () => ({ ok: true as const, data: { devices: [] } }));

  await runCli(['devices', '--json'], { sendToDaemon: vi.fn(), transportForHost }, host);

  expect(transportForHost).toHaveBeenCalledWith(host);
});

test('a default CLI run reaches the daemon on the state dir of the host it was given', async (t) => {
  if (!(await supportsLoopbackBind())) return t.skip('loopback listeners are not permitted');
  const { host, processStateDir } = await bootHostAndProcess();
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

  await runCli(['devices', '--json'], undefined, host);

  expect(daemon!.commands()).toEqual(['devices']);
  expect(stdout).toHaveBeenCalled();
  expect(vi.mocked(runCmdDetachedMonitored)).not.toHaveBeenCalled();
  expect(fs.existsSync(`${processStateDir}/daemon.json`)).toBe(false);
});
