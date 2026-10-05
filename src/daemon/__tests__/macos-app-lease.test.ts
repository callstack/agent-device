import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { makeIosSession, makeMacOsSession } from '../../__tests__/test-utils/session-factories.ts';
import {
  assertMacOsAppLeaseAdmitsRequest,
  assertMacOsAppLeaseProcess,
  parseMacOsAppLeaseKey,
} from '../macos-app-lease.ts';
import type { DaemonRequest } from '../daemon-request.ts';

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
  return { command, positionals, flags: flags as DaemonRequest['flags'], ...extra };
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
