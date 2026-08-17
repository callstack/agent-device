import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import {
  createAwsDeviceFarmPrepareSession,
  type AwsDeviceFarmClient,
  type AwsDeviceFarmRemoteAccessSession,
} from './aws-device-farm.ts';
import { buildCloudWebDriverBaseCapabilities } from './runtime.ts';

const ARN = 'arn:aws:devicefarm:us-west-2:1:session/pending';

afterEach(() => {
  vi.restoreAllMocks();
});

// Once `create-remote-access-session` answers, the ARN is a billed session that
// nothing else will stop. Every way the startup wait can end short of RUNNING
// must stop it before the failure surfaces (#1774 ownership rule, one phase
// earlier than the WebDriver session).
test('a startup timeout stops the remote-access session it created', async () => {
  const client = fakeClient({ status: 'PENDING' });
  const prepare = createAwsDeviceFarmPrepareSession({
    ...baseOptions(client),
    startupTimeoutMs: 30,
    pollIntervalMs: 5,
  });

  await assert.rejects(
    () => prepare({ lease: makeLease(), base: baseSession() }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /Timed out waiting for AWS Device Farm/);
      return true;
    },
  );
  assert.deepEqual(client.stopped, [ARN]);
});

test('a canceled request stops the remote-access session mid-startup', async () => {
  const controller = new AbortController();
  const client = fakeClient({ status: 'PENDING' }, () =>
    controller.abort(createRequestCanceledError()),
  );
  const prepare = createAwsDeviceFarmPrepareSession({
    ...baseOptions(client),
    startupTimeoutMs: 5_000,
    pollIntervalMs: 5,
  });

  await assert.rejects(
    () => prepare({ lease: makeLease(), req: { signal: controller.signal }, base: baseSession() }),
    (error: unknown) => isRequestCanceledError(error),
  );
  assert.deepEqual(client.stopped, [ARN]);
});

// The daemon's allocation deadline caps the startup wait so a client that
// stops waiting at that deadline never abandons a still-polling daemon.
test('the allocation deadline caps the startup wait below its own default', async () => {
  const client = fakeClient({ status: 'PENDING' });
  const prepare = createAwsDeviceFarmPrepareSession({
    ...baseOptions(client),
    startupTimeoutMs: 60_000,
    pollIntervalMs: 5,
  });
  const startedAt = Date.now();

  await assert.rejects(
    () => prepare({ lease: makeLease(), req: { deadline: Date.now() + 40 }, base: baseSession() }),
    /Timed out waiting for AWS Device Farm/,
  );
  assert.ok(Date.now() - startedAt < 5_000, 'the wait must end at the deadline, not the default');
  assert.deepEqual(client.stopped, [ARN]);
});

// Live iOS real devices needed ~128s to reach RUNNING while the daemon's 300s
// allocation budget still had room, and the standalone 120s default cut them
// off. When the daemon supplies a deadline it is THE bound; the default only
// applies without one. Time is a virtual clock advanced 10s per poll, so this is
// deterministic and fails on the old `min(default, deadline)` logic (which
// throws at 120s, before the 150s RUNNING).
test('the allocation deadline lets startup run past the standalone 120s default', async () => {
  const startedAt = 1_700_000_000_000;
  let virtualNow = startedAt;
  vi.spyOn(Date, 'now').mockImplementation(() => virtualNow);
  const client = fakeClient({ status: 'PENDING' }, () => {
    virtualNow += 10_000;
    if (virtualNow - startedAt >= 150_000) {
      client.session.status = 'RUNNING';
      client.session.endpoints = { appium: 'https://appium.example/wd/hub' };
    }
  });
  const prepare = createAwsDeviceFarmPrepareSession({
    ...baseOptions(client),
    // The standalone default; a daemon-supplied deadline must override it.
    startupTimeoutMs: 120_000,
    pollIntervalMs: 1,
  });

  const prepared = await prepare({
    lease: makeLease(),
    req: { deadline: startedAt + 300_000 },
    base: baseSession(),
  });
  assert.equal(prepared.providerSessionId, ARN);
  assert.ok(virtualNow - startedAt >= 150_000, 'RUNNING must have been observed after 120s');
  assert.deepEqual(client.stopped, []);
});

test('a session that reaches RUNNING is handed on and not stopped', async () => {
  const client = fakeClient({
    status: 'RUNNING',
    endpoints: { appium: 'https://appium.example/wd/hub' },
  });
  const prepare = createAwsDeviceFarmPrepareSession(baseOptions(client));

  const prepared = await prepare({ lease: makeLease(), base: baseSession() });
  assert.equal(prepared.providerSessionId, ARN);
  assert.equal(prepared.endpoint, 'https://appium.example/wd/hub');
  assert.deepEqual(client.stopped, []);
});

function fakeClient(
  session: Partial<AwsDeviceFarmRemoteAccessSession>,
  onPoll?: () => void,
): AwsDeviceFarmClient & { stopped: string[]; session: Partial<AwsDeviceFarmRemoteAccessSession> } {
  const stopped: string[] = [];
  return {
    stopped,
    session,
    createRemoteAccessSession: async () => ({ arn: ARN, status: 'PENDING' }),
    getRemoteAccessSession: async (arn) => {
      onPoll?.();
      return { arn, ...session };
    },
    stopRemoteAccessSession: async (arn) => {
      stopped.push(arn);
      return { arn, status: 'STOPPING' };
    },
    listArtifacts: async () => [],
  };
}

function baseOptions(client: AwsDeviceFarmClient) {
  return {
    client,
    platform: 'android' as const,
    deviceName: 'Pixel',
    projectArn: 'arn:aws:devicefarm:us-west-2:1:project/p',
    deviceArn: 'arn:aws:devicefarm:us-west-2::device/d',
  };
}

function baseSession() {
  return {
    provider: 'aws-device-farm',
    endpoint: 'http://127.0.0.1/',
    platform: 'android' as const,
    deviceName: 'Pixel',
    webdriverCapabilities: buildCloudWebDriverBaseCapabilities('android', 'Pixel'),
  };
}

function makeLease(): DeviceLease {
  return {
    leaseId: 'lease-aws',
    tenantId: 'team-a',
    runId: 'run-a',
    leaseProvider: 'aws-device-farm',
    backend: 'android-instance',
    createdAt: 1,
    expiresAt: 2,
    heartbeatAt: 1,
  };
}
