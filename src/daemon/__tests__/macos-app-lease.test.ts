import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { makeIosSession, makeMacOsSession } from '../../__tests__/test-utils/session-factories.ts';
import {
  assertMacOsAppLeaseAdmitsRequest,
  assertMacOsAppLeaseProcess,
  parseMacOsAppLeaseKey,
  redactMacOsAppLeaseResponse,
} from '../macos-app-lease.ts';
import { buildOpenResult } from '../session-lifecycle/internal/session-open-surface.ts';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';

const lease: Pick<DeviceLease, 'backend' | 'deviceKey'> = {
  backend: 'macos-app',
  deviceKey: 'com.example.app@4242',
};
const leasedSession = makeMacOsSession('leased', { appBundleId: 'com.example.app' });

function request(
  command: string,
  positionals: string[] = [],
  flags: Record<string, unknown> = {},
  extra: Pick<DaemonRequest, 'input' | 'runtime'> = {},
): Pick<DaemonRequest, 'command' | 'positionals' | 'flags' | 'input' | 'runtime'> {
  return {
    command,
    positionals,
    flags: { platform: 'macos', ...flags } as DaemonRequest['flags'],
    ...extra,
  };
}

function assertDenied(run: () => unknown, rule: string): void {
  assert.throws(run, (error: { code?: string; details?: Record<string, unknown> }) => {
    assert.equal(error.code, 'UNAUTHORIZED');
    assert.equal(error.details?.reason, 'MACOS_APP_LEASE_DENIED');
    assert.equal(error.details?.rule, rule);
    assert.equal(error.details?.retriable, false);
    return true;
  });
}

beforeEach(() => {
  vi.stubEnv('AGENT_DEVICE_MACOS_APP_BACKEND', 'native');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('the device key names one bundle, optionally one process', () => {
  assert.deepEqual(parseMacOsAppLeaseKey('com.example.app'), { bundleId: 'com.example.app' });
  assert.deepEqual(parseMacOsAppLeaseKey('com.example.app@4242'), {
    bundleId: 'com.example.app',
    pid: 4242,
  });
  for (const key of ['', 'example', 'com.example.app@', 'com.example.app@0', 'com.example app']) {
    assert.throws(() => parseMacOsAppLeaseKey(key), { code: 'INVALID_ARGS' });
  }
});

test('the leased app can be opened, driven, captured and closed', () => {
  assertMacOsAppLeaseAdmitsRequest(
    lease,
    request('open', ['com.example.app'], { platform: 'macos' }),
  );
  for (const command of ['snapshot', 'click', 'fill', 'type', 'press', 'scroll', 'screenshot']) {
    assertMacOsAppLeaseAdmitsRequest(lease, request(command), leasedSession);
  }
  assertMacOsAppLeaseAdmitsRequest(lease, request('close', ['com.example.app']), leasedSession);
});

test('a lease of another backend is not confined', () => {
  assertMacOsAppLeaseAdmitsRequest(
    { backend: 'ios-instance', deviceKey: 'ios:mobile:UDID' },
    request('install', ['/tmp/App.app']),
  );
});

test('commands outside the allow list are refused, including ones added later', () => {
  for (const command of ['install', 'install_source', 'apps', 'alert', 'clipboard', 'settings']) {
    assertDenied(
      () => assertMacOsAppLeaseAdmitsRequest(lease, request(command), leasedSession),
      'command',
    );
  }
  assertDenied(
    () => assertMacOsAppLeaseAdmitsRequest(lease, request('not-a-command-yet')),
    'command',
  );
});

test('open accepts only the leased bundle and nothing it could launch beside it', () => {
  assertDenied(
    () => assertMacOsAppLeaseAdmitsRequest(lease, request('open', ['com.apple.finder'])),
    'app',
  );
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('open', ['com.example.app', 'https://example.com']),
      ),
    'app',
  );
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('open', ['com.example.app'], { platform: 'ios' }),
      ),
    'app',
  );
});

