import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readProcessStartTime } from '@agent-device/host-kit/process';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { readDaemonStopIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import { stopRecordedDaemon } from './daemon-client/daemon-client-stop.ts';
import * as transport from './daemon-client/daemon-client-transport.ts';

afterEach(() => vi.restoreAllMocks());

test.each([
  ['embedded', false],
  ['embedded', true],
  ['future-owner', false],
  ['future-owner', true],
] as const)(
  'stop refuses live %s ownership without transport (start time recorded: %s)',
  async (ownership, withStartTime) => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-stop-owner-'));
    const processStartTime = withStartTime ? readProcessStartTime(process.pid) : undefined;
    if (withStartTime) expect(processStartTime).toBeTruthy();
    const record = JSON.stringify({ pid: process.pid, ownership, processStartTime });
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
        pid: process.pid,
      },
    });
    expect(send).not.toHaveBeenCalled();
    expect(signals.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
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
  expect(signals.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  expect(fs.readFileSync(paths.infoPath, 'utf8')).toBe('{not json');
});

test.each(['embedded', 'future-owner'])(
  'stop has no process to retire for %s ownership without a PID',
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
    ).resolves.toMatchObject({ stopped: false, mode: 'not-running' });
    expect(send).not.toHaveBeenCalled();
    expect(signals).not.toHaveBeenCalled();
    expect(fs.readFileSync(paths.infoPath, 'utf8')).toBe(record);
  },
);

test.each([
  ['embedded', true],
  ['embedded', false],
  ['future-owner', true],
  ['future-owner', false],
] as const)(
  'stop requires lifetime proof to retire an exited %s host (start time recorded: %s)',
  async (ownership, withStartTime) => {
    const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-stop-exited-host-'));
    const host = spawn(process.execPath, ['-e', "process.stdin.resume(); console.log('ready')"], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      await once(host.stdout!, 'data');
      const processStartTime = readProcessStartTime(host.pid!);
      expect(processStartTime).toBeTruthy();
      fs.writeFileSync(
        paths.infoPath,
        JSON.stringify({
          pid: host.pid,
          processStartTime: withStartTime ? processStartTime : undefined,
          ownership,
        }),
      );
      const exited = once(host, 'exit');
      host.stdin!.end();
      await exited;
      const send = vi.spyOn(transport, 'sendRequest');
      const signals = vi.spyOn(process, 'kill');
      const stopped = stopRecordedDaemon(readDaemonStopIdentity(paths.infoPath), {
        paths,
        host: createTestHostEnvironment(),
      });
      if (withStartTime) {
        await expect(stopped).resolves.toMatchObject({ stopped: false, mode: 'not-running' });
      } else {
        await expect(stopped).rejects.toMatchObject({
          details: {
            reason:
              ownership === 'embedded' ? 'daemon-owner-embedded' : 'daemon-owner-unrecognized',
          },
        });
      }
      expect(send).not.toHaveBeenCalled();
      expect(signals.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
      expect(fs.existsSync(paths.infoPath)).toBe(!withStartTime);
    } finally {
      if (host.exitCode === null) host.kill();
    }
  },
);
