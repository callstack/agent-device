import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  DAEMON_PROGRESS_CHANNEL_ENV,
  DAEMON_STARTUP_PHASES,
  createDaemonStartupProgressMessage,
  parseDaemonStartupProgressMessage,
} from '@agent-device/daemon-contracts/daemon-startup-phases';
import { mkdtempForTestSync } from '@agent-device/test-kit';

/** A spawn environment that marks the child as a launcher-spawned detached daemon. */
const progressChannelEnv = { ...process.env, [DAEMON_PROGRESS_CHANNEL_ENV]: '1' };

test('the phase vocabulary keeps exactly the six runtime phases', () => {
  expect([...DAEMON_STARTUP_PHASES]).toEqual([
    'modules-loaded',
    'composition-loaded',
    'lock-acquired',
    'recovery-finished',
    'listening',
    'registered',
  ]);
});

test('a phase message is stamped with the sending pid and parses back', () => {
  const message = createDaemonStartupProgressMessage('lock-acquired');
  assert.equal(message.type, 'daemon-startup-phase');
  assert.equal(message.pid, process.pid);
  expect(parseDaemonStartupProgressMessage(message)).toEqual(message);
});

test.each([
  ['null', null],
  ['a string', 'daemon-startup-phase'],
  ['an unknown type', { type: 'heartbeat', pid: 1, phase: 'listening' }],
  ['an unknown phase', { type: 'daemon-startup-phase', pid: 1, phase: 'heartbeat' }],
  ['a non-string phase', { type: 'daemon-startup-phase', pid: 1, phase: 7 }],
  ['a missing pid', { type: 'daemon-startup-phase', phase: 'listening' }],
  ['a non-integer pid', { type: 'daemon-startup-phase', pid: 1.5, phase: 'listening' }],
  ['a zero pid', { type: 'daemon-startup-phase', pid: 0, phase: 'listening' }],
])('parsing ignores %s', (_name, message) => {
  expect(parseDaemonStartupProgressMessage(message)).toBeNull();
});

test('a process with an IPC channel but no launcher mark does not report over it', async () => {
  // A forked host (or test worker) has a channel of its own; it is not a launch channel.
  const stateDir = mkdtempForTestSync('agent-device-phase-unmarked-');
  const phasesUrl = import.meta.resolve('@agent-device/daemon-contracts/daemon-startup-phases');
  const entry = writeChildScript(
    stateDir,
    `import { reportDaemonStartupPhase, closeDaemonStartupProgressChannel } from ${JSON.stringify(phasesUrl)};
reportDaemonStartupPhase('modules-loaded');
closeDaemonStartupProgressChannel();
`,
  );
  const child = spawn(process.execPath, ['--experimental-strip-types', entry], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env },
  });
  child.channel?.unref();
  child.unref();
  const messages: unknown[] = [];
  child.on('message', (message) => messages.push(message));
  const exit = await Promise.race([
    new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    ),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('child did not exit; the channel held its loop')), 5_000),
    ),
  ]);
  assert.equal(exit.code, 0);
  assert.deepEqual(messages, [], 'an unmarked channel must not receive phase reports');
});

test('a child spawned without an IPC channel reports nothing and exits cleanly', async () => {
  const stateDir = mkdtempForTestSync('agent-device-phase-no-channel-');
  const phasesUrl = import.meta.resolve('@agent-device/daemon-contracts/daemon-startup-phases');
  const entry = writeChildScript(
    stateDir,
    `import { reportDaemonStartupPhase, closeDaemonStartupProgressChannel } from ${JSON.stringify(phasesUrl)};
console.log('has-channel ' + (process.channel !== undefined));
reportDaemonStartupPhase('modules-loaded');
closeDaemonStartupProgressChannel();
`,
  );
  const child = spawn(process.execPath, ['--experimental-strip-types', entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: progressChannelEnv,
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => (stdout += chunk));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
  assert.match(stdout, /^has-channel false$/m);
  assert.equal(stderr, '');
});

function writeChildScript(stateDir: string, body: string): string {
  const entry = path.join(stateDir, 'phase-child.mjs');
  fs.writeFileSync(entry, body);
  return entry;
}

test('a spawned child reports each phase over the IPC channel, and closing it lets the child exit', async () => {
  const stateDir = mkdtempForTestSync('agent-device-phase-channel-');
  const phasesUrl = import.meta.resolve('@agent-device/daemon-contracts/daemon-startup-phases');
  const entry = writeChildScript(
    stateDir,
    `import { reportDaemonStartupPhase, closeDaemonStartupProgressChannel } from ${JSON.stringify(phasesUrl)};
reportDaemonStartupPhase('modules-loaded');
reportDaemonStartupPhase('lock-acquired');
reportDaemonStartupPhase('lock-acquired');
closeDaemonStartupProgressChannel();
`,
  );
  const child = spawn(process.execPath, ['--experimental-strip-types', entry], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: progressChannelEnv,
  });
  child.channel?.unref();
  child.unref();
  const messages: unknown[] = [];
  child.on('message', (message) => messages.push(message));
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => (stderr += chunk));
  const exit = await Promise.race([
    new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    ),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('child did not exit; the channel held its loop')), 5_000),
    ),
  ]);
  assert.equal(exit.code, 0);
  assert.equal(stderr, '');
  assert.deepEqual(
    messages.map((message) => parseDaemonStartupProgressMessage(message)),
    [
      { type: 'daemon-startup-phase', pid: child.pid, phase: 'modules-loaded' },
      { type: 'daemon-startup-phase', pid: child.pid, phase: 'lock-acquired' },
      { type: 'daemon-startup-phase', pid: child.pid, phase: 'lock-acquired' },
    ],
  );
});
