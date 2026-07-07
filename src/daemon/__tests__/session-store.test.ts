import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../session-store.ts';
import type { SessionState } from '../types.ts';
import { buildRequestFinishedEvent } from '../session-event-log.ts';

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

test('recordAction writes a paged session event log', async () => {
  const { store, session } = makeFixture('agent-device-session-events-');
  recordOpen(store, session, { platform: 'ios' });
  store.recordAction(session, {
    command: 'click',
    positionals: ['@14', 'Checkout'],
    flags: { platform: 'ios' },
    result: { ref: '14', refLabel: 'Checkout', x: 120, y: 240, message: 'Tapped @14 (120, 240)' },
  });
  await store.flushEvents(session.name);

  const eventLogPath = store.resolveEventLogPath(session.name);
  assert.equal(fs.existsSync(eventLogPath), true);
  const firstPage = store.readEvents(session.name, { limit: 1 });
  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.events[0]?.kind, 'action.recorded');
  assert.equal(firstPage.nextCursor, '1');

  const secondPage = store.readEvents(session.name, { cursor: firstPage.nextCursor, limit: 1 });
  assert.equal(secondPage.events[0]?.summary, 'Tapped @14');
  assert.equal(secondPage.nextCursor, undefined);
});

test('recordAction event log redacts typed text from display positionals', async () => {
  const { store, session } = makeFixture('agent-device-session-events-redaction-');
  store.recordAction(session, {
    command: 'fill',
    positionals: ['@14', 'super-secret-token'],
    flags: {},
    result: { ref: '14', text: 'super-secret-token', message: 'Filled super-secret-token' },
  });
  await store.flushEvents(session.name);

  const page = store.readEvents(session.name);
  const serialized = JSON.stringify(page.events);
  assert.equal(serialized.includes('super-secret-token'), false);
  assert.equal(page.events[0]?.summary, 'Filled @14');
  assert.equal(page.events[0]?.details?.message, undefined);
  assert.deepEqual(page.events[0]?.details?.positionals, ['@14', '<text:18 chars>']);
  assert.equal(page.events[0]?.details?.textLength, 18);
});

test('recordAction event log redacts payload-bearing and unknown positionals', async () => {
  const { store, session } = makeFixture('agent-device-session-events-payload-redaction-');
  const clipboardText = 'super-secret-token';
  const pushPayload = '{"token":"push-secret-token"}';
  const eventPayload = '{"token":"event-secret-token"}';
  const futurePayload = 'future-secret-token';

  store.recordAction(session, {
    command: 'clipboard',
    positionals: ['write', clipboardText],
    flags: {},
    result: { action: 'write', textLength: Array.from(clipboardText).length },
  });
  store.recordAction(session, {
    command: 'push',
    positionals: ['com.example.app', pushPayload],
    flags: {},
    result: { message: 'Pushed notification to com.example.app' },
  });
  store.recordAction(session, {
    command: 'trigger-app-event',
    positionals: ['checkout', eventPayload],
    flags: {},
    result: { message: 'Triggered app event checkout' },
  });
  store.recordAction(session, {
    command: 'future-command',
    positionals: ['public-ish', futurePayload],
    flags: {},
    result: { message: `Ran ${futurePayload}` },
  });
  await store.flushEvents(session.name);

  const page = store.readEvents(session.name);
  const serialized = JSON.stringify(page.events);
  assert.equal(serialized.includes(clipboardText), false);
  assert.equal(serialized.includes(pushPayload), false);
  assert.equal(serialized.includes(eventPayload), false);
  assert.equal(serialized.includes(futurePayload), false);
  assert.deepEqual(page.events[0]?.details?.positionals, ['write', '<text:18 chars>']);
  assert.deepEqual(page.events[1]?.details?.positionals, ['com.example.app', '<payload:29 chars>']);
  assert.deepEqual(page.events[2]?.details?.positionals, ['checkout', '<payload:30 chars>']);
  assert.deepEqual(page.events[3]?.details?.positionals, ['<arg:10 chars>', '<arg:19 chars>']);
  assert.equal(page.events[3]?.summary, 'Ran future-command');
  assert.equal(page.events[3]?.details?.message, undefined);
});

