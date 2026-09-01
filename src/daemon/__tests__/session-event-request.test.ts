import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildRequestFinishedEvent, buildRequestStartedEvent } from '../session-event-log.ts';
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

test('device inventory events replace identifier-derived names across discovery shapes', () => {
  const event = buildSuccessEvent('devices', {
    devices: [
      {
        serial: 'ANDROID-SERIAL-123',
        name: 'ANDROID-SERIAL-123',
        platform: 'android',
        kind: 'device',
        target: 'mobile',
        booted: true,
      },
      {
        device_udid: 'APPLE-UDID-123',
        name: 'APPLE-UDID-123',
        platform: 'ios',
        appleOs: 'ios',
        kind: 'device',
        target: 'mobile',
        booted: false,
      },
      {
        deviceId: 'provider-device-123',
        deviceName: 'PROVIDER-DEVICE-123',
        platform: 'android',
        kind: 'emulator',
        target: 'mobile',
        booted: false,
      },
    ],
  });

  assert.equal(
    event.summary,
    'Found 3 devices: Android device (android, device, mobile, booted), iOS device (ios, device, mobile, stopped), Android emulator (android, emulator, mobile, stopped)',
  );
  assert.deepEqual(event.details?.devices, [
    {
      name: 'Android device',
      platform: 'android',
      kind: 'device',
      target: 'mobile',
      booted: true,
    },
    {
      name: 'iOS device',
      platform: 'ios',
      appleOs: 'ios',
      kind: 'device',
      target: 'mobile',
      booted: false,
    },
    {
      name: 'Android emulator',
      platform: 'android',
      kind: 'emulator',
      target: 'mobile',
      booted: false,
    },
  ]);
  assert.equal(JSON.stringify(event).includes('ANDROID-SERIAL-123'), false);
  assert.equal(JSON.stringify(event).includes('APPLE-UDID-123'), false);
  assert.equal(JSON.stringify(event).toLowerCase().includes('provider-device-123'), false);
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

test('boot and shutdown events replace identifier-derived device names', () => {
  const boot = buildSuccessEvent('boot', {
    device: 'ANDROID-SERIAL-123',
    id: 'ANDROID-SERIAL-123',
    serial: 'ANDROID-SERIAL-123',
    platform: 'android',
    kind: 'device',
    target: 'mobile',
    booted: true,
  });
  const shutdown = buildSuccessEvent('shutdown', {
    device: 'APPLE-UDID-123',
    id: 'APPLE-UDID-123',
    udid: 'APPLE-UDID-123',
    platform: 'ios',
    appleOs: 'ios',
    kind: 'device',
    target: 'mobile',
  });

  assert.equal(boot.summary, 'Booted Android device (android, device, mobile)');
  assert.equal(shutdown.summary, 'Shut down iOS device (ios, device, mobile)');
  assert.equal(boot.details?.device, 'Android device');
  assert.equal(shutdown.details?.device, 'iOS device');
  assert.equal(JSON.stringify([boot, shutdown]).includes('ANDROID-SERIAL-123'), false);
  assert.equal(JSON.stringify([boot, shutdown]).includes('APPLE-UDID-123'), false);
});

test('anonymous device labels ignore inherited platform properties', () => {
  const event = buildSuccessEvent('devices', {
    devices: [
      {
        name: 'provider-device-id',
        id: 'provider-device-id',
        platform: 'constructor',
        kind: 'device',
        booted: false,
      },
    ],
  });

  assert.ok(Array.isArray(event.details?.devices));
  assert.equal(event.details.devices[0]?.name, 'Unnamed device');
  assert.equal(event.summary?.includes('function Object'), false);
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
  assert.equal(JSON.stringify(event).includes(String.raw`C:\workspace`), false);
});

test('screenshot filenames are bounded for durable event rendering', () => {
  const requestedFileName = `${'customer-'.repeat(30)}shot.png`;
  const event = buildSuccessEvent(
    'screenshot',
    { path: '/tmp/agent-device-screenshot-random.png' },
    {
      meta: {
        clientArtifactPaths: {
          path: `/private/customer/${requestedFileName}`,
        },
      },
    },
  );
  const fileName = event.details?.requestedFileName;

  assert.equal(typeof fileName, 'string');
  assert.equal(Array.from(fileName as string).length, 120);
  assert.equal((fileName as string).endsWith('…'), true);
  assert.equal(JSON.stringify(event).includes('/private/customer'), false);
});

test('request lifecycle events omit internal diagnostic paths', () => {
  const started = buildRequestStartedEvent({
    req: {
      token: 'test-token',
      session: 'public-session',
      command: 'snapshot',
      positionals: [],
      meta: {
        tenantId: 'tenant-a',
        sessionIsolation: 'tenant',
      },
    },
  });
  const failed = buildRequestFinishedEvent({
    req: {
      token: 'test-token',
      session: 'public-session',
      command: 'snapshot',
      positionals: [],
    },
    response: {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'private failure message',
        logPath: '/private/customer/request.log',
      },
    },
    durationMs: 12,
  });

  assert.equal(started.details, undefined);
  assert.deepEqual(failed.details, {
    durationMs: 12,
    code: 'COMMAND_FAILED',
    diagnosticId: undefined,
  });
  assert.equal(JSON.stringify([started, failed]).includes('/private/customer'), false);
  assert.equal(JSON.stringify([started, failed]).includes('private failure message'), false);
});

test('unknown commands keep the existing generic completion event', () => {
  const event = buildSuccessEvent('future-command', { arbitrary: 'not projected' });

  assert.equal(event.summary, 'Finished future-command');
  assert.deepEqual(event.details, { durationMs: 123 });
});
