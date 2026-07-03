import { test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeSessionStore } from './session-test-harness.ts';
import { handleSessionCommands } from '../session.ts';
import type { DaemonRequest } from '../../types.ts';

test('replay parses open --relaunch flag and replays open with relaunch semantics', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-relaunch-'));
  const replayPath = path.join(replayRoot, 'relaunch.ad');
  fs.writeFileSync(replayPath, 'open "Settings" --relaunch\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  if (response && response.ok) {
    expect(response.data?.replayed).toBe(1);
  }
  expect(invoked.length).toBe(1);
  expect(invoked[0]?.command).toBe('open');
  expect(invoked[0]?.positionals).toEqual(['Settings']);
  expect(invoked[0]?.flags?.relaunch).toBe(true);
});

test('replay parses runtime set flags and replays runtime command', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-runtime-'));
  const replayPath = path.join(replayRoot, 'runtime.ad');
  fs.writeFileSync(
    replayPath,
    'runtime set --platform android --metro-host 10.0.0.10 --metro-port 8081 --launch-url "myapp://dev"\n',
  );
  const invoked: DaemonRequest[] = [];

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: {},
      meta: { cwd: replayRoot },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (request) => {
      invoked.push(request);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBe(true);
  expect(invoked[0]?.command).toBe('runtime');
  expect(invoked[0]?.positionals).toEqual(['set']);
  expect(invoked[0]?.flags).toEqual({
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
    launchUrl: 'myapp://dev',
  });
});

test('replay parses inline open runtime flags and replays open with runtime payload', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-open-runtime-'));
  const replayPath = path.join(replayRoot, 'runtime-open.ad');
  fs.writeFileSync(
    replayPath,
    'open "Demo" --relaunch --platform android --metro-host 10.0.0.10 --metro-port 8081 --launch-url "myapp://dev"\n',
  );
  const invoked: DaemonRequest[] = [];

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: {},
      meta: { cwd: replayRoot },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (request) => {
      invoked.push(request);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBe(true);
  expect(invoked[0]?.command).toBe('open');
  expect(invoked[0]?.positionals).toEqual(['Demo']);
  expect(invoked[0]?.flags).toEqual({ relaunch: true });
  expect(invoked[0]?.runtime).toEqual({
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
    launchUrl: 'myapp://dev',
  });
});

test('replay resolves relative script path against request cwd', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-cwd-'));
  const replayDir = path.join(replayRoot, 'workflows');
  fs.mkdirSync(replayDir, { recursive: true });
  fs.writeFileSync(path.join(replayDir, 'flow.ad'), 'open "Settings"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: ['workflows/flow.ad'],
      flags: {},
      meta: { cwd: replayRoot },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(invoked.length).toBe(1);
  expect(invoked[0]?.command).toBe('open');
  expect(invoked[0]?.positionals).toEqual(['Settings']);
});

test('replay inherits parent device selectors for each invoked step', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-parent-selectors-'),
  );
  const replayPath = path.join(replayRoot, 'selectors.ad');
  fs.writeFileSync(replayPath, 'open "com.whoop.iphone"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: {
        platform: 'ios',
        device: 'thymikee-iphone',
        udid: '00008150-001849640CF8401C',
      },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(invoked.length).toBe(1);
  expect(invoked[0]?.flags?.platform).toBe('ios');
  expect(invoked[0]?.flags?.device).toBe('thymikee-iphone');
  expect(invoked[0]?.flags?.udid).toBe('00008150-001849640CF8401C');
});
