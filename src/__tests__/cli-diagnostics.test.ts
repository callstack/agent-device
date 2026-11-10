import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonResponse } from '@agent-device/daemon-client';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  runCliCapture as captureCli,
  type CapturedCliRun,
  type CapturedDaemonRequest,
} from './cli-capture.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

async function runCliCapture(
  argv: string[],
  responder: (req: CapturedDaemonRequest) => Promise<DaemonResponse>,
  options?: {
    env?: Record<string, string | undefined>;
  },
): Promise<CapturedCliRun> {
  return captureCli(argv, responder, {
    env: options?.env,
    stateDirPrefix: 'agent-device-cli-diagnostics-',
  });
}

test('cli forwards --debug as verbose/debug metadata', async () => {
  const result = await runCliCapture(['open', 'settings', '--debug', '--json'], async () => ({
    ok: true,
    data: {
      app: 'settings',
      platform: 'ios',
      target: 'mobile',
      device: 'iPhone 16',
      id: 'SIM-001',
    },
  }));
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'open');
  assert.equal(result.calls[0]?.flags?.verbose, true);
  assert.equal(result.calls[0]?.meta?.debug, true);
  assert.equal(result.calls[0]?.meta?.cwd, process.cwd());
  assert.equal(typeof result.calls[0]?.meta?.requestId, 'string');
});

test('cli does not tail local daemon log when remote daemon base URL is set', async () => {
  const stateDir = mkdtempForTestSync('agent-device-cli-remote-');
  const daemonPaths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(path.dirname(daemonPaths.logPath), { recursive: true });
  fs.writeFileSync(daemonPaths.logPath, 'REMOTE_TAIL_SENTINEL\n', 'utf8');

  try {
    const result = await runCliCapture(
      ['clipboard', 'write', 'hello', '--debug', '--state-dir', stateDir],
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          ok: true,
          data: { action: 'write', message: 'Clipboard updated' },
        };
      },
      {
        env: {
          AGENT_DEVICE_DAEMON_BASE_URL: 'http://remote-mac.example.test:7777/agent-device',
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'remote-secret',
        },
      },
    );
    assert.equal(result.code, null);
    assert.equal(result.stdout.includes('REMOTE_TAIL_SENTINEL'), false);
    assert.match(result.stdout, /Clipboard updated/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cli debug log tail starts at the current daemon log end', async () => {
  const stateDir = mkdtempForTestSync('agent-device-cli-tail-');
  const daemonPaths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(path.dirname(daemonPaths.logPath), { recursive: true });
  fs.writeFileSync(daemonPaths.logPath, 'OLD_TAIL_SENTINEL\n', 'utf8');

  try {
    const result = await captureCli(
      ['clipboard', 'write', 'hello', '--debug', '--state-dir', stateDir],
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        fs.appendFileSync(daemonPaths.logPath, 'NEW_TAIL_SENTINEL\n', 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 250));
        return {
          ok: true,
          data: { action: 'write', message: 'Clipboard updated' },
        };
      },
      {
        stateDirPrefix: 'agent-device-cli-diagnostics-',
      },
    );

    assert.equal(result.code, null);
    assert.equal(result.stdout.includes('OLD_TAIL_SENTINEL'), false);
    assert.equal(result.stdout.includes('NEW_TAIL_SENTINEL'), true);
    assert.match(result.stdout, /Clipboard updated/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cli returns normalized JSON failures with diagnostics fields', async () => {
  const result = await runCliCapture(['open', 'settings', '--json'], async () => ({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'boom',
      hint: 'retry later',
      diagnosticId: 'diag-123',
      logPath: '/tmp/diag.ndjson',
      details: { token: 'secret', safe: 'ok' },
    },
  }));
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, false);
  assert.equal(payload.error.code, 'COMMAND_FAILED');
  assert.equal(payload.error.hint, 'retry later');
  assert.equal(payload.error.diagnosticId, 'diag-123');
  assert.equal(payload.error.logPath, '/tmp/diag.ndjson');
  assert.equal(payload.error.details.token, '[REDACTED]');
  assert.equal(payload.error.details.safe, 'ok');
});

