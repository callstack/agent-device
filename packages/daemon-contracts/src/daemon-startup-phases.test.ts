import { expect, test, vi } from 'vitest';
import {
  DAEMON_PROGRESS_CHANNEL_ENV,
  openDaemonStartupProgress,
  parseDaemonStartupProgressMessage,
  type DaemonStartupProgressProcess,
} from '@agent-device/daemon-contracts/daemon-startup-phases';

const marked = { [DAEMON_PROGRESS_CHANNEL_ENV]: '1' };

function fakeProcess(options: { channel?: boolean; sendError?: Error } = {}) {
  const sent: unknown[] = [];
  const stderr: string[] = [];
  const unref = vi.fn();
  const proc = {
    connected: options.channel !== false,
    channel: options.channel === false ? undefined : { unref },
    send: (message: unknown, callback: (error: Error | null) => void) => {
      sent.push(message);
      callback(options.sendError ?? null);
      return true;
    },
    disconnect: vi.fn(() => {
      proc.connected = false;
    }),
    stderr: { write: (chunk: string) => stderr.push(chunk) },
  };
  return { proc, sent, stderr, unref };
}

const asProcess = (proc: unknown) => proc as DaemonStartupProgressProcess;

test('a marked launch channel carries each phase, in order, and is unrefed', () => {
  const { proc, sent, unref } = fakeProcess();
  const progress = openDaemonStartupProgress(marked, asProcess(proc));
  progress.report('modules-loaded');
  progress.report('lock-acquired');
  expect(sent.map(parseDaemonStartupProgressMessage)).toEqual(['modules-loaded', 'lock-acquired']);
  expect(unref).toHaveBeenCalledOnce();
});

test('closing ends reporting and disconnects once', () => {
  const { proc, sent } = fakeProcess();
  const progress = openDaemonStartupProgress(marked, asProcess(proc));
  progress.close();
  progress.close();
  progress.report('registered');
  expect(proc.disconnect).toHaveBeenCalledOnce();
  expect(sent).toEqual([]);
});

test('an IPC channel without the launcher mark is never used', () => {
  const { proc, sent, unref } = fakeProcess();
  const progress = openDaemonStartupProgress({}, asProcess(proc));
  progress.report('modules-loaded');
  progress.close();
  expect(sent).toEqual([]);
  expect(unref).not.toHaveBeenCalled();
  expect(proc.disconnect).not.toHaveBeenCalled();
});

test('a marked process without a channel reports nothing', () => {
  const { proc, sent } = fakeProcess({ channel: false });
  const progress = openDaemonStartupProgress(marked, asProcess(proc));
  progress.report('modules-loaded');
  progress.close();
  expect(sent).toEqual([]);
});

test('a failed send writes one stderr line and stops reporting', () => {
  const { proc, sent, stderr } = fakeProcess({ sendError: new Error('channel closed') });
  const progress = openDaemonStartupProgress(marked, asProcess(proc));
  progress.report('modules-loaded');
  progress.report('lock-acquired');
  expect(sent).toHaveLength(1);
  expect(stderr).toEqual(['Daemon startup phase report failed: channel closed\n']);
});

test.each([
  'modules-loaded',
  'composition-loaded',
  'lock-acquired',
  'recovery-finished',
  'listening',
  'registered',
] as const)('the %s phase message parses', (phase) => {
  const { proc, sent } = fakeProcess();
  openDaemonStartupProgress(marked, asProcess(proc)).report(phase);
  expect(parseDaemonStartupProgressMessage(sent[0])).toBe(phase);
});

test.each([
  ['null', null],
  ['a string', 'daemon-startup-phase'],
  ['an unknown type', { type: 'heartbeat', phase: 'listening' }],
  ['an unknown phase', { type: 'daemon-startup-phase', phase: 'heartbeat' }],
  ['a non-string phase', { type: 'daemon-startup-phase', phase: 7 }],
])('parsing ignores %s', (_name, message) => {
  expect(parseDaemonStartupProgressMessage(message)).toBeNull();
});
