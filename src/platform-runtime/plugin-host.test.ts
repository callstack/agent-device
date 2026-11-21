import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { OwnedProcessRecord } from '@agent-device/contracts/platform-runtime-host';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import {
  createOwnedProcessRecordStore,
  readProcessCommand,
  readProcessStartTime,
} from '@agent-device/host-kit/process';
import { createPlatformPluginHost } from './plugin-host.ts';

// The managed HarmonyOS plugin resolves HDC from the toolchain roots its host names, and it asks
// this host whether a candidate is executable rather than reading the filesystem itself (R13). A
// host that cannot answer makes the family report a missing toolchain, so the port has to work.
test('the platform plugin host answers whether a path is an executable file', () => {
  const root = mkdtempForTestSync('plugin-host-executable-');
  const script = path.join(root, 'hdc');
  fs.writeFileSync(script, '#!/bin/sh\necho stub\n', { mode: 0o755 });
  const notAFile = path.join(root, 'missing');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'text\n');
  const host = createPlatformPluginHost(createLiveTestHostEnvironment(), root);

  return Promise.all([
    expect(host.isFileExecutable(script)).resolves.toBe(true),
    expect(host.isFileExecutable(path.join(root, 'notes.txt'))).resolves.toBe(false),
    expect(host.isFileExecutable(notAFile)).resolves.toBe(false),
  ]);
});

// A plugin's streamed log is a durable resource, not a fire-and-forget spawn: the host publishes the
// ownership marker the core recovers after a restart, streams into the sink the caller opened, and
// clears the marker when the process ends.
test('the platform plugin host keeps a background command as a managed process', async () => {
  const root = mkdtempForTestSync('plugin-host-background-');
  const sessionsDir = path.join(root, 'sessions', 's1');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const script = path.join(root, 'stream.sh');
  // A stream that exits before its marker is written would prove nothing, so this one stays open
  // until it is stopped, the way `hilog` does.
  fs.writeFileSync(script, '#!/bin/sh\necho "$MARKER_WORD"\nwhile :; do sleep 0.1; done\n', {
    mode: 0o755,
  });
  const host = createPlatformPluginHost(createLiveTestHostEnvironment(), root);
  const written: string[] = [];
  const markerPath = path.join(sessionsDir, 'app-log.pid');

  const process = await host.startBackgroundCommand!(
    {
      command: {
        executable: script,
        args: [],
        env: { MARKER_WORD: 'hilog line' },
        allowFailure: true,
      },
      output: {
        write: async (chunk) => {
          written.push(chunk.toString());
        },
        [Symbol.asyncDispose]: async () => {},
      },
      markerPath,
    },
    new AbortController().signal,
  );

  expect(process.marker?.pid).toBeGreaterThan(0);
  // The marker is the core's own record, so its recovery path reads it.
  expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toMatchObject({
    pid: process.marker?.pid,
  });

  await process.terminate();
  expect((await process.wait).exitCode).not.toBe(0);
  expect(written.join('')).toContain('hilog line');
  expect(fs.existsSync(markerPath)).toBe(false);
});

// The marker is confined to the daemon's sessions directory: a plugin cannot point the core's
// recovery scan at a file it does not own.
test('the platform plugin host refuses a background command marker outside its sessions directory', async () => {
  const root = mkdtempForTestSync('plugin-host-marker-');
  const host = createPlatformPluginHost(createLiveTestHostEnvironment(), root);

  await expect(
    host.startBackgroundCommand!(
      {
        command: { executable: '/bin/echo', args: ['x'] },
        output: { write: async () => {}, [Symbol.asyncDispose]: async () => {} },
        markerPath: path.join(root, 'app-log.pid'),
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('sessions directory');
});

// A managed plugin is bundled with its own copy of the host kit and the request's scopes never enter
// that copy, so the plugin must ask this host for its process reads (R13). Answering here is what puts
// a read in the request's exec trace: the `ps` the host ran shows up under `--debug`, which is the
// evidence a read made through the bundle cannot produce.
test('the platform plugin host answers a process read inside the request exec trace', async () => {
  const root = mkdtempForTestSync('plugin-host-process-trace-');
  const logPath = path.join(root, 'events.ndjson');
  const host = createPlatformPluginHost(createLiveTestHostEnvironment(), root);

  await withDiagnosticsScope({ command: 'open', debug: true, logPath }, async () => {
    const table = await host.processes.list({ timeoutMs: 5_000 });
    // This process is on the table the host just read, so the read reached the real machine.
    expect(table.map(({ pid }) => pid)).toContain(process.pid);
  });

  expect(tracedCommands(logPath)).toContain('ps');
});

test('the platform plugin host answers identity facts for a pid it names', async () => {
  const root = mkdtempForTestSync('plugin-host-identity-');
  const host = createPlatformPluginHost(createLiveTestHostEnvironment(), root);

  const facts = await host.processes.readIdentities([process.pid]);

  // The host is this process's own host, so it must name the one pid it cannot miss.
  expect(facts.get(process.pid)?.startTime).toBeTruthy();
  expect(facts.get(process.pid)?.zombie).toBe(false);
});

// The reap a managed web plugin asks for is the one place the port signals a process, and it proves
// the recorded identity with a process-tool read before it does. Answered here, that stop is the
// core's own: it uses the store, environment and trace of the daemon that owns the record.
test('the platform plugin host stops a recorded process it is asked to reap', async () => {
  const root = mkdtempForTestSync('plugin-host-reap-');
  const logPath = path.join(root, 'events.ndjson');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120_000)'], {
    stdio: 'ignore',
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('no pid for the process to reap');
  let watchedExit = false;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      watchedExit = true;
      resolve();
    }),
  );
  const startTime = readProcessStartTime(pid);
  const command = readProcessCommand(pid);
  if (startTime === null || command === null) {
    child.kill('SIGKILL');
    throw new Error(`the host named no identity for the live pid ${pid}`);
  }
  const store = createOwnedProcessRecordStore({
    stateDir: root,
    sessionsDir: path.join(root, 'sessions'),
    resolveSessionDir: (sessionId) => path.join(root, 'sessions', sessionId),
  });
  store.replace({ kind: 'daemon' }, [
    { pid, startTime, command, purpose: 'verified-managed-web-browser' },
  ]);
  const host = createPlatformPluginHost(createLiveTestHostEnvironment(), root);

  let reaped;
  try {
    reaped = await withDiagnosticsScope(
      { command: 'open', debug: true, logPath },
      async () =>
        await host.processes.reapOwnedRecords(store, {
          purposes: ['verified-managed-web-browser'],
          termTimeoutMs: 2_000,
          killTimeoutMs: 2_000,
        }),
    );
    await exited;
  } finally {
    if (!watchedExit) {
      // Only a process this test still owns: the reap's own SIGTERM is the expected way out.
      child.kill('SIGKILL');
    }
  }

  expect(reaped.terminatedPids).toEqual([pid]);
  expect(store.read()).toEqual([]);
  expect(tracedCommands(logPath)).toContain('ps');
});