test('nothing under the lease names a host path or launches beside the app', () => {
  const temp = '/tmp/agent-device-screenshot-1791219384278-ab12cd.png';
  assertMacOsAppLeaseAdmitsRequest(lease, request('screenshot', [temp]), leasedSession);
  assertMacOsAppLeaseAdmitsRequest(lease, request('screenshot', [], { out: temp }), leasedSession);
  for (const target of [['/Users/me/.zshrc'], ['/tmp/agent-device-screenshot-1-a.png/../x']]) {
    assertDenied(
      () => assertMacOsAppLeaseAdmitsRequest(lease, request('screenshot', target), leasedSession),
      'host-path',
    );
  }
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('screenshot', [], { out: '/Users/me/x.png' }),
        leasedSession,
      ),
    'host-path',
  );
  for (const flags of [
    { launchUrl: 'other://open' },
    { launchConsole: '/Users/me/log' },
    { saveScript: '/Users/me/x.ad' },
  ]) {
    assertDenied(
      () => assertMacOsAppLeaseAdmitsRequest(lease, request('open', ['com.example.app'], flags)),
      'host-path',
    );
  }
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('open', ['com.example.app'], {}, { runtime: { launchUrl: 'other://open' } }),
      ),
    'host-path',
  );
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('close', [], {}, { input: { saveScript: '/Users/me/x.ad' } }),
        leasedSession,
      ),
    'host-path',
  );
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('batch', [], {
          batchSteps: [{ command: 'screenshot', positionals: ['/Users/me/x.png'], input: {} }],
        }),
        leasedSession,
      ),
    'host-path',
  );
});

test('close cannot name another app', () => {
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('close', ['com.apple.finder']),
        leasedSession,
      ),
    'app',
  );
});

test.each(['desktop', 'frontmost-app', 'menubar'])('the %s surface is refused', (surface) => {
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(lease, request('open', ['com.example.app'], { surface })),
    'surface',
  );
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(lease, request('snapshot', [], { surface }), leasedSession),
    'surface',
  );
});

test('screenshots stay on the app window', () => {
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('screenshot', [], { screenshotFullscreen: true }),
        leasedSession,
      ),
    'capture',
  );
});

test('a session that is not the leased app is refused', () => {
  for (const session of [
    makeMacOsSession('other', { appBundleId: 'com.apple.finder' }),
    makeMacOsSession('desktop', { appBundleId: 'com.example.app', surface: 'desktop' }),
    makeIosSession('ios', { appBundleId: 'com.example.app' }),
  ]) {
    assertDenied(
      () => assertMacOsAppLeaseAdmitsRequest(lease, request('snapshot'), session),
      'app',
    );
  }
});

test('a batch is refused whole when any step is not allowed', () => {
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('batch', [], {
          batchSteps: [
            { command: 'snapshot', input: {} },
            { command: 'open', positionals: ['com.apple.finder'], input: {} },
          ],
        }),
        leasedSession,
      ),
    'app',
  );
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('batch', [], {
          batchSteps: [{ command: 'snapshot', input: {}, flags: { surface: 'desktop' } }],
        }),
        leasedSession,
      ),
    'surface',
  );
});

test('no device selector reaches a host device, and open and batch must name platform macos', () => {
  for (const selector of [
    { udid: 'ABCD-1234' },
    { serial: 'emulator-5554' },
    { device: 'iPhone 17' },
    { target: 'mobile' },
    { iosSimulatorDeviceSet: '/tmp/set' },
    { androidDeviceAllowlist: 'emulator-5554' },
  ]) {
    assertDenied(
      () => assertMacOsAppLeaseAdmitsRequest(lease, request('open', ['com.example.app'], selector)),
      'device',
    );
    assertDenied(
      () =>
        assertMacOsAppLeaseAdmitsRequest(lease, request('snapshot', [], selector), leasedSession),
      'device',
    );
    assertDenied(
      () =>
        assertMacOsAppLeaseAdmitsRequest(
          lease,
          request('batch', [], {
            batchSteps: [{ command: 'snapshot', input: {}, flags: selector }],
          }),
          leasedSession,
        ),
      'device',
    );
  }
  for (const command of ['open', 'batch']) {
    assertDenied(
      () =>
        assertMacOsAppLeaseAdmitsRequest(lease, {
          command,
          positionals: command === 'open' ? ['com.example.app'] : [],
          flags: {},
        }),
      'device',
    );
  }
});

