import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { runCliCapture } from './cli-capture.ts';
import { cloudAttachmentPath } from '../cli/connection/cloud-connection-record.ts';
import {
  cloudEnv,
  connectArgs,
  hostedDevice,
  locationOf,
  proxyFrontDevice,
  stubCloudApi,
  withLeaseAllocation,
} from './cli-cloud-session.fixtures.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a proxy-front attachment allocates its lease before open and sends that lease id with open', async () => {
  const env = cloudEnv();
  stubCloudApi(proxyFrontDevice);
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();

  const opened = await runCliCapture(['open', 'com.apple.Preferences', '--json'], {
    env,
    sendToDaemon: withLeaseAllocation(),
  });
  expect(opened.code, opened.stderr || opened.stdout).toBeNull();
  expect(opened.calls.map(({ command }) => command)).toEqual(['lease_allocate', 'open']);
  const [allocate, open] = opened.calls;
  expect(allocate?.flags?.daemonBaseUrl).toBe(hostedDevice.attach.daemonBaseUrl);
  expect(allocate?.meta?.leaseProvider).toBe('proxy');
  expect(typeof allocate?.meta?.leaseId).toBe('string');
  expect(open?.meta?.leaseId).toBe(allocate?.meta?.leaseId);
  expect(open?.meta?.tenantId).toBe(allocate?.meta?.tenantId);
  expect(open?.meta?.runId).toBe(allocate?.meta?.runId);
  expect(open?.meta?.clientId).toBe(allocate?.meta?.clientId);
  expect(open?.meta?.deviceKey).toBeTypeOf('string');
  expect(opened.transportOptions[0]).toMatchObject({
    authToken: hostedDevice.attach.daemonAuthToken,
  });
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
});

test('a proxy-front command after open carries the lease scope the front refuses without', async () => {
  const env = cloudEnv();
  stubCloudApi(proxyFrontDevice);
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const served = withLeaseAllocation();
  expect(
    (
      await runCliCapture(['open', 'com.apple.Preferences', '--json'], {
        env,
        sendToDaemon: served,
      })
    ).code,
  ).toBeNull();

  const snapshot = await runCliCapture(['snapshot', '-i', '--json'], {
    env,
    sendToDaemon: served,
  });
  expect(snapshot.code, snapshot.stderr || snapshot.stdout).toBeNull();
  const sent = snapshot.calls.find((call) => call.command === 'snapshot');
  expect(snapshot.calls.map(({ command }) => command)).toEqual(['lease_heartbeat', 'snapshot']);
  expect(sent?.meta?.tenantId).toBeTypeOf('string');
  expect(sent?.meta?.runId).toBeTypeOf('string');
  expect(sent?.meta?.leaseId).toBeTypeOf('string');

  const closed = await runCliCapture(['close', '--json'], { env, sendToDaemon: served });
  expect(closed.code, closed.stderr || closed.stdout).toBeNull();
  const [close] = closed.calls;
  expect(close?.command).toBe('close');
  expect(close?.meta?.leaseId).toBe(sent?.meta?.leaseId);
  expect(
    (await runCliCapture(['disconnect', '--json'], { env, sendToDaemon: served })).code,
  ).toBeNull();
});

test('a proxy-front attachment refuses a command before open, and a daemon attachment does not', async () => {
  const proxyEnv = cloudEnv();
  stubCloudApi(proxyFrontDevice);
  expect((await runCliCapture(connectArgs, { env: proxyEnv })).code).toBeNull();
  const refused = await runCliCapture(['snapshot', '--json'], { env: proxyEnv });
  expect(refused.code).toBe(1);
  expect(refused.calls).toEqual([]);
  expect(JSON.parse(refused.stdout).error.message).toContain('run open first');
  expect((await runCliCapture(['disconnect', '--json'], { env: proxyEnv })).code).toBeNull();

  const daemonEnv = cloudEnv();
  stubCloudApi();
  expect((await runCliCapture(connectArgs, { env: daemonEnv })).code).toBeNull();
  const sent = await runCliCapture(['snapshot', '--json'], { env: daemonEnv });
  expect(sent.code).toBeNull();
  expect(sent.calls.map(({ command }) => command)).toEqual(['snapshot']);
  expect((await runCliCapture(['disconnect', '--json'], { env: daemonEnv })).code).toBeNull();
});

