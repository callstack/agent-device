import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
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