test('a batch is refused whole when a later step carries a launch URL in its runtime', () => {
  assertDenied(
    () =>
      assertMacOsAppLeaseAdmitsRequest(
        lease,
        request('batch', [], {
          batchSteps: [
            { command: 'snapshot', input: {} },
            { command: 'open', positionals: ['com.example.app'], runtime: { launchUrl: 'x://y' } },
          ],
        }),
        leasedSession,
      ),
    'host-path',
  );
});

test('open needs the native app backend, which resolves every action inside the app', () => {
  vi.stubEnv('AGENT_DEVICE_MACOS_APP_BACKEND', 'xctest');
  assertDenied(
    () => assertMacOsAppLeaseAdmitsRequest(lease, request('open', ['com.example.app'])),
    'backend',
  );
});

test('a pid-pinned lease is usable only while that process runs the leased bundle', async () => {
  const running = new Map([[4242, 'com.example.app']]);
  const read = async (pid: number) => running.get(pid);
  await assertMacOsAppLeaseProcess(lease, read);
  running.set(4242, 'com.example.other');
  const deniedProcess = (error: { code?: string; details?: Record<string, unknown> }) =>
    error.code === 'UNAUTHORIZED' &&
    error.details?.reason === 'MACOS_APP_LEASE_DENIED' &&
    error.details.rule === 'process';
  await assert.rejects(assertMacOsAppLeaseProcess(lease, read), deniedProcess);
  running.delete(4242);
  await assert.rejects(assertMacOsAppLeaseProcess(lease, read), deniedProcess);
});

test('a bundle-only lease follows whichever process of the bundle runs', async () => {
  await assertMacOsAppLeaseProcess(
    { backend: 'macos-app', deviceKey: 'com.example.app' },
    async () => {
      throw new Error('a bundle-only key reads no process');
    },
  );
});

const host = { hostName: 'janics-mac-mini', homeDirectory: '/Users/janic' };

test('open under the lease keeps the session and app and drops the host paths and device', () => {
  const stateDir = '/Users/janic/.agent-device/sessions/tenant-a_default';
  const open: DaemonResponse = {
    ok: true,
    data: buildOpenResult({
      sessionName: 'tenant-a:default',
      sessionStateDir: stateDir,
      runnerLogPath: `${stateDir}/runner.log`,
      requestLogPath: `${stateDir}/requests/r1.ndjson`,
      eventLogPath: `${stateDir}/events.ndjson`,
      appName: 'Leased',
      appBundleId: 'com.example.app',
      surface: 'app',
      device: {
        platform: 'apple',
        appleOs: 'macos',
        id: 'host-macos-local',
        name: host.hostName,
        kind: 'device',
        target: 'desktop',
        booted: true,
      },
      runtimeHintCount: () => 0,
      sessionReused: false,
    }),
  };

  const redacted = redactMacOsAppLeaseResponse('open', open, host);

  assert.deepEqual(redacted, {
    ok: true,
    data: {
      session: 'tenant-a:default',
      surface: 'app',
      sessionReused: false,
      appName: 'Leased',
      appBundleId: 'com.example.app',
      platform: 'macos',
      target: 'desktop',
      message: 'Opened: Leased',
    },
  });
});

