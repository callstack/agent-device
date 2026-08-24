import { test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeSession, makeSessionStore } from './session-test-harness.ts';
import { handleSessionCommands } from './session-command-harness.ts';
import type { DaemonRequest } from '../../types.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { replayScriptSourceBundleFor } from '../../../__tests__/test-utils/replay-script-source.ts';
import { WEB_DESKTOP_DEVICE } from '../../../__tests__/test-utils/device-fixtures.ts';

test('replay parses open --relaunch flag and replays open with relaunch semantics', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = mkdtempForTestSync('agent-device-replay-relaunch-');
  const replayPath = path.join(replayRoot, 'relaunch.ad');
  fs.writeFileSync(replayPath, 'open "Settings" --relaunch\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: { replayScriptSource: replayScriptSourceBundleFor(replayPath) },
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
  const replayRoot = mkdtempForTestSync('agent-device-replay-runtime-');
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
      flags: { replayScriptSource: replayScriptSourceBundleFor(replayPath) },
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
  const replayRoot = mkdtempForTestSync('agent-device-replay-open-runtime-');
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
      flags: { replayScriptSource: replayScriptSourceBundleFor(replayPath) },
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
  expect(invoked[0]?.flags).toEqual({ relaunch: true, platform: 'android' });
  expect(invoked[0]?.runtime).toEqual({
    platform: 'android',
    metroHost: '10.0.0.10',
    metroPort: 8081,
    launchUrl: 'myapp://dev',
  });
});

test('replay inherits parent device selectors for each invoked step', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = mkdtempForTestSync('agent-device-replay-parent-selectors-');
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
        replayScriptSource: replayScriptSourceBundleFor(replayPath),
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

// #1900: `replay` routes through `handleSessionReplayCommandGroup` -> `session-replay.ts`, which
// re-invokes each recorded step with no `platform === 'web'` branch anywhere in that path.
test('replay inherits the parent web platform selector for each invoked step', async () => {
  const sessionStore = makeSessionStore();
  const replayRoot = mkdtempForTestSync('agent-device-replay-web-selectors-');
  const replayPath = path.join(replayRoot, 'web-selectors.ad');
  fs.writeFileSync(replayPath, 'open "http://127.0.0.1/"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      flags: {
        platform: 'web',
        replayScriptSource: replayScriptSourceBundleFor(replayPath),
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
  expect(invoked[0]?.flags?.platform).toBe('web');
});

// #1900: with no `--platform` filter, `discoverReplayTestEntries` (`session-test-discovery.ts`)
// runs every discovered script unconditionally (`if (!platformFilter) { entries.push(run); ... }`)
// — the per-script `context platform=` declaration matters only for filtering, and
// `readReplayScriptMetadata` deliberately drops `web` as a declarable value (`ad-script`'s
// `readReplayScriptMetadata drops unsupported web platform` test), so an unfiltered `test` run
// against a session already bound to a web device runs its script the same as any other platform.
test('test runs an undeclared script against a session already bound to a web device', async () => {
  const sessionStore = makeSessionStore();
  sessionStore.set('default', makeSession('default', WEB_DESKTOP_DEVICE));
  const root = mkdtempForTestSync('agent-device-test-suite-web-session-');
  fs.writeFileSync(path.join(root, '01-web.ad'), 'open "http://127.0.0.1/"\n');

  const invoked: DaemonRequest[] = [];
  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      flags: {},
      meta: { cwd: root, requestId: 'suite-web-session' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invoked.push(req);
      return { ok: true, data: {} };
    },
  });

  expect(response?.ok).toBe(true);
  expect(invoked.length).toBe(1);
  if (response?.ok) {
    expect(response.data?.passed).toBe(1);
    expect(response.data?.skipped).toBe(0);
  }
});
