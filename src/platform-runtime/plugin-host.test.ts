import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { expect, test } from 'vitest';
import { createPlatformPluginHost } from './plugin-host.ts';
import fs from 'node:fs';
import path from 'node:path';

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
