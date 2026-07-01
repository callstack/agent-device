import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';

type RecordActionEntry = Parameters<SessionStore['recordAction']>[1];

type SessionStoreFixture = {
  root: string;
  store: SessionStore;
  session: SessionState;
};

function makeSession(name: string): SessionState {
  return {
    name,
    device: {
      platform: 'apple',
      id: 'sim-1',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  };
}

function isSessionScriptFile(file: string): boolean {
  return file.endsWith('.ad');
}

function listSessionScriptFiles(root: string): string[] {
  return fs.readdirSync(root).filter(isSessionScriptFile);
}

function readWrittenSessionScript(root: string): string {
  const scriptFile = fs.readdirSync(root).find(isSessionScriptFile);
  assert.ok(scriptFile);
  return fs.readFileSync(path.join(root, scriptFile), 'utf8');
}

function makeFixture(prefix: string, sessionsDir?: string): SessionStoreFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    store: new SessionStore(sessionsDir ? path.join(root, sessionsDir) : root),
    session: makeSession('default'),
  };
}

function recordOpen(
  store: SessionStore,
  session: SessionState,
  flags: RecordActionEntry['flags'] = { platform: 'ios', saveScript: true },
  runtime?: RecordActionEntry['runtime'],
): void {
  store.recordAction(session, {
    command: 'open',
    positionals: ['Settings'],
    flags,
    runtime,
    result: {},
  });
}

function recordClose(store: SessionStore, session: SessionState): void {
  store.recordAction(session, {
    command: 'close',
    positionals: [],
    flags: { platform: 'ios' },
    result: {},
  });
}

function writeScript({ root, store, session }: SessionStoreFixture): string {
  store.writeSessionLog(session);
  return readWrittenSessionScript(root);
}

function assertScriptMatches(script: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    assert.match(script, pattern);
  }
}

test('expandHome resolves tilde, relative-with-cwd, and absolute paths', () => {
  const homePath = SessionStore.expandHome('~/flows/replay.ad');
  assert.equal(homePath.startsWith(os.homedir()), true);
  assert.equal(homePath.endsWith(path.join('flows', 'replay.ad')), true);

  const relativePath = SessionStore.expandHome('workflows/replay.ad', '/tmp/agent-device-cwd');
  assert.equal(relativePath, path.resolve('/tmp/agent-device-cwd', 'workflows/replay.ad'));

  const absoluteInput = path.resolve('/tmp', 'agent-device-absolute.ad');
  const absolutePath = SessionStore.expandHome(absoluteInput, '/tmp/ignored-cwd');
  assert.equal(absolutePath, absoluteInput);
});

test('defaultTracePath sanitizes session name', () => {
  const store = new SessionStore(path.join(os.tmpdir(), 'agent-device-tests'));
  const session = makeSession('session with spaces');
  const tracePath = store.defaultTracePath(session);
  assert.match(tracePath, /session_with_spaces/);
  assert.match(tracePath, /\.trace\.log$/);
});

test('session lease metadata round-trips through the store', () => {
  const { store, session } = makeFixture('agent-device-session-lease-');
  session.lease = {
    leaseId: 'f'.repeat(32),
    tenantId: 'tenant-a',
    runId: 'run-1',
    clientId: 'client-a',
    leaseBackend: 'ios-simulator',
    leaseProvider: 'proxy',
    deviceKey: 'ios:SIM-001',
    expiresAt: 123_456,
  };

  store.set(session.name, session);

  assert.deepEqual(store.get(session.name)?.lease, session.lease);
});

test('sessions without lease metadata remain valid', () => {
  const { store, session } = makeFixture('agent-device-session-unleased-');

  store.set(session.name, session);

  assert.equal(store.get(session.name)?.lease, undefined);
});

test('saveScript flag enables .ad session log writing', () => {
  const { root, store, session } = makeFixture('agent-device-session-log-enabled-');
  recordOpen(store, session);
  recordClose(store, session);

  store.writeSessionLog(session);
  assert.equal(listSessionScriptFiles(root).length, 1);
});