// The managed web install lock is the other place a plugin would otherwise take a claim with its own
// copy of the lock mechanics: naming an owner reads this process's birth time through the process tool,
// and every poll of a held lock re-proves the recorded owner and the guard holder with another. Answered
// here, both the claim and the wait land in the request's exec trace.
test('the platform plugin host holds a lock and names this process as its owner', async () => {
  const root = mkdtempForTestSync('plugin-host-lock-');
  const logPath = path.join(root, 'events.ndjson');
  const lockDirPath = path.join(root, 'install', '.agent-browser-install.lock');
  const host = createPlatformPluginHost(createLiveTestHostEnvironment(), root);

  let ownerWhileHeld: { pid: number; startTime: string | null } | undefined;
  const result = await withDiagnosticsScope(
    { command: 'open', debug: true, logPath },
    async () =>
      await host.processes.withLock({
        lockDirPath,
        timeoutMs: 5_000,
        description: 'managed agent-browser setup',
        task: async () => {
          // The claim is standing, and it names this process by the identity only a host read gives.
          ownerWhileHeld = JSON.parse(
            fs.readFileSync(path.join(lockDirPath, 'owner.json'), 'utf8'),
          ) as { pid: number; startTime: string | null };
          return 'task result';
        },
      }),
  );

  expect(result).toBe('task result');
  expect(ownerWhileHeld?.pid).toBe(process.pid);
  expect(ownerWhileHeld?.startTime).toBeTruthy();
  // A released lock leaves no claim standing for the next caller to wait on.
  expect(fs.existsSync(lockDirPath)).toBe(false);
  // The owner identity read is a `ps`, traced by the host that took the claim.
  expect(tracedCommands(logPath)).toContain('ps');
});

// The managed web plugin asks this host whether a record an earlier run wrote still names its fleet,
// because the answer depends on facts the plugin cannot read: the start-time format its own `ps` emits,
// the zombie state, and the signal probe for a pid the table did not list. The fail-closed rule lives
// here so one host's verdict is what every plugin gets.
test('the platform plugin host judges a recorded fleet from its own process reads', async () => {
  const root = mkdtempForTestSync('plugin-host-liveness-');
  const host = createPlatformPluginHost(createLiveTestHostEnvironment(), root);
  const processes = host.processes;
  const recorded = (pid: number, startTime: string): OwnedProcessRecord => ({
    pid,
    startTime,
    command: `command-${pid}`,
    purpose: 'verified-managed-web-browser',
  });

  // This process is alive under the identity a host read of it answers with, so a record carrying that
  // identity is judged alive.
  const startTime = readProcessStartTime(process.pid);
  if (startTime === null) throw new Error(`the host named no start time for ${process.pid}`);
  expect(await processes.judgeRecordedLiveness([recorded(process.pid, startTime)])).toEqual([
    'alive',
  ]);

  // A record written by a host that stamps start times another way cannot be compared at all: the
  // answer is unknown evidence, not a verdict that the recorded fleet exited.
  const otherLifetime = startTime.startsWith('linux:')
    ? 'Fri Jan 01 00:00:00 2026'
    : 'linux:11111111-1111-4111-8111-111111111111:12345';
  expect(await processes.judgeRecordedLiveness([recorded(process.pid, otherLifetime)])).toEqual([
    'unobserved',
  ]);

  // A pid this process started and reaped is gone: the table does not name it and the probe agrees.
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const childPid = child.pid;
  if (childPid === undefined) throw new Error('no pid for the short-lived process');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  expect(await processes.judgeRecordedLiveness([recorded(childPid, startTime)])).toEqual([
    'not-alive',
  ]);

  // Nothing asked, nothing judged.
  expect(await processes.judgeRecordedLiveness([])).toEqual([]);
});

/** The commands one debug run traced, in the order the request saw them. */
function tracedCommands(logPath: string): string[] {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase?: string; data?: { command?: string } })
    .filter(({ phase }) => phase === 'exec_command')
    .flatMap(({ data }) => (typeof data?.command === 'string' ? [data.command] : []));
}
