import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { readDaemonStopIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import { stopRecordedDaemon } from './daemon-client/daemon-client-stop.ts';
import * as transport from './daemon-client/daemon-client-transport.ts';

afterEach(() => vi.restoreAllMocks());

test.each(['embedded', 'future-owner'])(
  'stop refuses %s ownership before any request or signal, even without transport or birth proof',
  async (ownership) => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-stop-owner-'));
    const record = JSON.stringify({ pid: process.pid, ownership });
    fs.writeFileSync(paths.infoPath, record);
    const send = vi.spyOn(transport, 'sendRequest');
    const signals = vi.spyOn(process, 'kill');
    await expect(
      stopRecordedDaemon(readDaemonStopIdentity(paths.infoPath), {
        paths,
        host: createTestHostEnvironment(),
      }),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: ownership === 'embedded' ? 'daemon-owner-embedded' : 'daemon-owner-unrecognized',
        daemon: { pid: process.pid },
      },
    });
    expect(send).not.toHaveBeenCalled();
    expect(signals).not.toHaveBeenCalled();
    expect(fs.readFileSync(paths.infoPath, 'utf8')).toBe(record);
  },
);

test('stop refuses an unreadable record without a request or signal', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-stop-unreadable-'));
  fs.writeFileSync(paths.infoPath, '{not json');
  const send = vi.spyOn(transport, 'sendRequest');
  const signals = vi.spyOn(process, 'kill');
  await expect(
    stopRecordedDaemon(readDaemonStopIdentity(paths.infoPath), {
      paths,
      host: createTestHostEnvironment(),
    }),
  ).rejects.toMatchObject({ details: { reason: 'daemon-record-unreadable' } });
  expect(send).not.toHaveBeenCalled();
  expect(signals).not.toHaveBeenCalled();
  expect(fs.readFileSync(paths.infoPath, 'utf8')).toBe('{not json');
});

test.each(['embedded', 'future-owner'])(
  'stop refuses %s ownership without a PID',
  async (ownership) => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-stop-no-pid-'));
    const record = JSON.stringify({ ownership });
    fs.writeFileSync(paths.infoPath, record);
    const send = vi.spyOn(transport, 'sendRequest');
    const signals = vi.spyOn(process, 'kill');
    await expect(
      stopRecordedDaemon(readDaemonStopIdentity(paths.infoPath), {
        paths,
        host: createTestHostEnvironment(),
      }),
    ).rejects.toMatchObject({
      details: {
        reason: ownership === 'embedded' ? 'daemon-owner-embedded' : 'daemon-owner-unrecognized',
        hint:
          ownership === 'embedded'
            ? 'The runtime is owned by its host process. Close it there with the handle returned by startAgentDevice(). If the host has exited, call ensureDaemon() for this state directory to recover its abandoned registration.'
            : expect.stringContaining('check what owns this registration'),
      },
    });
    expect(send).not.toHaveBeenCalled();
    expect(signals).not.toHaveBeenCalled();
    expect(fs.readFileSync(paths.infoPath, 'utf8')).toBe(record);
  },
);

test('stop refuses an embedded registration even after its host exits', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-stop-exited-host-'));
  const host = spawnSync(process.execPath, ['-e', '']);
  expect(host.status).toBe(0);
  const record = JSON.stringify({ pid: host.pid, ownership: 'embedded' });
  fs.writeFileSync(paths.infoPath, record);
  const send = vi.spyOn(transport, 'sendRequest');
  const signals = vi.spyOn(process, 'kill');
  await expect(
    stopRecordedDaemon(readDaemonStopIdentity(paths.infoPath), {
      paths,
      host: createTestHostEnvironment(),
    }),
  ).rejects.toMatchObject({
    details: {
      reason: 'daemon-owner-embedded',
      daemon: { pid: host.pid },
      hint: expect.stringContaining('call ensureDaemon() for this state directory'),
    },
  });
  expect(send).not.toHaveBeenCalled();
  expect(signals).not.toHaveBeenCalled();
  expect(fs.readFileSync(paths.infoPath, 'utf8')).toBe(record);
});
