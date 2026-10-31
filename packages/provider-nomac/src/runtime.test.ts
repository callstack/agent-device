import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { fakeNomac } from './fake-nomac.fixtures.ts';
import { createNomacRuntime, leaseLabel, leaseRequestKey } from './runtime.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

const lease = (leaseId: string): DeviceLease => ({
  leaseId,
  tenantId: 't',
  runId: 'r',
  backend: 'ios-instance',
  leaseProvider: 'nomac',
  createdAt: 0,
  heartbeatAt: 0,
  expiresAt: 0,
});

function runtimeWith(nomac: ReturnType<typeof fakeNomac>, apiKey = 'nmk_test') {
  return createNomacRuntime({
    apiKey,
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: nomac.fetch,
    runtimeInstance: 'test',
  }).runtime;
}

test("a lease starts a phone under the lease's own request key and label, waits for it, and its release stops it", async () => {
  const nomac = fakeNomac({ readyAfter: 2 });
  const runtime = runtimeWith(nomac);
  const allocated = await runtime.leaseLifecycle.allocate!(lease('lease-a'), {
    flags: { device: 'ipad' },
  });
  expect(allocated).toMatchObject({
    nomacPhoneId: expect.stringMatching(/^ses_/),
    device: { id: 'nomac:ios:lease-a', model: 'iPad Pro 11-inch (M5)' },
  });
  const start = nomac.seen.find(
    (r) => r.method === 'POST' && r.path === '/api/v1/simulator/sessions',
  )!;
  expect(start.key).toBe('agent-device-lease-lease-a');
  expect(start.body).toEqual({ device: 'ipad', label: 'agent-device-lease-a' });
  expect(start.auth).toBe('Bearer nmk_test');
  // The same lease again answers the same phone; the inventory names it; it has an interactor.
  expect((await runtime.leaseLifecycle.allocate!(lease('lease-a'))) as object).toMatchObject({
    nomacPhoneId: (allocated as { nomacPhoneId: string }).nomacPhoneId,
  });
  const [device] =
    (await runtime.deviceInventoryProvider({ leaseProvider: 'nomac', leaseId: 'lease-a' })) ?? [];
  expect(device?.id).toBe('nomac:ios:lease-a');
  expect(runtime.getInteractor(device!)).toBeDefined();
  expect(
    await runtime.deviceInventoryProvider({ leaseProvider: 'limrun', leaseId: 'lease-a' }),
  ).toBeNull();
  await runtime.leaseLifecycle.release!(lease('lease-a'));
  expect(nomac.seen.some((r) => r.method === 'DELETE')).toBe(true);
  expect(runtime.getInteractor(device!)).toBeUndefined();
});

test('a phone that does not start is a clear failure; a refused profile field never starts one', async () => {
  const nomac = fakeNomac({ failStart: 'capacity_unavailable' });
  const runtime = runtimeWith(nomac);
  await expect(runtime.leaseLifecycle.allocate!(lease('lease-b'))).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { hint: expect.stringMatching(/in use for 5 minutes/) },
  });
  const before = nomac.seen.length;
  await expect(
    runtime.leaseLifecycle.allocate!(lease('lease-c'), { flags: { providerTimezone: 'UTC' } }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(nomac.seen.length).toBe(before);
});

test("a lease the daemon lost track of is released by its label; another provider's lease is not NoMac's", async () => {
  const nomac = fakeNomac();
  await runtimeWith(nomac).leaseLifecycle.allocate!(lease('lease-d'));
  const restarted = runtimeWith(nomac);
  expect(await restarted.leaseLifecycle.release!(lease('lease-d'))).toMatchObject({
    nomacPhoneCount: 1,
  });
  expect(
    await restarted.leaseLifecycle.allocate!({ ...lease('lease-e'), leaseProvider: 'limrun' }),
  ).toBeUndefined();
});

test('a daemon with no key starts; a lease refuses and names the variable', async () => {
  const runtime = runtimeWith(fakeNomac(), '');
  await expect(runtime.leaseLifecycle.allocate!(lease('lease-f'))).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
    message: expect.stringMatching(/NOMAC_API_KEY/),
  });
  await runtime.shutdown();
});

