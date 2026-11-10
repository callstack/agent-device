import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { afterEach, test, vi } from 'vitest';

import { createTizenRuntime } from './runtime.ts';

const APP_ID = 'AbCdE12345.example';

// An sdb whose `devices` lists the serials in SDB_STATE and whose `connect` adds one unless
// SDB_UNREACHABLE is set. Every call is recorded. One script serves every test, because macOS checks each new executable on its first run.
const SDB = path.join(mkdtempForTestSync('sdb-'), 'sdb');
writeFileSync(
  SDB,
  `#!/bin/sh
echo "$*" >> "$SDB_CALLS"
case "$1" in
  devices) echo 'List of devices attached'; while read -r serial; do printf '%s\\tdevice\\tQE55Q80\\n' "$serial"; done < "$SDB_STATE" ;;
  connect)
    if [ -n "$SDB_UNREACHABLE" ]; then echo "failed to connect to $2"; exit 0; fi
    echo "$2" >> "$SDB_STATE"; echo "connected to $2" ;;
esac
`,
);
chmodSync(SDB, 0o755);

const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
});

async function tizenRuntime(connected: readonly string[], env: Record<string, string> = {}) {
  const dir = mkdtempForTestSync('sdb-state-');
  const state = path.join(dir, 'connected');
  const log = path.join(dir, 'calls');
  writeFileSync(state, connected.map((serial) => `${serial}\n`).join(''));
  writeFileSync(log, '');
  const { runtime } = await createTizenRuntime(
    { sdbPath: SDB },
    {
      env: { ...process.env, SDB_STATE: state, SDB_CALLS: log, ...env },
      createError: (code, message, details) => new AppError(code, message, details),
    },
  );
  shutdowns.push(runtime.shutdown);
  return { runtime, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}

const lease = (leaseId: string) => ({
  leaseId,
  tenantId: 'tenant',
  runId: 'run',
  backend: 'android-instance' as const,
  leaseProvider: 'tizen',
  createdAt: 0,
  heartbeatAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

test('a TV named by IP is connected over sdb, keeps that name and is identified by its serial', async () => {
  const { runtime, calls } = await tizenRuntime([]);

  const allocated = await runtime.leaseLifecycle.allocate(lease('one'), {
    flags: { device: '192.0.2.10' },
  });

  assert.deepEqual(calls(), ['devices', 'connect 192.0.2.10:26101', 'devices']);
  assert.equal(allocated?.device.name, '192.0.2.10');
  assert.equal(allocated?.device.id, 'tizen:192.0.2.10:26101');
  assert.equal(allocated?.device.platform, 'android');
  assert.equal(allocated?.device.target, 'tv');
});

test('a second lease naming the held TV by IP:port instead of IP is refused with DEVICE_IN_USE', async () => {
  const { runtime } = await tizenRuntime([]);
  await runtime.leaseLifecycle.allocate(lease('one'), { flags: { device: '192.0.2.10' } });

  const second = runtime.leaseLifecycle.allocate(lease('two'), {
    flags: { device: '192.0.2.10:26101' },
  });

  await assert.rejects(second, (error: AppError) => {
    assert.equal(error.code, 'DEVICE_IN_USE');
    return true;
  });
});

test('without --device, the only connected TV is used and no connect runs', async () => {
  const { runtime, calls } = await tizenRuntime(['192.0.2.10:26101']);

  const allocated = await runtime.leaseLifecycle.allocate(lease('one'));

  assert.equal(allocated?.device.id, 'tizen:192.0.2.10:26101');
  assert.deepEqual(calls(), ['devices']);
});

test('without --device and with two TVs connected, allocation asks for one', async () => {
  const { runtime } = await tizenRuntime(['192.0.2.10:26101', '192.0.2.11:26101']);

  const allocation = runtime.leaseLifecycle.allocate(lease('one'));

  await assert.rejects(allocation, (error: AppError) => {
    assert.equal(error.code, 'DEVICE_NOT_FOUND');
    assert.deepEqual(error.details?.available, ['192.0.2.10:26101', '192.0.2.11:26101']);
    return true;
  });
});

test('a TV that sdb cannot connect to fails as DEVICE_NOT_FOUND', async () => {
  const { runtime } = await tizenRuntime([], { SDB_UNREACHABLE: '1' });

  const allocation = runtime.leaseLifecycle.allocate(lease('one'), {
    flags: { device: '192.0.2.10' },
  });

  await assert.rejects(allocation, (error: AppError) => {
    assert.equal(error.code, 'DEVICE_NOT_FOUND');
    assert.equal(error.message, 'sdb could not connect to the Tizen TV 192.0.2.10:26101');
    return true;
  });
});

test('Ctrl-C while open waits for the killed app stops before the debug launch', async () => {
  const { runtime, calls } = await tizenRuntime(['192.0.2.10:26101']);
  const allocated = await runtime.leaseLifecycle.allocate(lease('one'));
  assert.ok(allocated);
  const cancel = new AbortController();

  const opening = runtime.getInteractor(allocated.device, cancel.signal)!.open(APP_ID);
  await vi.waitFor(() =>
    assert.equal(calls().at(-1), `-s 192.0.2.10:26101 shell 0 was_kill ${APP_ID}`),
  );
  cancel.abort();

  await assert.rejects(opening, isRequestCanceledError);
  assert.equal(calls().at(-1), `-s 192.0.2.10:26101 shell 0 was_kill ${APP_ID}`);
});

test('close kills the app on the leased TV', async () => {
  const { runtime, calls } = await tizenRuntime(['192.0.2.10:26101']);
  const allocated = await runtime.leaseLifecycle.allocate(lease('one'));
  assert.ok(allocated);

  await runtime.getInteractor(allocated.device)!.close!(APP_ID);

  assert.equal(calls().at(-1), `-s 192.0.2.10:26101 shell 0 was_kill ${APP_ID}`);
});