test('cli parse failures include diagnostic references in JSON mode', async () => {
  const previousHome = process.env.HOME;
  process.env.HOME = '/tmp';
  try {
    const result = await runCliCapture(['open', '--unknown-flag', '--json'], async () => ({
      ok: true,
      data: {},
    }));
    assert.equal(result.code, 1);
    assert.equal(result.calls.length, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, 'INVALID_ARGS');
    assert.equal(typeof payload.error.diagnosticId, 'string');
    assert.equal(typeof payload.error.logPath, 'string');
  } finally {
    process.env.HOME = previousHome;
  }
});

const possiblyDispatchedFailure = async (): Promise<DaemonResponse> => ({
  ok: false,
  error: {
    code: 'COMMAND_FAILED',
    message: 'tap timed out',
    diagnosticId: 'diag-123',
    logPath: '/tmp/diag.ndjson',
    details: { dispatched: 'unknown' },
  },
});

// Callers merge stderr into stdout and keep only `head -1` or `tail -1`. Both lines must carry
// the code, the dispatch fact and the Next step; the log path stays printed between them.
test('a failed command opens and closes stderr with the same summary line', async () => {
  const result = await runCliCapture(['click', '@e12'], possiblyDispatchedFailure);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  const lines = result.stderr.trimEnd().split('\n');
  assert.match(
    lines[0] ?? '',
    /^Error \(COMMAND_FAILED\): tap timed out\. May have reached the device\. Next: .*Run snapshot/,
  );
  assert.equal(lines.at(-1), lines[0]);
  assert.ok(lines.includes('Log: /tmp/diag.ndjson'));
  assert.equal(result.stderr.includes('diag-123'), false);
});

test('a --debug failure still ends on the summary line after the daemon log tail', async () => {
  const stateDir = mkdtempForTestSync('agent-device-cli-debug-failure-');
  const daemonPaths = resolveDaemonPaths(stateDir);
  fs.mkdirSync(path.dirname(daemonPaths.logPath), { recursive: true });
  fs.writeFileSync(daemonPaths.logPath, 'DAEMON_TAIL_SENTINEL\n', 'utf8');
  try {
    const result = await runCliCapture(
      ['click', '@e12', '--debug', '--state-dir', stateDir],
      possiblyDispatchedFailure,
    );
    assert.equal(result.code, 1);
    const lines = result.stderr.trimEnd().split('\n');
    const summary = lines.find((line) => line.startsWith('Error (COMMAND_FAILED)'));
    assert.ok(summary);
    assert.ok(lines.indexOf('DAEMON_TAIL_SENTINEL') > lines.indexOf(summary));
    assert.equal(lines.at(-1), summary);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an argument error names the failing command synopsis as its Next step', async () => {
  const result = await runCliCapture(['press', '--unknown-flag'], async () => ({
    ok: true,
    data: {},
  }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^Error \(INVALID_ARGS\): .*Next: .*Usage: agent-device press /);
});

test('an argument error after leading global flags still names the command synopsis', async () => {
  const result = await runCliCapture(
    ['--platform', 'ios', 'press', '--unknown-flag'],
    async () => ({ ok: true, data: {} }),
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^Error \(INVALID_ARGS\): .*Usage: agent-device press /);
});

// The parser knows `--session` takes a value, so `press` here is the session name, not the command.
test('an argument error never takes a flag value for the command', async () => {
  const result = await runCliCapture(
    ['--session', 'press', 'fill', '--unknown-flag'],
    async () => ({
      ok: true,
      data: {},
    }),
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage: agent-device fill /);
  assert.equal(result.stderr.includes('Usage: agent-device press'), false);
});

test('cli forwards save-script and no-record flags for client-backed open', async () => {
  const result = await runCliCapture(
    ['open', 'settings', '--save-script', '--no-record', '--json'],
    async () => ({
      ok: true,
      data: {
        app: 'settings',
        platform: 'ios',
        target: 'mobile',
        device: 'iPhone 16',
        id: 'SIM-001',
      },
    }),
  );
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'open');
  assert.equal(result.calls[0]?.flags?.saveScript, true);
  assert.equal(result.calls[0]?.flags?.noRecord, true);
});

test('cli preserves --out for client-backed screenshot', async () => {
  const result = await runCliCapture(
    ['screenshot', '--out', '/tmp/shot.png', '--json'],
    async () => ({
      ok: true,
      data: { path: '/tmp/shot.png' },
    }),
  );
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.command, 'screenshot');
  assert.deepEqual(result.calls[0]?.positionals, ['/tmp/shot.png']);
});