test('saveScript path writes session log to custom location', () => {
  const { root, store, session } = makeFixture('agent-device-session-log-custom-path-', 'sessions');
  const customPath = path.join(root, 'workflows', 'my-flow.ad');
  recordOpen(store, session, { platform: 'ios', saveScript: customPath });
  recordClose(store, session);

  store.writeSessionLog(session);
  assert.equal(fs.existsSync(customPath), true);
  assert.equal(fs.existsSync(path.join(root, 'sessions')), false);
});

test('writeSessionLog persists open --relaunch in script output', () => {
  const fixture = makeFixture('agent-device-session-log-relaunch-');
  recordOpen(fixture.store, fixture.session, { platform: 'ios', saveScript: true, relaunch: true });
  recordClose(fixture.store, fixture.session);

  const script = writeScript(fixture);
  assert.match(script, /open "Settings" --relaunch/);
});

test('writeSessionLog persists record --hide-touches flags in script output', () => {
  const fixture = makeFixture('agent-device-session-log-record-');
  recordOpen(fixture.store, fixture.session);
  fixture.store.recordAction(fixture.session, {
    command: 'record',
    positionals: ['start', './capture.mp4'],
    flags: {
      platform: 'ios',
      fps: 30,
      screenshotMaxSize: 1024,
      quality: 'high',
      hideTouches: true,
    },
    result: { action: 'start', showTouches: false },
  });

  const script = writeScript(fixture);
  assert.match(
    script,
    /record start "\.\/capture\.mp4" --fps 30 --max-size 1024 --quality high --hide-touches/,
  );
});

test('writeSessionLog persists screenshot flags in script output', () => {
  const fixture = makeFixture('agent-device-session-log-screenshot-');
  recordOpen(fixture.store, fixture.session);
  fixture.store.recordAction(fixture.session, {
    command: 'screenshot',
    positionals: ['./page.png'],
    flags: { platform: 'ios', screenshotFullscreen: true, screenshotMaxSize: 1024 },
    result: {},
  });

  const script = writeScript(fixture);
  assert.match(script, /screenshot "\.\/page\.png" --fullscreen --max-size 1024/);
});

test('writeSessionLog persists inline open runtime hints in script output', () => {
  const fixture = makeFixture('agent-device-session-log-open-runtime-');
  recordOpen(
    fixture.store,
    fixture.session,
    { platform: 'ios', saveScript: true, relaunch: true },
    {
      platform: 'ios',
      metroHost: '127.0.0.1',
      metroPort: 8081,
      launchUrl: 'myapp://dev',
    },
  );
  recordClose(fixture.store, fixture.session);

  const script = writeScript(fixture);
  assert.match(
    script,
    /open "Settings" --relaunch --platform ios --metro-host 127\.0\.0\.1 --metro-port 8081 --launch-url myapp:\/\/dev/,
  );
});

test('writeSessionLog persists runtime set hints in script output', () => {
  const fixture = makeFixture('agent-device-session-log-runtime-');
  recordOpen(fixture.store, fixture.session);
  fixture.store.recordAction(fixture.session, {
    command: 'runtime',
    positionals: ['set'],
    flags: {
      platform: 'ios',
      metroHost: '127.0.0.1',
      metroPort: 8081,
      launchUrl: 'myapp://dev',
    },
    result: {},
  });
  recordClose(fixture.store, fixture.session);

  const script = writeScript(fixture);
  assert.match(
    script,
    /runtime set --platform ios --metro-host 127\.0\.0\.1 --metro-port 8081 --launch-url myapp:\/\/dev/,
  );
});