test('disconnect releases a proxy-front lease with the attachment token before the cloud session ends', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi(proxyFrontDevice);
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const opened = await runCliCapture(['open', 'com.apple.Preferences', '--json'], {
    env,
    sendToDaemon: withLeaseAllocation(),
  });
  expect(opened.code).toBeNull();
  const leaseId = opened.calls[0]?.meta?.leaseId;

  let releasedBeforeDelete = false;
  const front = withLeaseAllocation();
  const disconnected = await runCliCapture(['disconnect', '--json'], {
    env,
    sendToDaemon: async (req) => {
      if (req.command === 'lease_release') {
        releasedBeforeDelete = !fetchMock.mock.calls.some(([, init]) => init.method === 'DELETE');
      }
      return await front(req);
    },
  });
  expect(disconnected.code, disconnected.stderr || disconnected.stdout).toBeNull();
  expect(disconnected.calls.map(({ command }) => command)).toEqual(['lease_release']);
  const [release] = disconnected.calls;
  expect(release?.flags?.daemonBaseUrl).toBe(hostedDevice.attach.daemonBaseUrl);
  expect(typeof leaseId).toBe('string');
  expect(release?.meta?.leaseId).toBe(leaseId);
  expect(disconnected.transportOptions[0]).toMatchObject({
    authToken: hostedDevice.attach.daemonAuthToken,
  });
  expect(releasedBeforeDelete).toBe(true);
  expect(fetchMock.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(true);
});

test('disconnect sends no lease release for a daemon attachment without the proxy-front field', async () => {
  const env = cloudEnv();
  stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const disconnected = await runCliCapture(['disconnect', '--json'], {
    env,
    sendToDaemon: withLeaseAllocation(),
  });
  expect(disconnected.code).toBeNull();
  expect(disconnected.calls).toEqual([]);
});

test('a failed proxy-front lease release still ends disconnect and removes the attachment', async () => {
  const env = cloudEnv();
  stubCloudApi(proxyFrontDevice);
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  expect(
    (
      await runCliCapture(['open', 'com.apple.Preferences', '--json'], {
        env,
        sendToDaemon: withLeaseAllocation(),
      })
    ).code,
  ).toBeNull();

  const disconnected = await runCliCapture(['disconnect', '--json'], {
    env,
    sendToDaemon: async () => ({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'the proxy front is unreachable' },
    }),
  });
  expect(disconnected.code, disconnected.stderr || disconnected.stdout).toBeNull();
  expect(JSON.parse(disconnected.stdout).data.leaseReleaseError).toContain('unreachable');
  expect(fs.existsSync(cloudAttachmentPath(locationOf(env)))).toBe(false);
});

test('a proxy-front command ignores a lease id passed on its command line', async () => {
  const env = cloudEnv();
  stubCloudApi(proxyFrontDevice);
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const opened = await runCliCapture(
    ['open', 'com.apple.Preferences', '--lease-id', 'caller-supplied-lease', '--json'],
    { env, sendToDaemon: withLeaseAllocation() },
  );
  expect(opened.code, opened.stderr || opened.stdout).toBeNull();
  const allocate = opened.calls.find((call) => call.command === 'lease_allocate');
  expect(typeof allocate?.meta?.leaseId).toBe('string');
  expect(allocate?.meta?.leaseId).not.toBe('caller-supplied-lease');
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
});

test('a connect replacement whose proxy-front lease release fails prints the warning', async () => {
  const env = cloudEnv();
  stubCloudApi(proxyFrontDevice);
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  expect(
    (
      await runCliCapture(['open', 'com.apple.Preferences', '--json'], {
        env,
        sendToDaemon: withLeaseAllocation(),
      })
    ).code,
  ).toBeNull();

  const replaced = await runCliCapture([...connectArgs, '--force'], {
    env,
    sendToDaemon: async () => ({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'the proxy front is unreachable' },
    }),
  });
  expect(replaced.stderr).toContain('did not confirm its lease release');
  expect(replaced.stderr).toContain('unreachable');
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
});