test('a Simulator .app is packed, uploaded, unpacked and installed, answering its bundle id; an .ipa is refused', async () => {
  const nomac = fakeNomac();
  const runtime = runtimeWith(nomac);
  await runtime.leaseLifecycle.allocate!(lease('lease-g'));
  const [device] = (await runtime.deviceInventoryProvider({
    leaseProvider: 'nomac',
    leaseId: 'lease-g',
  }))!;
  const dir = mkdtempForTestSync('nomac-app-');
  fs.mkdirSync(path.join(dir, 'Demo.app'));
  fs.writeFileSync(path.join(dir, 'Demo.app', 'Info.plist'), '<plist/>');
  const installed = await runtime.installApp!(
    device!,
    'dev.simtap.demo',
    path.join(dir, 'Demo.app'),
  );
  expect(installed).toEqual({
    bundleId: 'dev.simtap.demo',
    launchTarget: 'dev.simtap.demo',
    appName: 'Demo',
  });
  expect(nomac.seen.find((r) => r.path.endsWith('/tools/app_control'))?.body).toEqual({
    action: 'install',
    app: '/Volumes/nmw-x/src/agent-device-app/Demo.app',
  });
  fs.writeFileSync(path.join(dir, 'Demo.ipa'), 'x');
  await expect(
    runtime.installApp!(device!, 'dev.simtap.demo', path.join(dir, 'Demo.ipa')),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
});

test("request keys and labels fit NoMac's rules, hashing a lease id that does not", () => {
  expect(leaseRequestKey('abc-123')).toBe('agent-device-lease-abc-123');
  expect(leaseLabel('abc-123')).toBe('agent-device-abc-123');
  expect(leaseRequestKey('a b/c')).toMatch(/^agent-device-lease-[a-f0-9]{32}$/);
  expect(leaseLabel('x'.repeat(80))).toMatch(/^agent-device-[a-f0-9]{32}$/);
});

const liveStates = (nomac: ReturnType<typeof fakeNomac>) =>
  [...nomac.phones.values()].filter((p) => ['queued', 'provisioning', 'ready'].includes(p.state));

test('an allocation cancelled while its phone is queued stops the phone, whatever the abort hit', async () => {
  const nomac = fakeNomac({ readyAfter: 1_000 });
  const controller = new AbortController();
  const canceled = createRequestCanceledError();
  const runtime = createNomacRuntime({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: (async (input, init) => {
      const answer = await nomac.fetch(input, init);
      // Cancelled on the phone's second read, while NoMac still has it queued.
      if (nomac.seen.filter((r) => r.method === 'GET').length === 2) controller.abort(canceled);
      return answer;
    }) as typeof globalThis.fetch,
    runtimeInstance: 'test',
    readyPollMs: 1,
  }).runtime;
  // The daemon's own cancellation comes back, not the poll's AbortError.
  await expect(
    runtime.leaseLifecycle.allocate!(lease('lease-h'), { signal: controller.signal }),
  ).rejects.toBe(canceled);
  expect(nomac.phones.size).toBe(1);
  expect(liveStates(nomac)).toEqual([]);
  // The stop went out after the abort: no signal can cancel it.
  expect(nomac.seen.at(-1)).toMatchObject({ method: 'DELETE' });
});

test("an allocation aborted before NoMac's start answered finds the phone by its label and stops it", async () => {
  const nomac = fakeNomac({ readyAfter: 1_000 });
  const controller = new AbortController();
  const runtime = createNomacRuntime({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: (async (input, init) => {
      const answer = await nomac.fetch(input, init);
      if (init?.method === 'POST') {
        // NoMac took the start; its answer never reaches the allocation.
        controller.abort();
        throw controller.signal.reason;
      }
      return answer;
    }) as typeof globalThis.fetch,
    runtimeInstance: 'test',
  }).runtime;
  await expect(
    runtime.leaseLifecycle.allocate!(lease('lease-i'), { signal: controller.signal }),
  ).rejects.toThrow();
  expect(nomac.phones.size).toBe(1);
  expect(liveStates(nomac)).toEqual([]);
  expect(nomac.seen.map((r) => `${r.method} ${r.path}`).slice(-2)).toEqual([
    'GET /api/v1/simulator/sessions?label=agent-device-lease-i',
    `DELETE /api/v1/simulator/sessions/${[...nomac.phones.keys()][0]}`,
  ]);
});

test('a start NoMac had not recorded yet is looked up once more, and stopped when it shows up', async () => {
  const nomac = fakeNomac({ readyAfter: 1_000 });
  const controller = new AbortController();
  let lookups = 0;
  const runtime = createNomacRuntime({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        controller.abort();
        throw controller.signal.reason;
      }
      // The first lookup comes before NoMac recorded the start; the second sees the phone.
      if (url.searchParams.has('label') && ++lookups === 1) {
        await nomac.fetch(url.origin + url.pathname, {
          method: 'POST',
          headers: { 'idempotency-key': 'agent-device-lease-late' },
          body: JSON.stringify({ label: url.searchParams.get('label') }),
        });
        return Response.json({ sessions: [] });
      }
      return await nomac.fetch(input, init);
    }) as typeof globalThis.fetch,
    runtimeInstance: 'test',
    labelRetryMs: 1,
  }).runtime;
  await expect(
    runtime.leaseLifecycle.allocate!(lease('lease-o'), { signal: controller.signal }),
  ).rejects.toThrow();
  expect(lookups).toBe(2);
  expect(nomac.phones.size).toBe(1);
  expect(liveStates(nomac)).toEqual([]);
});