test('cli applies AGENT_DEVICE_PLATFORM to client-backed commands', async () => {
  const result = await runCliCapture(
    ['open', 'com.example.app', '--json'],
    async () => ({
      ok: true,
      data: {
        app: 'com.example.app',
        platform: 'android',
        target: 'mobile',
        device: 'Pixel 9',
        id: 'emulator-5554',
      },
    }),
    { env: { AGENT_DEVICE_PLATFORM: 'android' } },
  );
  assert.equal(result.code, null);
  assert.equal(result.calls[0]?.flags?.platform, 'android');
});

test('cli accepts every platform selector in AGENT_DEVICE_PLATFORM for a command without --platform', async () => {
  const result = await captureCli(['auth', 'status', '--json'], {
    env: { AGENT_DEVICE_PLATFORM: 'web' },
    stateDirPrefix: 'agent-device-cli-platform-env-',
  });
  assert.equal(result.code, null, result.stdout);
  assert.equal(JSON.parse(result.stdout).success, true);
});

test('cli rejects an unknown AGENT_DEVICE_PLATFORM with the platform selector list', async () => {
  const result = await captureCli(['auth', 'status', '--json'], {
    env: { AGENT_DEVICE_PLATFORM: 'symbian' },
    stateDirPrefix: 'agent-device-cli-platform-env-',
  });
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, 'INVALID_ARGS');
  assert.match(error.message, /apple, android, harmonyos, vega, linux, web, ios, macos/);
});

test('cli prints success acknowledgment for client-backed open in human mode', async () => {
  const result = await runCliCapture(['open', 'settings'], async () => ({
    ok: true,
    data: {
      session: 'default',
      appName: 'Settings',
      message: 'Opened: Settings',
      platform: 'ios',
      target: 'mobile',
      device: 'iPhone 16',
      id: 'SIM-001',
    },
  }));
  assert.equal(result.code, null);
  assert.match(result.stdout, /Opened: Settings/);
});

test('cli prints success acknowledgment for client-backed close in human mode', async () => {
  const result = await runCliCapture(['close'], async () => ({
    ok: true,
    data: { session: 'default', message: 'Closed: default' },
  }));
  assert.equal(result.code, null);
  assert.match(result.stdout, /Closed: default/);
});

test('cli prints success acknowledgment for daemon-backed mutating commands in human mode', async () => {
  const result = await runCliCapture(['scroll', 'down'], async () => ({
    ok: true,
    data: { direction: 'down', message: 'Scrolled down' },
  }));
  assert.equal(result.code, null);
  assert.match(result.stdout, /Scrolled down/);
});

test('cli forwards bound-session lock policy when session defaults are configured', async () => {
  const result = await runCliCapture(
    ['snapshot', '--device', 'Pixel 9', '--json'],
    async () => ({
      ok: true,
      data: {},
    }),
    { env: { AGENT_DEVICE_SESSION: 'qa-ios', AGENT_DEVICE_PLATFORM: 'ios' } },
  );
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.meta?.lockPolicy, 'reject');
  assert.equal(result.calls[0]?.meta?.lockPlatform, 'ios');
  assert.equal(result.calls[0]?.flags?.platform, 'ios');
  assert.equal(result.calls[0]?.flags?.device, 'Pixel 9');
});

test('cli session lock flag overrides environment for a single invocation', async () => {
  const previousPlatform = process.env.AGENT_DEVICE_PLATFORM;
  const previousLock = process.env.AGENT_DEVICE_SESSION_LOCK;
  process.env.AGENT_DEVICE_PLATFORM = 'ios';
  process.env.AGENT_DEVICE_SESSION_LOCK = 'strip';
  try {
    const result = await runCliCapture(
      ['snapshot', '--session-lock', 'reject', '--device', 'Pixel 9', '--json'],
      async () => ({
        ok: true,
        data: {},
      }),
    );
    assert.equal(result.code, null);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0]?.meta?.lockPolicy, 'reject');
  } finally {
    if (previousPlatform === undefined) delete process.env.AGENT_DEVICE_PLATFORM;
    else process.env.AGENT_DEVICE_PLATFORM = previousPlatform;
    if (previousLock === undefined) delete process.env.AGENT_DEVICE_SESSION_LOCK;
    else process.env.AGENT_DEVICE_SESSION_LOCK = previousLock;
  }
});
