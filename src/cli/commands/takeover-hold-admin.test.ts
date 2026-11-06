import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  putHostHumanControlHold,
  removeHostHumanControlHold,
  resolveHostHoldAdmin,
  type HostHoldAdminRequester,
} from './takeover-hold-admin.ts';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { TAKEOVER_CLI_FLAGS } from './test-utils/client-lease-fixtures.ts';
import type { CliFlags } from '@agent-device/contracts/command';

function flagsWith(flags: Partial<CliFlags>): CliFlags {
  return { ...TAKEOVER_CLI_FLAGS, ...flags };
}

type RecordedRequest = { options: Record<string, unknown>; body?: string };

type StubResponse = { status: number; body: unknown };

function stubRequester(response: StubResponse): {
  requester: HostHoldAdminRequester;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const requester = {
    request: (options: unknown, callback: (res: unknown) => void) => {
      const req = {
        on: () => req,
        setTimeout: () => req,
        end: (payload?: string) => {
          calls.push({ options: options as Record<string, unknown>, body: payload });
          queueMicrotask(() =>
            callback({
              statusCode: response.status,
              setEncoding: () => undefined,
              on: (event: string, handler: (chunk?: string) => void) => {
                if (event === 'data') handler(JSON.stringify(response.body));
                if (event === 'end') handler();
              },
            }),
          );
        },
      };
      return req;
    },
  };
  return { requester: requester as unknown as HostHoldAdminRequester, calls };
}

function writeDaemonRecord(stateDir: string, record: Record<string, unknown>): string {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify(record));
  return stateDir;
}

test('resolveHostHoldAdmin uses the explicit base URL and token', async () => {
  const connection = await resolveHostHoldAdmin(
    flagsWith({ daemonBaseUrl: 'http://127.0.0.1:4310/', daemonAuthToken: ' host-token ' }),
    createTestHostEnvironment(),
  );
  assert.deepEqual(connection, { baseUrl: 'http://127.0.0.1:4310', token: 'host-token' });
});

test('resolveHostHoldAdmin reads the local record loopback HTTP listener', async () => {
  const stateDir = writeDaemonRecord(mkdtempForTestSync('ad-hold-'), {
    port: 1,
    httpPort: 4321,
    transport: 'dual',
    token: 'record-token',
    pid: process.pid,
  });
  const connection = await resolveHostHoldAdmin(
    flagsWith({ stateDir }),
    createTestHostEnvironment(),
  );
  assert.deepEqual(connection, { baseUrl: 'http://127.0.0.1:4321', token: 'record-token' });
});

test('resolveHostHoldAdmin refuses a state dir with no daemon', async () => {
  const stateDir = mkdtempForTestSync('ad-hold-');
  await assert.rejects(
    resolveHostHoldAdmin(flagsWith({ stateDir }), createTestHostEnvironment()),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.equal(
        (error as { details?: { reason?: string } }).details?.reason,
        'daemon-not-running',
      );
      return true;
    },
  );
});

test('resolveHostHoldAdmin refuses a daemon without an HTTP listener', async () => {
  const stateDir = writeDaemonRecord(mkdtempForTestSync('ad-hold-'), {
    port: 1,
    transport: 'socket',
    token: 'record-token',
    pid: process.pid,
  });
  await assert.rejects(
    resolveHostHoldAdmin(flagsWith({ stateDir }), createTestHostEnvironment()),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'UNSUPPORTED_OPERATION');
      assert.equal(
        (error as { details?: { reason?: string } }).details?.reason,
        'daemon-http-listener-missing',
      );
      return true;
    },
  );
});

test('resolveHostHoldAdmin refuses a non-http base URL', async () => {
  await assert.rejects(
    resolveHostHoldAdmin(
      flagsWith({ daemonBaseUrl: 'ftp://127.0.0.1:4310' }),
      createTestHostEnvironment(),
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
      assert.equal(
        (error as { details?: { reason?: string } }).details?.reason,
        'daemon-base-url-invalid',
      );
      return true;
    },
  );
});

test('putHostHumanControlHold PUTs the scope and input under the hold id', async () => {
  const { requester, calls } = stubRequester({
    status: 200,
    body: {
      ok: true,
      hold: {
        id: 'takeover-1',
        scope: { backend: 'android-instance', deviceKey: 'android:mobile:serial-1' },
        state: 'active',
        reason: 'flashing',
        createdAt: 1_000,
        updatedAt: 1_000,
        expiresAt: 61_000,
      },
    },
  });
  const hold = await putHostHumanControlHold({
    connection: { baseUrl: 'http://127.0.0.1:4310', token: 'host-token' },
    holdId: 'takeover-1',
    scope: { backend: 'android-instance', deviceKey: 'android:mobile:serial-1' },
    input: { reason: 'flashing', ttlMs: 60000 },
    requester,
  });
  assert.equal(hold.id, 'takeover-1');
  assert.equal(hold.scope.deviceKey, 'android:mobile:serial-1');
  assert.equal(hold.expiresAt, 61_000);
  assert.equal(calls.length, 1);
  const { options, body } = calls[0]!;
  assert.equal(options.method, 'PUT');
  assert.equal(options.path, '/admin/human-control/holds/takeover-1');
  assert.equal(options.host, '127.0.0.1');
  const headers = options.headers as Record<string, string>;
  assert.deepEqual(headers['x-agent-device-token'], 'host-token');
  assert.deepEqual(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(body!), {
    scope: { backend: 'android-instance', deviceKey: 'android:mobile:serial-1' },
    reason: 'flashing',
    ttlMs: 60000,
  });
});

test('removeHostHumanControlHold reports whether the daemon released the hold', async () => {
  const released = stubRequester({ status: 200, body: { ok: true, released: true } });
  assert.equal(
    await removeHostHumanControlHold({
      connection: { baseUrl: 'http://127.0.0.1:4310', token: 'host-token' },
      holdId: 'takeover-1',
      requester: released.requester,
    }),
    true,
  );
  assert.equal(released.calls[0]!.options.method, 'DELETE');
  assert.equal(released.calls[0]!.body, undefined);

  const absent = stubRequester({ status: 200, body: { ok: true } });
  assert.equal(
    await removeHostHumanControlHold({
      connection: { baseUrl: 'http://127.0.0.1:4310', token: 'host-token' },
      holdId: 'takeover-1',
      requester: absent.requester,
    }),
    false,
  );
});

test('a REST error body maps to its typed AppError', async () => {
  const { requester } = stubRequester({
    status: 423,
    body: {
      ok: false,
      error: 'A human-control hold is already active.',
      code: 'DEVICE_IN_USE',
      reason: 'human_control_active',
      hint: 'Wait until the hold is released.',
    },
  });
  await assert.rejects(
    putHostHumanControlHold({
      connection: { baseUrl: 'http://127.0.0.1:4310', token: 'host-token' },
      holdId: 'takeover-1',
      scope: { backend: 'android-instance', deviceKey: 'android:mobile:serial-1' },
      input: { reason: 'flashing', ttlMs: 60000 },
      requester,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'DEVICE_IN_USE');
      assert.match((error as Error).message, /already active/);
      assert.equal(
        (error as { details?: { reason?: string } }).details?.reason,
        'human_control_active',
      );
      return true;
    },
  );
});
