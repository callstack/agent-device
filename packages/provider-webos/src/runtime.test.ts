import assert from 'node:assert/strict';
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { afterEach, test } from 'vitest';

import { createWebosRuntime } from './runtime.ts';

const APP_ID = 'com.example.app';
const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  writeFileSync(CALLS, '');
});

function lease(leaseId: string) {
  return {
    leaseId,
    tenantId: 'tenant',
    runId: 'run',
    backend: 'android-instance' as const,
    leaseProvider: 'webos',
    createdAt: 0,
    heartbeatAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

// Two registered TVs, bedroom the ares default, and lounge a second entry for the living-room TV. Every ares call is recorded, and ares-inspect fails
// so open stops right after the launch. One script answers for every ares CLI through symlinks,
// because macOS checks each new executable on its first run.
const ARES_BIN = mkdtempForTestSync('ares-');
const CALLS = path.join(ARES_BIN, 'calls.log');
const TVS = [
  {
    profile: 'tv',
    name: 'living-room',
    default: false,
    deviceinfo: { ip: '192.0.2.10', port: '9922' },
  },
  { profile: 'tv', name: 'bedroom', default: true, deviceinfo: { ip: '192.0.2.11', port: '9922' } },
  { profile: 'tv', name: 'lounge', default: false, deviceinfo: { ip: '192.0.2.10', port: '9922' } },
];
writeFileSync(
  path.join(ARES_BIN, 'ares'),
  `#!/bin/sh
name=\${0##*/}
echo "$name $*" >> ${CALLS}
case "$name" in
  ares-setup-device) echo '${JSON.stringify(TVS)}' ;;
  ares-inspect) echo 'ERR! no inspector'; exit 1 ;;
esac
`,
);
chmodSync(path.join(ARES_BIN, 'ares'), 0o755);
for (const name of ['ares-setup-device', 'ares-launch', 'ares-inspect']) {
  symlinkSync('ares', path.join(ARES_BIN, name));
}

const recordedCalls = () =>
  readFileSync(CALLS, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => !line.startsWith('ares-setup-device'));

async function webosRuntime(options: { device?: string } = {}) {
  const { runtime } = await createWebosRuntime(
    { aresBin: ARES_BIN, ...options },
    {
      env: process.env,
      createError: (code, message, details) => new AppError(code, message, details),
    },
  );
  shutdowns.push(runtime.shutdown);
  return runtime;
}

test('connect leases the ares default TV when neither the flag nor the options name one', async () => {
  const runtime = await webosRuntime();

  const allocated = await runtime.leaseLifecycle.allocate(lease('lease-a'));

  assert.equal(allocated?.device.id, 'webos:192.0.2.11:9922');
});

test('connect leases the TV the --device flag names over the plugin default', async () => {
  const runtime = await webosRuntime({ device: 'bedroom' });

  const allocated = await runtime.leaseLifecycle.allocate(lease('lease-a'), {
    flags: { device: 'living-room' },
  });

  assert.equal(allocated?.device.id, 'webos:192.0.2.10:9922');
  assert.equal(allocated?.device.name, 'living-room');
});

test('a second ares entry for the held TV is refused with DEVICE_IN_USE', async () => {
  const runtime = await webosRuntime();
  await runtime.leaseLifecycle.allocate(lease('lease-a'), { flags: { device: 'living-room' } });

  const second = runtime.leaseLifecycle.allocate(lease('lease-b'), { flags: { device: 'lounge' } });

  await assert.rejects(
    second,
    (error: unknown) => error instanceof AppError && error.code === 'DEVICE_IN_USE',
  );
});

test('connect to a TV ares does not know fails as DEVICE_NOT_FOUND and lists the known TVs', async () => {
  const runtime = await webosRuntime({ device: 'attic' });

  await assert.rejects(
    runtime.leaseLifecycle.allocate(lease('lease-a')),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'DEVICE_NOT_FOUND' &&
      error.message === 'No webOS TV named attic in ares-setup-device' &&
      JSON.stringify(error.details?.available) ===
        JSON.stringify(['living-room', 'bedroom', 'lounge']),
  );
});

test('open --relaunch closes the app, launches it, then opens the inspector on the leased TV', async () => {
  const runtime = await webosRuntime();
  const allocated = await runtime.leaseLifecycle.allocate(lease('lease-a'));
  assert.ok(allocated);

  await assert.rejects(
    runtime.getInteractor(allocated.device)!.open(APP_ID, { terminateRunningApp: true }),
    /ares-inspect exited: ERR! no inspector/,
  );

  assert.deepEqual(recordedCalls(), [
    `ares-launch -d bedroom --close ${APP_ID}`,
    `ares-launch -d bedroom ${APP_ID}`,
    `ares-inspect -d bedroom -a ${APP_ID}`,
  ]);
});

test('close stops the app with ares-launch --close', async () => {
  const runtime = await webosRuntime();
  const allocated = await runtime.leaseLifecycle.allocate(lease('lease-a'));
  assert.ok(allocated);

  await runtime.getInteractor(allocated.device)!.close!(APP_ID);

  assert.deepEqual(recordedCalls(), [`ares-launch -d bedroom --close ${APP_ID}`]);
});