test('recordAction event log omits transformed messages for redacted positionals', async () => {
  const { store, session } = makeFixture('agent-device-session-events-overlap-redaction-');

  store.recordAction(session, {
    command: 'future-command',
    positionals: ['token', 'my-token-123'],
    flags: {},
    result: { message: 'Ran my-token-123 after token' },
  });
  store.recordAction(session, {
    command: 'future-command',
    positionals: ['arg', 'my-arg-123'],
    flags: {},
    result: { message: 'Ran my-arg-123 after arg' },
  });
  await store.flushEvents(session.name);

  const page = store.readEvents(session.name);
  const serialized = JSON.stringify(page.events);
  assert.equal(serialized.includes('my-token-123'), false);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('my-arg-123'), false);
  assert.equal(page.events[0]?.summary, 'Ran future-command');
  assert.equal(page.events[0]?.details?.message, undefined);
  assert.deepEqual(page.events[0]?.details?.positionals, ['<arg:5 chars>', '<arg:12 chars>']);
  assert.equal(page.events[1]?.summary, 'Ran future-command');
  assert.equal(page.events[1]?.details?.message, undefined);
});

test('recordAction event log does not leak short typed text through message replacement', async () => {
  const { store, session } = makeFixture('agent-device-session-events-short-text-');
  store.recordAction(session, {
    command: 'type',
    positionals: ['e'],
    flags: {},
    result: { text: 'e', message: 'Typed 1 chars' },
  });
  await store.flushEvents(session.name);

  const page = store.readEvents(session.name);
  const serialized = JSON.stringify(page.events);
  assert.equal(serialized.includes('"e"'), false);
  assert.equal(page.events[0]?.summary, 'Typed <text:1 chars>');
  assert.equal(page.events[0]?.details?.message, undefined);
  assert.deepEqual(page.events[0]?.details?.positionals, ['<text:1 chars>']);
});

test('recordAction event log omits value-bearing selector details', async () => {
  const { store, session } = makeFixture('agent-device-session-events-selector-redaction-');
  store.recordAction(session, {
    command: 'click',
    positionals: ['value=123456'],
    flags: {},
    result: {
      refLabel: '123456',
      selector: 'value="123456"',
      selectorChain: ['value="123456" editable=true'],
      message: 'Tapped 123456',
    },
  });
  await store.flushEvents(session.name);

  const page = store.readEvents(session.name);
  const serialized = JSON.stringify(page.events);
  assert.equal(serialized.includes('123456'), false);
  assert.equal(page.events[0]?.summary, 'Tapped target');
  assert.equal(page.events[0]?.details?.message, undefined);
  assert.equal(page.events[0]?.details?.refLabel, undefined);
  assert.equal(page.events[0]?.details?.selector, undefined);
  assert.equal(page.events[0]?.details?.selectorChain, undefined);
  assert.equal(page.events[0]?.details?.selectorChainLength, 1);
});

test('request failure event log omits raw error message and hint', async () => {
  const { store, session } = makeFixture('agent-device-session-events-error-redaction-');
  const secretPayload = '{"ssn":"123-45-6789"';
  store.recordEvent(
    session.name,
    buildRequestFinishedEvent({
      req: {
        token: 'test-token',
        session: session.name,
        command: 'trigger-app-event',
        positionals: ['login', secretPayload],
        meta: { requestId: 'req-secret-error' },
      },
      response: {
        ok: false,
        error: {
          code: 'INVALID_ARGS',
          message: `Invalid trigger-app-event payload JSON: ${secretPayload}`,
          hint: `Fix payload ${secretPayload}`,
        },
      },
      durationMs: 12,
    }),
  );
  await store.flushEvents(session.name);

  const page = store.readEvents(session.name);
  const serialized = JSON.stringify(page.events);
  assert.equal(serialized.includes(secretPayload), false);
  assert.equal(page.events[0]?.summary, 'Failed trigger-app-event: INVALID_ARGS');
  assert.equal(page.events[0]?.details?.message, undefined);
  assert.equal(page.events[0]?.details?.hint, undefined);
});

test('saveScript path writes session log to custom location', async () => {
  const { root, store, session } = makeFixture('agent-device-session-log-custom-path-', 'sessions');
  const customPath = path.join(root, 'workflows', 'my-flow.ad');
  recordOpen(store, session, { platform: 'ios', saveScript: customPath });
  recordClose(store, session);

  store.writeSessionLog(session);
  await store.flushEvents(session.name);
  assert.equal(fs.existsSync(customPath), true);
  assert.equal(fs.existsSync(store.resolveEventLogPath(session.name)), true);
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
