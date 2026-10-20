import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';
import { runCmd, runCmdBackground, withCommandHost } from './exec.ts';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from './diagnostics.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
afterEach(() => vi.useRealTimers());

type Row = {
  requestId: string;
  durationMs: number;
  data: {
    execId: string;
    event: string;
    pid?: number;
    timeoutMs?: number;
    exitCode?: number;
    signal?: string;
    reason?: string;
  };
};

function processFixture() {
  const child = Object.assign(new ChildProcess(), {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  vi.mocked(spawn).mockReturnValue(child);
  return {
    child,
    kill,
    exit(code: number) {
      Object.defineProperty(child, 'exitCode', { value: code, configurable: true });
      child.emit('exit', code, null);
    },
  };
}

async function capture(debug: boolean, run: () => Promise<void>, envTrace = false) {
  const logPath = path.join(mkdtempForTestSync('exec-timeline-'), 'request.ndjson');
  await withCommandHost(
    {
      host: {
        env: { AGENT_DEVICE_EXEC_TRACE: envTrace ? '1' : undefined },
        cwd: process.cwd(),
      },
      requestEnv: undefined,
    },
    () =>
      withDiagnosticsScope({ requestId: 'prepare-request', debug, logPath }, async () => {
        await run();
        flushDiagnosticsToSessionFile();
      }),
  );
  return fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Row)
    : [];
}

for (const debug of [false, true]) {
  test(`exit before deadline with inherited stdio keeps timeout semantics (trace=${debug})`, async () => {
    vi.useFakeTimers();
    const fixture = processFixture();
    const rows = await capture(debug, async () => {
      const result = runCmd('xcrun', ['simctl', '--set', '/private/set', 'list', 'devices', '-j'], {
        timeoutMs: 100,
      });
      const rejection = expect(result).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { timeoutMs: 100, exitCode: 0 },
      });
      fixture.child.emit('spawn');
      fixture.exit(0);
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      fixture.child.emit('close', 0, null);
    });
    expect(fixture.kill).toHaveBeenCalledTimes(0);
    if (!debug) {
      expect(rows).toEqual([]);
      return;
    }
    expect(rows.map((row) => row.data.event)).toEqual([
      'spawn_start',
      'spawn',
      'exit',
      'deadline',
      'settled',
      'close',
    ]);
    expect(rows.find((row) => row.data.event === 'settled')?.data.reason).toBe('timeout');
    expect(rows.find((row) => row.data.event === 'exit')?.data.exitCode).toBe(0);
    expect(rows.every((row) => row.requestId === 'prepare-request')).toBe(true);
    expect(new Set(rows.map((row) => row.data.execId)).size).toBe(1);
    expect(rows.slice(1).every((row) => row.data.pid === 12345 && row.data.timeoutMs === 100)).toBe(
      true,
    );
    expect(rows.map((row) => row.durationMs)).toEqual(
      rows.map((row) => row.durationMs).sort((a, b) => a - b),
    );
  });
}

test('deadline before exit records the signal and one settlement without waiting for close', async () => {
  vi.useFakeTimers();
  const fixture = processFixture();
  const rows = await capture(true, async () => {
    const result = runCmd('xcrun', ['simctl', 'list', 'devices', '-j'], { timeoutMs: 100 });
    const rejection = expect(result).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    fixture.child.emit('spawn');
    await vi.advanceTimersByTimeAsync(100);
    Object.defineProperty(fixture.child, 'signalCode', { value: 'SIGKILL' });
    fixture.child.emit('exit', null, 'SIGKILL');
    await rejection;
    fixture.child.emit('close', null, 'SIGKILL');
  });
  expect(fixture.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(rows.map((row) => row.data.event)).toEqual([
    'spawn_start',
    'spawn',
    'deadline',
    'exit',
    'settled',
    'close',
  ]);
  expect(rows.find((row) => row.data.event === 'exit')?.data.signal).toBe('SIGKILL');
});

test('successful close preserves output and tracing retains safe metadata without process inputs', async () => {
  const fixture = processFixture();
  const secret = 'unregistered-secret-value';
  const rows = await capture(
    false,
    async () => {
      const result = runCmd('/usr/bin/tool', ['--token', secret], {
        env: { SECRET: secret },
        stdin: secret,
      });
      fixture.child.emit('spawn');
      fixture.child.stdout.write('ok');
      fixture.exit(0);
      fixture.child.emit('close', 0, null);
      expect(await result).toMatchObject({ stdout: 'ok', stderr: '', exitCode: 0 });
    },
    true,
  );
  expect(JSON.stringify(rows)).not.toContain(secret);
  expect(rows.map((row) => row.data.event)).toEqual([
    'spawn_start',
    'spawn',
    'exit',
    'close',
    'settled',
  ]);
  expect(rows.at(-1)?.data.reason).toBe('success');
  expect(JSON.stringify(rows)).not.toContain('args');
});

test('background tracing is opt-in and retains a successful completion', async () => {
  const fixture = processFixture();
  const rows = await capture(
    false,
    async () => {
      const { wait } = runCmdBackground('/usr/bin/tool', ['private-argument']);
      fixture.child.emit('spawn');
      fixture.exit(0);
      fixture.child.emit('close', 0, null);
      expect((await wait).exitCode).toBe(0);
    },
    true,
  );
  expect(rows.map((row) => row.data.event)).toEqual(['spawn_start', 'spawn', 'settled']);
  expect(JSON.stringify(rows)).not.toContain('private-argument');
});
