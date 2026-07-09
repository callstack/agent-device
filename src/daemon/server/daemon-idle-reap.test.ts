import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { IOS_SIMULATOR } from '../../__tests__/test-utils/index.ts';
import { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';
import {
  createDaemonIdleReap,
  hasActiveRecording,
  hasOpenSessions,
  isDaemonIdle,
  resolveDaemonIdleReapMs,
} from './daemon-idle-reap.ts';

let stateDir: string;
let sessionStore: SessionStore;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-daemon-idle-reap-'));
  sessionStore = new SessionStore(path.join(stateDir, 'sessions'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  vi.useRealTimers();
});

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    name: 'default',
    device: IOS_SIMULATOR,
    createdAt: Date.now(),
    actions: [],
    ...overrides,
  };
}

test('resolveDaemonIdleReapMs falls back to the 5 minute default', () => {
  assert.equal(resolveDaemonIdleReapMs({}), 5 * 60_000);
});

test('resolveDaemonIdleReapMs honors AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS', () => {
  assert.equal(resolveDaemonIdleReapMs({ AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '1200' }), 1_200);
});

test('resolveDaemonIdleReapMs treats 0 as an explicit value (disabled)', () => {
  assert.equal(resolveDaemonIdleReapMs({ AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0' }), 0);
});

test('resolveDaemonIdleReapMs ignores invalid overrides', () => {
  assert.equal(
    resolveDaemonIdleReapMs({ AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: 'not-a-number' }),
    5 * 60_000,
  );
  assert.equal(resolveDaemonIdleReapMs({ AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '-5' }), 5 * 60_000);
});

test('hasOpenSessions reflects the session store', () => {
  assert.equal(hasOpenSessions(sessionStore), false);
  sessionStore.set('default', makeSession());
  assert.equal(hasOpenSessions(sessionStore), true);
});

test('hasActiveRecording is true only when a stored session carries a recording', () => {
  sessionStore.set('default', makeSession());
  assert.equal(hasActiveRecording(sessionStore), false);

  sessionStore.set(
    'default',
    makeSession({
      recording: {
        platform: 'ios',
        outPath: '/tmp/demo.mp4',
        startedAt: Date.now(),
        showTouches: false,
        gestureEvents: [],
        child: { kill: () => true },
        wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      },
    }),
  );
  assert.equal(hasActiveRecording(sessionStore), true);
});

test('isDaemonIdle requires no in-flight requests, no sessions, and no recording', () => {
  assert.equal(isDaemonIdle({ sessionStore, inFlightRequestCount: 0 }), true);
  assert.equal(isDaemonIdle({ sessionStore, inFlightRequestCount: 1 }), false);

  sessionStore.set('default', makeSession());
  assert.equal(isDaemonIdle({ sessionStore, inFlightRequestCount: 0 }), false);
});

test('idle reap fires after the idle window when nothing is using the daemon', async () => {
  vi.useFakeTimers();
  let reaped = 0;
  const idleReap = createDaemonIdleReap({
    sessionStore,
    getInFlightRequestCount: () => 0,
    onIdleReap: () => {
      reaped++;
    },
    env: { AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '40' },
  });

  idleReap.noteActivity();
  await vi.advanceTimersByTimeAsync(39);
  assert.equal(reaped, 0);
  await vi.advanceTimersByTimeAsync(1);

  assert.equal(reaped, 1);
});

test('idle reap does not fire while a session is open', async () => {
  vi.useFakeTimers();
  let reaped = 0;
  sessionStore.set('default', makeSession());
  const idleReap = createDaemonIdleReap({
    sessionStore,
    getInFlightRequestCount: () => 0,
    onIdleReap: () => {
      reaped++;
    },
    env: { AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '40' },
  });

  // Simulates a quiet mid-session pause: activity settles, but the session
  // itself stays open the whole time.
  idleReap.noteActivity();
  await vi.advanceTimersByTimeAsync(150);

  assert.equal(reaped, 0);
});

test('idle reap does not fire while a recording is active', async () => {
  vi.useFakeTimers();
  let reaped = 0;
  sessionStore.set(
    'default',
    makeSession({
      recording: {
        platform: 'ios',
        outPath: '/tmp/demo.mp4',
        startedAt: Date.now(),
        showTouches: false,
        gestureEvents: [],
        child: { kill: () => true },
        wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      },
    }),
  );
  const idleReap = createDaemonIdleReap({
    sessionStore,
    getInFlightRequestCount: () => 0,
    onIdleReap: () => {
      reaped++;
    },
    env: { AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '40' },
  });

  idleReap.noteActivity();
  await vi.advanceTimersByTimeAsync(150);

  assert.equal(reaped, 0);
});

test('idle reap does not fire while a request is in flight', async () => {
  vi.useFakeTimers();
  let reaped = 0;
  let inFlightRequestCount = 1;
  const idleReap = createDaemonIdleReap({
    sessionStore,
    getInFlightRequestCount: () => inFlightRequestCount,
    onIdleReap: () => {
      reaped++;
    },
    env: { AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '40' },
  });

  idleReap.noteActivity();
  await vi.advanceTimersByTimeAsync(150);
  assert.equal(reaped, 0);

  inFlightRequestCount = 0;
  idleReap.noteActivity();
  await vi.advanceTimersByTimeAsync(40);
  assert.equal(reaped, 1);
});

test('idle reap is disabled when the window is zero', async () => {
  vi.useFakeTimers();
  let reaped = 0;
  const idleReap = createDaemonIdleReap({
    sessionStore,
    getInFlightRequestCount: () => 0,
    onIdleReap: () => {
      reaped++;
    },
    env: { AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0' },
  });

  idleReap.noteActivity();
  await vi.advanceTimersByTimeAsync(100);

  assert.equal(reaped, 0);
});

test('cancel prevents a scheduled reap from firing', async () => {
  vi.useFakeTimers();
  let reaped = 0;
  const idleReap = createDaemonIdleReap({
    sessionStore,
    getInFlightRequestCount: () => 0,
    onIdleReap: () => {
      reaped++;
    },
    env: { AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '40' },
  });

  idleReap.noteActivity();
  idleReap.cancel();
  await vi.advanceTimersByTimeAsync(150);

  assert.equal(reaped, 0);
});
