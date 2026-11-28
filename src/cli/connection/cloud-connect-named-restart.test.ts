import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import {
  proxyFrontDevice,
  withLeaseAllocation,
} from '../../__tests__/cli-cloud-session.fixtures.ts';
import { cloudAttachmentPath, readCloudConnection } from './cloud-connection-record.ts';

const sessionName = 'restart-qa';
const connectArgs = ['connect', 'cloud', '--platform', 'ios', '--json'];
const attach = {
  kind: 'agent-device-daemon',
  daemonBaseUrl: 'https://daemon.example/device',
  daemonAuthToken: 'scoped-daemon-token',
};

// One state directory is the only thing two CLI invocations share; each runCliCapture is a new
// process as far as the CLI can tell, with its own environment object.
function processEnv(stateDir: string) {
  return {
    AGENT_DEVICE_SESSION: sessionName,
    AGENT_DEVICE_STATE_DIR: stateDir,
    AGENT_DEVICE_CLOUD_BASE_URL: 'https://cloud.example',
    AGENT_DEVICE_CLOUD_API_KEY: 'cloud-api-test-key',
    AGENT_DEVICE_CLOUD_API_KEY_ORIGIN: 'https://cloud.example',
  };
}

function freshStateDir() {
  return mkdtempForTestSync('agent-device-cloud-restart-');
}

function locationOf(stateDir: string) {
  return { stateDir, session: sessionName };
}

