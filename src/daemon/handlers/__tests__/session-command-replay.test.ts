import { test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeSessionStore } from './session-test-harness.ts';
import { handleSessionCommands } from './session-command-harness.ts';
import type { DaemonRequest } from '../../types.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { replayScriptSourceBundleFor } from '../../../__tests__/test-utils/replay-script-source.ts';

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

// #1900: `replay` routes through the named replay command handler, which
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

// #1900: `test`'s script discovery filters by each script's own `context platform=` declaration
// (`session-test-discovery.ts`'s `matchesPlatformFilter`), but `readReplayScriptMetadata`
// deliberately drops `web` as a declarable value (`ad-script`'s own
// `readReplayScriptMetadata drops unsupported web platform` test) and
// `ReplayTestPlatform = Exclude<PlatformSelector, 'web'>` (`session-test-types.ts`) excludes it
// structurally. So no `.ad` script -- typed or untyped -- can ever declare or match `web`, and
// `discoverReplayTestEntries` throws "No replay tests matched" for every source once a
// `--platform web` filter is active (an untyped source is skipped as unfiltered-out, and no typed
// source can ever carry the value the filter is looking for). That is the real, deterministic,
// command-specific web behavior of `test`: not "it runs on web" but "its declared-platform filter
// can never select web", proven here rather than merely asserted.
test('test --platform web reports no matching scripts, typed or untyped, because ReplayTestPlatform excludes web', async () => {
  const sessionStore = makeSessionStore();
  const root = mkdtempForTestSync('agent-device-test-suite-web-excluded-');
  fs.writeFileSync(path.join(root, '01-untyped.ad'), 'open "http://127.0.0.1/"\n');
  fs.writeFileSync(path.join(root, '02-android.ad'), 'context platform=android\nopen "Demo"\n');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      flags: { platform: 'web' },
      meta: { cwd: root, requestId: 'suite-web-excluded' },
    },
    sessionName: 'default',
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('test must not invoke any step when --platform web matches nothing');
    },
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe('No replay tests matched for --platform web.');
  }
});