test('a lost start whose phone never shows up is named as unconfirmed, and one never sent asks nothing', async () => {
  const nomac = fakeNomac();
  const controller = new AbortController();
  const runtime = createNomacRuntime({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: (async (input, init) => {
      if (init?.method === 'POST') {
        controller.abort();
        throw controller.signal.reason;
      }
      return await nomac.fetch(input, init);
    }) as typeof globalThis.fetch,
    runtimeInstance: 'test',
    labelRetryMs: 1,
  }).runtime;
  await expect(
    runtime.leaseLifecycle.allocate!(lease('lease-p'), { signal: controller.signal }),
  ).rejects.toMatchObject({
    details: { nomacPhoneNotStopped: 'the phone labelled agent-device-lease-p, if NoMac made one' },
  });
  expect(nomac.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
    'GET /api/v1/simulator/sessions?label=agent-device-lease-p',
    'GET /api/v1/simulator/sessions?label=agent-device-lease-p',
  ]);
  const quiet = fakeNomac();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    runtimeWith(quiet).leaseLifecycle.allocate!(lease('lease-q'), { signal: cancelled.signal }),
  ).rejects.toThrow();
  expect(quiet.seen).toEqual([]);
});

test('a read that fails after the start, or a phone not ready in time, stops the phone', async () => {
  const nomac = fakeNomac({ readyAfter: 1_000 });
  let reads = 0;
  const failing = createNomacRuntime({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: (async (input, init) =>
      (init?.method ?? 'GET') === 'GET' && ++reads > 1
        ? Response.json({ error: { code: 'bad', message: 'No.' } }, { status: 400 })
        : await nomac.fetch(input, init)) as typeof globalThis.fetch,
    runtimeInstance: 'test',
    readyPollMs: 1,
  }).runtime;
  await expect(failing.leaseLifecycle.allocate!(lease('lease-j'))).rejects.toMatchObject({
    code: 'INVALID_ARGS',
  });
  expect(liveStates(nomac)).toEqual([]);
  const late = fakeNomac({ readyAfter: 1_000 });
  const slow = runtimeWith(late);
  await expect(
    slow.leaseLifecycle.allocate!(lease('lease-k'), { deadline: Date.now() }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', message: expect.stringMatching(/in time/) });
  expect(liveStates(late)).toEqual([]);
});

test('a start NoMac refused started nothing, and a phone that cannot be stopped is named', async () => {
  const nomac = fakeNomac({ readyAfter: 1_000 });
  const refusing = createNomacRuntime({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: (async (input, init) =>
      init?.method === 'POST'
        ? Response.json(
            { error: { code: 'insufficient_credit', message: 'No credit.' } },
            { status: 402 },
          )
        : await nomac.fetch(input, init)) as typeof globalThis.fetch,
    runtimeInstance: 'test',
  }).runtime;
  await expect(refusing.leaseLifecycle.allocate!(lease('lease-l'))).rejects.toMatchObject({
    details: { nomacCode: 'insufficient_credit', status: 402 },
  });
  expect(nomac.seen).toEqual([]);
  // A 5xx is no proof nothing started: here NoMac made the phone and then failed to answer.
  const erroring = createNomacRuntime({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: (async (input, init) => {
      const answer = await nomac.fetch(input, init);
      return init?.method === 'POST'
        ? Response.json({ error: { code: 'internal', message: 'Oops.' } }, { status: 500 })
        : answer;
    }) as typeof globalThis.fetch,
    runtimeInstance: 'test',
  }).runtime;
  await expect(erroring.leaseLifecycle.allocate!(lease('lease-n'))).rejects.toMatchObject({
    details: { status: 500 },
  });
  expect(liveStates(nomac)).toEqual([]);
  const stuck = createNomacRuntime({
    apiKey: 'nmk_test',
    baseUrl: 'https://nomac.test',
    clientVersion: '0.0.0-test',
    fetch: (async (input, init) =>
      init?.method === 'DELETE'
        ? Response.json({ error: { code: 'down', message: 'Down.' } }, { status: 400 })
        : await nomac.fetch(input, init)) as typeof globalThis.fetch,
    runtimeInstance: 'test',
  }).runtime;
  await expect(
    stuck.leaseLifecycle.allocate!(lease('lease-m'), { deadline: Date.now() }),
  ).rejects.toMatchObject({ details: { nomacPhoneNotStopped: expect.stringMatching(/^ses_/) } });
});
