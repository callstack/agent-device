import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildRequestFinishedEvent } from '../session-event-log.ts';
import type { DaemonRequest, DaemonResponseData } from '../types.ts';

function buildSuccessEvent(
  command: string,
  data: DaemonResponseData,
  overrides: Partial<DaemonRequest> = {},
) {
  return buildRequestFinishedEvent({
    req: {
      token: 'test-token',
      session: 'test-session',
      command,
      positionals: [],
      ...overrides,
    },
    response: { ok: true, data },
    durationMs: 123,
  });
}

test('device inventory events include a bounded preview without device identifiers', () => {
  const devices = Array.from({ length: 7 }, (_, index) => ({
    name: `Device ${index + 1}`,
    id: `sensitive-device-id-${index + 1}`,
    platform: index % 2 === 0 ? 'ios' : 'android',
    kind: index % 2 === 0 ? 'simulator' : 'emulator',
    target: 'mobile',
    booted: index < 2,
  }));

  const event = buildSuccessEvent('devices', { devices });

  assert.equal(
    event.summary,
    'Found 7 devices: Device 1 (ios, simulator, mobile, booted), Device 2 (android, emulator, mobile, booted), Device 3 (ios, simulator, mobile, stopped), +4 more',
  );
  assert.equal(event.details?.durationMs, 123);
  assert.equal(event.details?.deviceCount, 7);
  assert.equal(event.details?.omittedDeviceCount, 2);
  assert.ok(Array.isArray(event.details?.devices));
  assert.equal(event.details.devices.length, 5);
  assert.equal(JSON.stringify(event).includes('sensitive-device-id'), false);
});

test('app inventory events include the filter and a bounded preview', () => {
  const event = buildSuccessEvent(
    'apps',
    {
      apps: [
        'Expo Go (host.exp.Exponent)',
        'Example (com.example.one)',
        'Second (com.example.two)',
        'Third (com.example.three)',
        'Fourth (com.example.four)',
        'Fifth (com.example.five)',
      ],
    },
    { flags: { appsFilter: 'all' } },
  );

  assert.equal(
    event.summary,
    'Found 6 apps: Expo Go (host.exp.Exponent), Example (com.example.one), Second (com.example.two), +3 more',
  );
  assert.deepEqual(event.details, {
    durationMs: 123,
    appCount: 6,
    apps: [
      'Expo Go (host.exp.Exponent)',
      'Example (com.example.one)',
      'Second (com.example.two)',
      'Third (com.example.three)',
      'Fourth (com.example.four)',
    ],
    omittedAppCount: 1,
    filter: 'all',
  });
});

test('boot and shutdown events preserve safe device traits', () => {
  const boot = buildSuccessEvent('boot', {
    device: 'iPhone 17 Pro',
    id: 'sensitive-udid',
    platform: 'ios',
    appleOs: 'ios',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  });
  const shutdown = buildSuccessEvent('shutdown', {
    device: 'Pixel 10',
    id: 'sensitive-serial',
    platform: 'android',
    kind: 'emulator',
    target: 'mobile',
    shutdown: { success: true, stdout: 'private output' },
  });

  assert.equal(boot.summary, 'Booted iPhone 17 Pro (ios, simulator, mobile)');
  assert.equal(shutdown.summary, 'Shut down Pixel 10 (android, emulator, mobile)');
  assert.deepEqual(boot.details, {
    durationMs: 123,
    device: 'iPhone 17 Pro',
    platform: 'ios',
    appleOs: 'ios',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  });
  assert.equal(JSON.stringify([boot, shutdown]).includes('sensitive-'), false);
  assert.equal(JSON.stringify(shutdown).includes('private output'), false);
});

test('install events expose the iOS bundle id or Android package name without the binary path', () => {
  const ios = buildSuccessEvent('install', {
    app: '/tmp/Example.app',
    appPath: '/private/tmp/uploaded/Example.app',
    appName: 'Example',
    bundleId: 'com.example.ios',
    platform: 'ios',
    launchTarget: 'com.example.ios',
  });
  const android = buildSuccessEvent('reinstall', {
    app: '/tmp/example.apk',
    appPath: '/private/tmp/uploaded/example.apk',
    appName: 'Example',
    packageName: 'com.example.android',
    platform: 'android',
  });

  assert.equal(ios.summary, 'Installed Example (com.example.ios)');
  assert.equal(android.summary, 'Reinstalled Example (com.example.android)');
  assert.equal(ios.details?.bundleId, 'com.example.ios');
  assert.equal(android.details?.packageName, 'com.example.android');
  assert.equal(JSON.stringify([ios, android]).includes('/private/tmp'), false);
});

test('screenshot events preserve only the requested client filename', () => {
  const event = buildSuccessEvent(
    'screenshot',
    { path: '/tmp/agent-device-screenshot-random.png' },
    {
      meta: {
        clientArtifactPaths: {
          path: 'C:\\workspace\\artifacts\\requested-shot.png',
        },
      },
    },
  );

  assert.deepEqual(event.details, {
    durationMs: 123,
    requestedFileName: 'requested-shot.png',
  });
  assert.equal(JSON.stringify(event).includes('C:\\workspace'), false);
});

test('unknown commands keep the existing generic completion event', () => {
  const event = buildSuccessEvent('future-command', { arbitrary: 'not projected' });

  assert.equal(event.summary, 'Finished future-command');
  assert.deepEqual(event.details, { durationMs: 123 });
});