test('writeSessionLog preserves interaction series flags for click/press/swipe', () => {
  const fixture = makeFixture('agent-device-session-log-series-flags-');
  recordOpen(fixture.store, fixture.session);
  fixture.store.recordAction(fixture.session, {
    command: 'click',
    positionals: ['id="continue_button"'],
    flags: {
      platform: 'ios',
      count: 5,
      intervalMs: 1,
      holdMs: 2,
      jitterPx: 3,
      doubleTap: true,
    },
    result: {},
  });
  fixture.store.recordAction(fixture.session, {
    command: 'press',
    positionals: ['201', '545'],
    flags: {
      platform: 'ios',
      count: 4,
      intervalMs: 8,
    },
    result: {},
  });
  fixture.store.recordAction(fixture.session, {
    command: 'swipe',
    positionals: ['10', '20', '30', '40'],
    flags: {
      platform: 'ios',
      count: 3,
      pauseMs: 12,
      pattern: 'ping-pong',
    },
    result: {},
  });
  fixture.store.recordAction(fixture.session, {
    command: 'fill',
    positionals: ['@e5', 'search'],
    flags: {
      platform: 'ios',
      delayMs: 40,
    },
    result: {},
  });
  recordClose(fixture.store, fixture.session);

  const script = writeScript(fixture);
  assertScriptMatches(script, [
    /click "id=\\"continue_button\\"" --count 5 --interval-ms 1 --hold-ms 2 --jitter-px 3 --double-tap/,
    /press 201 545 --count 4 --interval-ms 8/,
    /swipe 10 20 30 40 --count 3 --pause-ms 12 --pattern ping-pong/,
    /fill @e5 "search" --delay-ms 40/,
  ]);
});

test('writeSessionLog optimizes selector chains and scopes fallback snapshots', () => {
  const fixture = makeFixture('agent-device-session-log-selectors-');
  recordOpen(fixture.store, fixture.session);
  fixture.store.recordAction(fixture.session, {
    command: 'snapshot',
    positionals: [],
    flags: { platform: 'ios', snapshotInteractiveOnly: true },
    result: {},
  });
  fixture.store.recordAction(fixture.session, {
    command: 'click',
    positionals: ['@e1'],
    flags: { platform: 'ios', count: 2 },
    result: { selectorChain: ['text="Continue"', 'role=button'], refLabel: 'Continue' },
  });
  fixture.store.recordAction(fixture.session, {
    command: 'longpress',
    positionals: ['@e3', '800'],
    flags: { platform: 'ios' },
    result: {
      selectorChain: ['label="Last message"', 'role="statictext"'],
      durationMs: 800,
    },
  });
  fixture.store.recordAction(fixture.session, {
    command: 'fill',
    positionals: ['@e2', 'hello world'],
    flags: { platform: 'ios', delayMs: 5 },
    result: { refLabel: 'Email' },
  });

  const script = writeScript(fixture);
  assert.doesNotMatch(script, /\nsnapshot\n/);
  assertScriptMatches(script, [
    /click "text=\\"Continue\\" \|\| role=button" --count 2/,
    /longpress "label=\\"Last message\\" \|\| role=\\"statictext\\"" 800/,
    /snapshot -i -s "Email"/,
    /fill @e2 "Email" "hello world" --delay-ms 5/,
  ]);
});

test('writeSessionLog escapes device labels with quotes and backslashes', () => {
  const fixture = makeFixture('agent-device-session-log-device-label-');
  fixture.session.device.name = 'QA "Lab" \\ Shelf';
  recordOpen(fixture.store, fixture.session);

  const script = writeScript(fixture);
  assert.match(
    script,
    /context platform=ios device="QA \\"Lab\\" \\\\ Shelf" kind=simulator theme=unknown/,
  );
});

test('writeSessionLog preserves significant whitespace and empty string arguments', () => {
  const fixture = makeFixture('agent-device-session-log-whitespace-');
  recordOpen(
    fixture.store,
    fixture.session,
    { platform: 'ios', saveScript: true },
    {
      platform: 'ios',
      metroHost: ' host\t',
      launchUrl: 'myapp://dev ',
    },
  );
  fixture.store.recordAction(fixture.session, {
    command: 'type',
    positionals: ['  leading\ttrailing  '],
    flags: { platform: 'ios' },
    result: {},
  });
  fixture.store.recordAction(fixture.session, {
    command: 'fill',
    positionals: ['@e5', ''],
    flags: { platform: 'ios' },
    result: { refLabel: 'Search field' },
  });
  fixture.store.recordAction(fixture.session, {
    command: 'screenshot',
    positionals: [' ./screens/final.png '],
    flags: { platform: 'ios' },
    result: {},
  });

  const script = writeScript(fixture);
  assertScriptMatches(script, [
    /type "  leading\\ttrailing  "/,
    /fill @e5 "Search field" ""/,
    /screenshot " \.\/screens\/final\.png "/,
    /--metro-host " host\\t" --launch-url "myapp:\/\/dev "/,
  ]);
});
