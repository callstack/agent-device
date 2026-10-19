import fs from 'node:fs';

import path from 'node:path';
import { withCommandHost } from '@agent-device/host-kit/command';
import { afterEach, expect, test } from 'vitest';
import { openAppLogOutput, readAppLogOutputTail } from './platform-runtime-app-log-output.ts';
import {
  bindTestCommandHost,
  createLiveTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';

bindTestCommandHost();

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('reads a bounded trusted app.log suffix and rejects paths outside sessions', async () => {
  const root = mkdtempForTestSync('agent-device-app-log-output-');
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const sessionDir = path.join(sessionsDir, 'one');
  fs.mkdirSync(sessionDir, { recursive: true });
  const outputPath = path.join(sessionDir, 'app.log');
  fs.writeFileSync(outputPath, 'before\nshared\n');

  expect(await readAppLogOutputTail(sessionsDir, outputPath, 7)).toBe('shared\n');
  await expect(
    readAppLogOutputTail(sessionsDir, path.join(root, 'outside', 'app.log'), 10),
  ).rejects.toThrow('outside the daemon-owned sessions directory');
  await expect(
    openAppLogOutput(
      sessionsDir,
      path.join(sessionDir, 'other.log'),
      createLiveTestHostEnvironment(),
    ),
  ).rejects.toThrow('outside the daemon-owned sessions directory');
});

test('rejects a symlinked session directory that escapes the sessions root', async () => {
  const root = mkdtempForTestSync('agent-device-app-log-symlink-');
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(sessionsDir);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(sessionsDir, 'linked'));
  await expect(
    openAppLogOutput(
      sessionsDir,
      path.join(sessionsDir, 'linked', 'app.log'),
      createLiveTestHostEnvironment(),
    ),
  ).rejects.toThrow('resolves outside');
});

test('rejects a final app.log symlink before append and preserves the outside file', async () => {
  const fixture = finalSymlinkFixture('append');
  await expect(
    openAppLogOutput(fixture.sessionsDir, fixture.outputPath, createLiveTestHostEnvironment()),
  ).rejects.toThrow('symbolic link');
  expect(fs.readFileSync(fixture.outsidePath, 'utf8')).toBe('outside-append');
});

test('rejects a final app.log symlink before tail read and preserves the outside file', async () => {
  const fixture = finalSymlinkFixture('tail');
  await expect(readAppLogOutputTail(fixture.sessionsDir, fixture.outputPath, 100)).rejects.toThrow(
    'regular file',
  );
  expect(fs.readFileSync(fixture.outsidePath, 'utf8')).toBe('outside-tail');
});

test('aligns a bounded UTF-8 suffix to the first complete line', async () => {
  const root = mkdtempForTestSync('agent-device-app-log-tail-');
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const sessionDir = path.join(sessionsDir, 'one');
  fs.mkdirSync(sessionDir, { recursive: true });
  const outputPath = path.join(sessionDir, 'app.log');
  fs.writeFileSync(outputPath, 'old\n🙂partial\nshared\n');

  expect(await readAppLogOutputTail(sessionsDir, outputPath, 17)).toBe('shared\n');
});

test('rejects an asynchronous stream-open failure without an unhandled error', async () => {
  const root = mkdtempForTestSync('agent-device-app-log-open-');
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const outputPath = path.join(sessionsDir, 'one', 'app.log');
  fs.mkdirSync(outputPath, { recursive: true });

  await expect(
    openAppLogOutput(sessionsDir, outputPath, createLiveTestHostEnvironment()),
  ).rejects.toThrow('regular file');
});

function finalSymlinkFixture(label: string) {
  const root = mkdtempForTestSync(`agent-device-app-log-${label}-`);
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const sessionDir = path.join(sessionsDir, 'one');
  const outsidePath = path.join(root, 'outside.log');
  const outputPath = path.join(sessionDir, 'app.log');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(outsidePath, `outside-${label}`);
  fs.symlinkSync(outsidePath, outputPath);
  return { sessionsDir, outputPath, outsidePath };
}

test('redacts with the patterns of the command host, not the process', async () => {
  const root = mkdtempForTestSync('agent-device-app-log-redact-');
  roots.push(root);
  const sessionsDir = path.join(root, 'sessions');
  const outputPath = path.join(sessionsDir, 'one', 'app.log');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  await withCommandHost(
    {
      host: { env: { AGENT_DEVICE_APP_LOG_REDACT_PATTERNS: 'secret-\\d+' }, cwd: root },
      requestEnv: undefined,
    },
    async () => {
      const sink = await openAppLogOutput(sessionsDir, outputPath, {
        env: { AGENT_DEVICE_APP_LOG_REDACT_PATTERNS: 'secret-\\d+' },
        cwd: root,
      });
      await sink.write('token secret-42 leaked\n');
      await sink[Symbol.asyncDispose]();
    },
  );

  expect(fs.readFileSync(outputPath, 'utf8')).toBe('token [REDACTED] leaked\n');
});