test('success data of the other leased commands is the app content and passes through', () => {
  for (const command of ['snapshot', 'screenshot', 'close', 'click']) {
    const response: DaemonResponse = {
      ok: true,
      data: { path: '/tmp/agent-device-screenshot-1-a.png', message: `${command} janics-mac-mini` },
    };
    assert.deepEqual(redactMacOsAppLeaseResponse(command, response, host), response);
  }
});

test('a sparse snapshot fallback screenshot path stays on the host', () => {
  const redacted = redactMacOsAppLeaseResponse(
    'snapshot',
    {
      ok: true,
      data: {
        nodes: [],
        fallbackScreenshotPath: '/var/folders/zz/T/agent-device-screenshot-x/screenshot.png',
        artifacts: [
          { field: 'fallbackScreenshotPath', artifactId: 'a1', fileName: 'screenshot.png' },
        ],
      },
    },
    host,
  );

  assert.deepEqual(redacted, {
    ok: true,
    data: {
      nodes: [],
      artifacts: [
        { field: 'fallbackScreenshotPath', artifactId: 'a1', fileName: 'screenshot.png' },
      ],
    },
  });
});

test('open --foreground redacts its warnings and the initial snapshot failure it carries', () => {
  const failure = {
    code: 'COMMAND_FAILED',
    message: 'runner died at /Users/janic/Library/Logs/runner.log',
    logPath: '/Users/janic/.agent-device/sessions/s/requests/r.ndjson',
    diagnosticsRecord: { session: 's', requestId: 'r' },
    details: { stderr: 'janics-mac-mini: no display' },
  };

  const redacted = redactMacOsAppLeaseResponse(
    'open',
    {
      ok: true,
      data: {
        appBundleId: 'com.example.app',
        warnings: [`The initial snapshot failed (${failure.message}).`],
        initialSnapshotError: failure,
        snapshot: { nodes: [], fallbackScreenshotPath: '/tmp/x/screenshot.png' },
      },
    },
    host,
  );

  assert.deepEqual(redacted, {
    ok: true,
    data: {
      appBundleId: 'com.example.app',
      warnings: ['The initial snapshot failed (runner died at <host-path>).'],
      initialSnapshotError: {
        code: 'COMMAND_FAILED',
        message: 'runner died at <host-path>',
        details: { stderr: '<host>: no display' },
      },
      snapshot: { nodes: [] },
    },
  });
});

test('host text redaction leaves app content that only looks like a path alone', () => {
  const redacted = redactMacOsAppLeaseResponse(
    'click',
    {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message:
          'no match for label=/Settings/General; ENOENT:/private/var/x/y in /Users/jérôme/dev',
      },
    },
    host,
  );

  assert.deepEqual(redacted, {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'no match for label=/Settings/General; ENOENT:<host-path> in <host-path>',
    },
  });
});

test('a failure under the lease drops its log locators and every host path and the host name', () => {
  const redacted = redactMacOsAppLeaseResponse(
    'click',
    {
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'helper failed in /Users/janic/Library/Caches/helper on janics-mac-mini',
        hint: 'See /private/tmp/agent-device/x.log',
        logPath: '/Users/janic/.agent-device/sessions/s/requests/r.ndjson',
        diagnosticsRecord: { session: 's', requestId: 'r' },
        diagnosticId: 'abc',
        retriable: false,
        details: {
          helperPath: '/Users/janic/Library/Caches/agent-device/helper',
          args: ['press', '--out=/var/folders/zz/T/shot.png'],
          deviceName: 'janics-mac-mini',
          bundleId: 'com.example.app',
          reason: 'unsupported-device-backend',
        },
      },
    },
    host,
  );

  assert.deepEqual(redacted, {
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'helper failed in <host-path> on <host>',
      hint: 'See <host-path>',
      diagnosticId: 'abc',
      retriable: false,
      details: {
        helperPath: '<host-path>',
        args: ['press', '--out=<host-path>'],
        deviceName: '<host>',
        bundleId: 'com.example.app',
        reason: 'unsupported-device-backend',
      },
    },
  });
});