// A broker with one hold per idempotency key, as the real create endpoint keeps.
function stubBroker(attachment: typeof attach = attach) {
  const byKey = new Map<string, { id: string; running: boolean }>();
  const calls: Array<{ method: string; path: string; key: string | null; body?: unknown }> = [];
  const deadlineAt = new Date(Date.now() + 3600_000).toISOString();
  const created = (id: string) => ({
    id,
    vendor: 'provider-a',
    transport: 'agent-device-daemon',
    platform: 'ios',
    deadlineAt,
    viewerUrl: 'https://viewer.example/session?token=private',
    attach: attachment,
  });
  const loseNextCreateResponse = { armed: false };
  const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
    const key = new Headers(init.headers).get('Idempotency-Key');
    calls.push({
      method: String(init.method),
      path: url.pathname,
      key,
      ...(init.method === 'POST' ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (init.method === 'POST') {
      let hold = byKey.get(key!);
      if (!hold) {
        hold = {
          id: `00000000-0000-4000-8000-${String(byKey.size + 1).padStart(12, '0')}`,
          running: true,
        };
        byKey.set(key!, hold);
      }
      if (loseNextCreateResponse.armed) {
        loseNextCreateResponse.armed = false;
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 240_001);
        throw new DOMException('request timed out', 'TimeoutError');
      }
      return Response.json(created(hold.id), { status: 201 });
    }
    if (init.method === 'DELETE') {
      for (const hold of byKey.values()) {
        if (url.pathname.endsWith(`/${hold.id}`)) hold.running = false;
      }
      return new Response(null, { status: 204 });
    }
    return Response.json({ id: '00000000-0000-4000-8000-000000000001', state: 'running' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    holds: byKey,
    loseNextCreateResponse: () => (loseNextCreateResponse.armed = true),
    posts: () => calls.filter((call) => call.method === 'POST'),
    deletes: () => calls.filter((call) => call.method === 'DELETE'),
  };
}

test('a named restart of a proxy front reuses the first run lease id', async () => {
  const stateDir = freshStateDir();
  stubBroker(proxyFrontDevice.attach);
  // One front serves both CLI invocations, so it still holds the lease the first run allocated.
  const served = withLeaseAllocation();
  const answers: Array<{ command: string; data?: unknown }> = [];
  const front = async (req: Parameters<typeof served>[0]) => {
    const response = await served(req);
    answers.push({ command: req.command, data: response.ok ? response.data : undefined });
    return response;
  };
  expect((await runCliCapture(connectArgs, { env: processEnv(stateDir) })).code).toBeNull();

  const first = await runCliCapture(['open', 'com.apple.Preferences', '--json'], {
    env: processEnv(stateDir),
    sendToDaemon: front,
  });
  expect(first.code, first.stderr || first.stdout).toBeNull();
  const leaseId = first.calls.find((call) => call.command === 'lease_allocate')?.meta?.leaseId;
  expect(leaseId).toEqual(expect.any(String));

  const restarted = await runCliCapture(['open', 'com.apple.Preferences', '--json'], {
    env: processEnv(stateDir),
    sendToDaemon: front,
  });
  expect(restarted.code, restarted.stderr || restarted.stdout).toBeNull();
  const leaseRpcs = restarted.calls.filter((call) => call.command.startsWith('lease_'));
  expect(leaseRpcs.length).toBeGreaterThan(0);
  for (const call of leaseRpcs) expect(call.meta?.leaseId).toBe(leaseId);
  expect(restarted.calls.at(-1)).toMatchObject({ command: 'open', meta: { leaseId } });
  expect(
    answers.some((answer) => answer.command.startsWith('lease_') && isReused(answer.data)),
  ).toBe(true);
  expect(
    (await runCliCapture(['disconnect', '--json'], { env: processEnv(stateDir) })).code,
  ).toBeNull();
});

function isReused(data: unknown): boolean {
  return (
    typeof data === 'object' && data !== null && (data as { reused?: unknown }).reused === true
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('a second CLI invocation with the same state directory and session name reuses the committed binding without a second create', async () => {
  const stateDir = freshStateDir();
  const broker = stubBroker();
  const first = await runCliCapture(connectArgs, { env: processEnv(stateDir) });
  expect(first.code, first.stderr || first.stdout).toBeNull();
  const committed = readCloudConnection(locationOf(stateDir));
  expect(committed).toMatchObject({
    phase: 'committed',
    id: '00000000-0000-4000-8000-000000000001',
  });

  // The restarted agent runs its next command with a new environment and no connect flags.
  for (const command of ['open', 'snapshot']) {
    const next = await runCliCapture([command, '--json'], { env: processEnv(stateDir) });
    expect(next.code, next.stderr || next.stdout).toBeNull();
    expect(next.calls.map(({ command: name }) => name)).toEqual([command]);
    expect(next.calls[0]?.flags?.daemonBaseUrl).toBe(attach.daemonBaseUrl);
    expect(next.transportOptions[0]).toMatchObject({ authToken: attach.daemonAuthToken });
  }

  expect(broker.posts()).toHaveLength(1);
  expect(broker.holds.size).toBe(1);
  expect(broker.calls.map((call) => call.method)).toEqual(['POST']);
  expect(readCloudConnection(locationOf(stateDir))).toEqual(committed);
  expect(readRemoteConnectionState(locationOf(stateDir))?.cloudSession?.id).toBe(
    '00000000-0000-4000-8000-000000000001',
  );
});

test('a lost preload response binds retry to the same archive and idempotency key', async () => {
  const stateDir = freshStateDir();
  const broker = stubBroker();
  const appUrl = 'https://archives.example/build.zip';
  const args = [...connectArgs, '--app-url', appUrl, '--max-usd', '0.50'];
  broker.loseNextCreateResponse();
  const crashed = await runCliCapture(args, { env: processEnv(stateDir) });
  expect(JSON.parse(crashed.stdout).error.details.reason).toBe('cloud_session_connect_timeout');
  vi.mocked(Date.now).mockRestore();
  // The broker holds funds for the key, and the CLI holds only a pending intent.
  expect(readCloudConnection(locationOf(stateDir))).toMatchObject({ phase: 'pending' });
  expect(broker.holds.size).toBe(1);
  expect(fs.existsSync(cloudAttachmentPath(locationOf(stateDir)))).toBe(false);

  const mismatch = await runCliCapture(
    [...connectArgs, '--app-url=https://archives.example/another.zip', '--max-usd', '0.50'],
    { env: processEnv(stateDir) },
  );
  expect(JSON.parse(mismatch.stdout).error.details.reason).toBe('cloud_connect_pending_conflict');
  expect(broker.posts()).toHaveLength(1);

  const restarted = await runCliCapture(
    [...connectArgs, '--app-url', 'HTTPS://ARCHIVES.EXAMPLE:443/build.zip', '--max-usd', '0.50'],
    { env: processEnv(stateDir) },
  );
  expect(restarted.code, restarted.stderr || restarted.stdout).toBeNull();

  expect(broker.posts()).toEqual(
    Array(2).fill({
      method: 'POST',
      path: '/v1/sessions/preloaded',
      key: expect.stringMatching(/\S/),
      body: expect.objectContaining({ app: { url: appUrl }, maxUsdMicros: '500000' }),
    }),
  );
  expect(broker.posts()[1]?.key).toBe(broker.posts()[0]?.key);
  expect(restarted.stdout + restarted.stderr).not.toContain(appUrl);
  expect(broker.holds.size).toBe(1);
  expect(readCloudConnection(locationOf(stateDir))).toMatchObject({
    phase: 'committed',
    id: '00000000-0000-4000-8000-000000000001',
  });
  const opened = await runCliCapture(['open', '--json'], { env: processEnv(stateDir) });
  expect(opened.calls[0]?.flags?.daemonBaseUrl).toBe(attach.daemonBaseUrl);
});

test.each([
  ['a missing attachment file', (file: string) => fs.rmSync(file)],
  ['an attachment file that is not JSON', (file: string) => fs.writeFileSync(file, '{not json')],
  [
    'an attachment file for another vendor',
    (file: string) =>
      fs.writeFileSync(
        file,
        JSON.stringify({
          kind: 'limrun',
          platform: 'ios',
          apiUrl: 'https://x.example',
          token: 't',
        }),
      ),
  ],
])(
  'with %s the committed binding refuses commands and disconnect then ends the session',
  async (_label, damage) => {
    const stateDir = freshStateDir();
    const broker = stubBroker();
    expect((await runCliCapture(connectArgs, { env: processEnv(stateDir) })).code).toBeNull();
    damage(cloudAttachmentPath(locationOf(stateDir)));

    const blocked = await runCliCapture(['open', '--json'], { env: processEnv(stateDir) });
    expect(JSON.parse(blocked.stdout).error).toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'cloud_attachment_unavailable' },
    });
    expect(blocked.calls).toEqual([]);
    // Nothing heals the attachment: no attach request exists, and no create or end was sent.
    expect(broker.calls.map((call) => call.method)).toEqual(['POST']);
    expect(readCloudConnection(locationOf(stateDir))).toMatchObject({ phase: 'committed' });

    const reconnect = await runCliCapture(connectArgs, { env: processEnv(stateDir) });
    expect(JSON.parse(reconnect.stdout).error).toMatchObject({
      code: 'INVALID_ARGS',
      details: { session: sessionName },
    });
    expect(broker.posts()).toHaveLength(1);

    expect(
      (await runCliCapture(['disconnect', '--json'], { env: processEnv(stateDir) })).code,
    ).toBeNull();
    expect(broker.deletes().map((call) => call.path)).toEqual([
      '/v1/sessions/00000000-0000-4000-8000-000000000001',
    ]);
    expect(readCloudConnection(locationOf(stateDir))).toBeNull();
  },
);

test('connect on a named session that is already bound conflicts, and --force ends the old device before creating a new one', async () => {
  const stateDir = freshStateDir();
  const broker = stubBroker();
  expect((await runCliCapture(connectArgs, { env: processEnv(stateDir) })).code).toBeNull();

  const conflict = await runCliCapture(connectArgs, { env: processEnv(stateDir) });
  expect(conflict.code).toBe(1);
  expect(JSON.parse(conflict.stdout).error).toMatchObject({ code: 'INVALID_ARGS' });
  expect(broker.posts()).toHaveLength(1);
  expect(broker.deletes()).toEqual([]);
  expect(readCloudConnection(locationOf(stateDir))).toMatchObject({
    id: '00000000-0000-4000-8000-000000000001',
  });

  const forced = await runCliCapture([...connectArgs, '--force'], { env: processEnv(stateDir) });
  expect(forced.code, forced.stderr || forced.stdout).toBeNull();
  expect(broker.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    'POST /v1/sessions',
    'DELETE /v1/sessions/00000000-0000-4000-8000-000000000001',
    'POST /v1/sessions',
  ]);
  const keys = broker.posts().map((call) => call.key);
  expect(keys[1]).not.toBe(keys[0]);
  expect(broker.holds.get(keys[0]!)?.running).toBe(false);
  expect(readCloudConnection(locationOf(stateDir))).toMatchObject({
    phase: 'committed',
    id: '00000000-0000-4000-8000-000000000002',
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('slow hosted allocation prints only safe deadlines and stops polling after allocation', async () => {
  vi.useFakeTimers();
  const stateDir = freshStateDir();
  const deadline = new Date(Date.now() + 3600_000).toISOString();
  const posted = deferred<void>();
  const created = deferred<Response>();
  const pendingPoll = deferred<Response>();
  const polls: Array<{ url: URL; init: RequestInit }> = [];
  const allocatingResponses = [
    Response.json({ error: 'private-upstream-detail' }, { status: 401 }),
    Response.json({ state: 'allocating', deadlineAt: '2037-02-31T00:00:00Z' }),
    Response.json({
      state: 'allocating',
      deadlineAt: '2037-02-01T00:00:00.1Z',
      attach: { token: ' 100Z ' },
    }),
    Response.json({
      state: 'allocating',
      deadlineAt: '2037-02-01T00:00:00.1Z',
      attach: { daemonAuthToken: '00.1Z' },
    }),
    Response.json({
      state: 'allocating',
      deadlineAt: deadline,
      attach,
      viewerUrl: 'https://viewer.example/session?token=private',
      account: 'private-account-detail',
    }),
  ];
  let requestKey: string | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, init: RequestInit) => {
      if (init.method === 'POST') {
        requestKey = new Headers(init.headers).get('Idempotency-Key');
        posted.resolve();
        return created.promise;
      }
      polls.push({ url, init });
      return allocatingResponses.shift() ?? pendingPoll.promise;
    }),
  );

  const connecting = runCliCapture(connectArgs, { env: processEnv(stateDir) });
  await posted.promise;
  await vi.advanceTimersByTimeAsync(60_000);
  const pollsBeforeSettlement = polls.length;
  const settlementSignal = polls.at(-1)?.init.signal;
  expect(settlementSignal?.aborted).toBe(false);
  expect(requestKey).toEqual(expect.any(String));
  for (const { url, init } of polls) {
    expect(url.origin).toBe('https://cloud.example');
    expect(url.pathname).toBe('/v1/sessions');
    expect([...url.searchParams]).toEqual([['idempotencyKey', requestKey]]);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  }

  pendingPoll.resolve(Response.json({ state: 'running', deadlineAt: deadline }));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(polls).toHaveLength(pollsBeforeSettlement);
  expect(settlementSignal?.aborted).toBe(true);

  created.resolve(
    Response.json(
      {
        id: '00000000-0000-4000-8000-000000000001',
        vendor: 'provider-a',
        transport: 'agent-device-daemon',
        platform: 'ios',
        deadlineAt: deadline,
        attach,
      },
      { status: 201 },
    ),
  );
  const result = await connecting;
  expect(result.code).toBeNull();
  expect(JSON.parse(result.stdout)).toMatchObject({ success: true });
  expect(result.stderr).toMatch(/^connect cloud: allocating, \d+s elapsed/m);
  expect(result.stderr.match(/session deadline [^)]+/g)).toEqual([`session deadline ${deadline}`]);
  for (const privateValue of [
    attach.daemonAuthToken,
    attach.daemonBaseUrl,
    'viewer.example',
    'private-upstream-detail',
    'private-account-detail',
  ]) {
    expect(result.stderr).not.toContain(privateValue);
  }
});
