import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createTestHostEnvironment,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { writeCliSession } from '../cli/auth-session.ts';
import {
  cloudAttachmentPath,
  cloudConnectionDir,
  prepareCloudConnection,
  readCloudConnection,
  withConnectionLock,
  writeCloudConnection,
} from '../cli/connection/cloud-connection-record.ts';
import * as browserLaunch from '../cli/browser-launch.ts';
import * as activeConnection from '../cli/connection/active-connection.ts';
import * as commandConnection from '../cli/connection/command-connection.ts';
import { disconnectCommand } from '../cli/commands/connection.ts';
import { bindCloudAttachment } from '../cli/connection/cloud-attachment.ts';
import { createTestClient, proxyWorkspace } from './remote-connection.fixtures.ts';
import { runCliCapture } from './cli-capture.ts';
import { startRegisteredHttpDaemon } from './test-utils/registered-http-daemon.ts';
import * as daemonArtifacts from '@agent-device/remote/daemon-artifacts';

import {
  cloudEnv,
  connectArgs,
  hostedDevice,
  locationOf,
  postKey,
  stubCloudApi,
  timeOutNextCreate,
  sessionName,
} from './cli-cloud-session.fixtures.ts';

vi.mock('@agent-device/plugins/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agent-device/plugins/store')>();
  const { limrunPluginCandidate } = await import('./test-utils/limrun-plugin-store.ts');
  return {
    ...original,
    storePluginCandidates: async (env: NodeJS.ProcessEnv) =>
      env.TEST_CLOUD_PLUGIN ? [limrunPluginCandidate()] : original.storePluginCandidates(env),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('connects through a hosted daemon with the scoped daemon token and ends the session with the API key', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  const connect = await runCliCapture(
    [
      'connect',
      'cloud',
      '--platform',
      'ios',
      '--vendor',
      'provider-a',
      '--max-minutes',
      '20',
      '--json',
    ],
    { env: { ...env, AGENT_DEVICE_TARGET: 'tv' } },
  );
  expect(connect.code, connect.stderr || connect.stdout).toBeNull();
  expect(JSON.parse(connect.stdout).data).toMatchObject({
    deadlineAt: hostedDevice.deadlineAt,
    vendor: 'provider-a',
    viewerAvailable: true,
  });
  for (const secret of [
    hostedDevice.viewerUrl,
    hostedDevice.attach.daemonAuthToken,
    env.AGENT_DEVICE_CLOUD_API_KEY,
  ]) {
    expect(connect.stdout).not.toContain(secret);
    expect(connect.stderr).not.toContain(secret);
  }
  const stateDir = env.AGENT_DEVICE_STATE_DIR;
  const state = readRemoteConnectionState({ stateDir, session: sessionName });
  expect(state?.cloudSession?.id).toBe(hostedDevice.id);
  expect(state?.target).toBe('mobile');
  expect(fs.readFileSync(state!.remoteConfigPath, 'utf8')).not.toContain(
    hostedDevice.attach.daemonAuthToken,
  );

  const opened = await runCliCapture(['open', 'com.apple.Preferences', '--json'], {
    env: { ...env, AGENT_DEVICE_DAEMON_BASE_URL: 'https://unrelated.example/' },
  });
  expect(opened.code, opened.stderr || opened.stdout).toBeNull();
  expect(opened.calls.map(({ command }) => command)).toEqual(['open']);
  expect(opened.calls[0]?.flags?.daemonBaseUrl).toBe(hostedDevice.attach.daemonBaseUrl);
  expect(opened.transportOptions[0]).toMatchObject({
    authToken: hostedDevice.attach.daemonAuthToken,
  });

  const disconnected = await runCliCapture(['disconnect', '--json'], { env });
  expect(disconnected.code).toBeNull();
  expect(
    fetchMock.mock.calls.map(([url, init]) => [url.pathname, init.method, init.headers]),
  ).toEqual([
    [
      '/v1/sessions',
      'POST',
      {
        'content-type': 'application/json',
        authorization: 'Bearer cloud-api-test-key',
        'Idempotency-Key': expect.any(String),
      },
    ],
    [
      '/v1/sessions/00000000-0000-4000-8000-000000000001',
      'DELETE',
      { authorization: 'Bearer cloud-api-test-key' },
    ],
  ]);
  expect(readRemoteConnectionState({ stateDir, session: sessionName })).toBeNull();
});

test('releases a device returned with an unadvertised transport before binding it', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi({ ...hostedDevice, transport: 'future-transport' });
  const connect = await runCliCapture(['connect', 'cloud', '--platform', 'ios', '--json'], { env });

  expect(connect.code).toBe(1);
  expect(JSON.parse(connect.stdout).error.details.reason).toBe('cloud_transport_unsupported');
  expect(fetchMock.mock.calls.map(([url, init]) => [url.pathname, init.method])).toEqual([
    ['/v1/sessions', 'POST'],
    ['/v1/sessions/00000000-0000-4000-8000-000000000001', 'DELETE'],
  ]);
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body)).accepts).toEqual([
    'agent-device-daemon',
  ]);
  const location = { stateDir: env.AGENT_DEVICE_STATE_DIR, session: sessionName };
  expect(readCloudConnection(location)).toBeNull();
  expect(readRemoteConnectionState(location)).toBeNull();
});

test('passes every requested capability and reports the vendor fallback', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi({ ...hostedDevice, fallbackFrom: ['limrun'] });
  const args = ['connect', 'cloud', '--platform', 'ios', '--needs', 'app-install, viewer'];
  const connect = await runCliCapture(args, { env });
  expect(connect.code, connect.stderr || connect.stdout).toBeNull();
  expect(connect.stdout).toContain('Using provider-a. limrun was unavailable.');
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toMatchObject({
    platform: 'ios',
    needs: ['app-install', 'viewer'],
  });
  const json = await runCliCapture([...args, '--json'], { env: cloudEnv() });
  expect(json.code).toBeNull();
  expect(JSON.parse(json.stdout).data).toMatchObject({
    vendor: 'provider-a',
    fallbackFrom: ['limrun'],
  });
});

test('sends --device and --os in the create body only when given', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  const args = ['connect', 'cloud', '--platform', 'ios', '--device', 'iphone-duo', '--os', '27'];
  const connect = await runCliCapture(args, { env });
  expect(connect.code, connect.stderr || connect.stdout).toBeNull();
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toMatchObject({
    platform: 'ios',
    device: 'iphone-duo',
    os: 'iOS 27',
  });
  await runCliCapture(['disconnect', '--json'], { env });
  const explicit = await runCliCapture(
    ['connect', 'cloud', '--platform', 'ios', '--os', 'iOS 26'],
    { env: cloudEnv() },
  );
  expect(explicit.code, explicit.stderr || explicit.stdout).toBeNull();
  expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1].body))).toEqual({
    platform: 'ios',
    os: 'iOS 26',
    accepts: ['agent-device-daemon'],
  });
});

test('shows the viewer only by request and preserves the connection after a failed DELETE', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  const open = vi.spyOn(browserLaunch, 'openUrlInBrowser').mockResolvedValue(true);
  const connect = await runCliCapture(
    ['connect', 'cloud', '--platform', 'ios', '--show-viewer', '--json'],
    { env },
  );
  expect(connect.code, connect.stderr || connect.stdout).toBeNull();
  expect(open).toHaveBeenCalledWith(hostedDevice.viewerUrl);
  expect(connect.stdout + connect.stderr).not.toContain(hostedDevice.viewerUrl);

  const duplicate = await runCliCapture(['connect', 'cloud', '--platform', 'ios', '--json'], {
    env,
  });
  expect(duplicate.code).toBe(1);
  expect(fetchMock).toHaveBeenCalledOnce();

  fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBe(1);
  const stateDir = env.AGENT_DEVICE_STATE_DIR;
  expect(readRemoteConnectionState({ stateDir, session: sessionName })?.cloudSession?.id).toBe(
    hostedDevice.id,
  );
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  expect(readRemoteConnectionState({ stateDir, session: sessionName })).toBeNull();
});

test('connect and status report when there is no viewer', async () => {
  const env = cloudEnv();
  stubCloudApi().mockResolvedValueOnce(Response.json({ ...hostedDevice, viewerUrl: undefined }));
  for (const args of [connectArgs, ['connection', 'status', '--json']]) {
    expect(JSON.parse((await runCliCapture(args, { env })).stdout).data.viewerAvailable).toBe(
      false,
    );
  }
});

test('requires an explicit API key before contacting a custom origin with a stored login', async () => {
  const env = cloudEnv();
  writeCliSession({
    stateDir: env.AGENT_DEVICE_STATE_DIR,
    session: {
      version: 2,
      id: 'saved-login',
      cloudBaseUrl: 'https://login.example',
      refreshCredential: 'saved-refresh-credential',
      createdAt: new Date().toISOString(),
    },
  });
  const configPath = path.join(env.AGENT_DEVICE_STATE_DIR, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ daemonAuthToken: 'configured-daemon-token' }));
  const fetchMock = stubCloudApi();
  const withoutKey = {
    ...env,
    AGENT_DEVICE_CONFIG: configPath,
    AGENT_DEVICE_CLOUD_API_KEY: undefined,
  };
  for (const args of [connectArgs, ['connect', '--platform', 'ios', '--json']]) {
    const refused = await runCliCapture(args, { env: withoutKey });
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout).error).toMatchObject({
      code: 'UNAUTHORIZED',
      details: { reason: 'cloud_login_origin_mismatch' },
    });
  }
  expect(fetchMock).not.toHaveBeenCalled();
  const connected = await runCliCapture(connectArgs, {
    env: { ...withoutKey, AGENT_DEVICE_CLOUD_API_KEY: 'explicit-key' },
  });
  expect(connected.code).toBeNull();
  expect(new Headers(fetchMock.mock.calls[0]?.[1].headers).get('authorization')).toBe(
    'Bearer explicit-key',
  );
  const refused = await runCliCapture(['disconnect', '--json'], { env: withoutKey });
  expect(JSON.parse(refused.stdout).error).toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'cloud_login_origin_mismatch' },
  });
  expect(fetchMock).toHaveBeenCalledOnce();
});

test('persists intent before POST and reuses its key after a timed-out connect', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  timeOutNextCreate(fetchMock, undefined, () => {
    expect(readCloudConnection(location)).toMatchObject({
      phase: 'pending',
      origin: 'https://cloud.example',
      fingerprint: expect.any(String),
    });
    expect(JSON.stringify(readCloudConnection(location))).not.toContain(
      env.AGENT_DEVICE_CLOUD_API_KEY,
    );
  });

  const timedOut = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(timedOut.stdout).error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'cloud_session_connect_timeout' },
  });
  const incompatible = await runCliCapture([...connectArgs, '--max-minutes', '30', '--force'], {
    env,
  });
  expect(JSON.parse(incompatible.stdout).error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'cloud_connect_pending_conflict' },
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  fetchMock.mockResolvedValueOnce(Response.json(hostedDevice, { status: 200 }));
  const resumed = await runCliCapture(connectArgs, { env });
  expect(resumed.code).toBeNull();
  const keys = fetchMock.mock.calls.map(([, init]) => postKey(init));
  expect(keys).toEqual([expect.any(String), keys[0]]);
  expect(readCloudConnection(location)).toMatchObject({ phase: 'committed', id: hostedDevice.id });
});

test('disconnect uses an observed ID and retains it when DELETE fails', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  timeOutNextCreate(
    fetchMock,
    Response.json(
      { error: 'allocation_in_progress', id: hostedDevice.id },
      {
        status: 409,
      },
    ),
  );
  const timedOut = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(timedOut.stdout).error.details.reason).toBe('cloud_session_connect_timeout');
  expect(readCloudConnection(location)?.id).toBe(hostedDevice.id);
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
  const failed = await runCliCapture(['disconnect', '--json'], { env });
  expect(JSON.parse(failed.stdout).error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { status: 503 },
  });
  expect(readCloudConnection(location)?.id).toBe(hostedDevice.id);
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url.pathname])).toEqual([
    ['POST', '/v1/sessions'],
    ['DELETE', '/v1/sessions/00000000-0000-4000-8000-000000000001'],
    ['DELETE', '/v1/sessions/00000000-0000-4000-8000-000000000001'],
  ]);
  expect(readCloudConnection(location)).toBeNull();
});

test.each([
  { status: 200, state: 'running', deletes: true },
  { status: 200, state: 'allocating', deletes: true },
  { status: 200, state: 'failed', deletes: false },
  { status: 200, state: 'settled', deletes: false },
  { status: 404, state: undefined, deletes: false },
])(
  'disconnect looks up an unknown allocation with GET ($status, state $state, DELETE $deletes)',
  async ({ status, state, deletes }) => {
    const env = cloudEnv();
    const location = locationOf(env);
    const fetchMock = stubCloudApi();
    timeOutNextCreate(fetchMock);
    const timedOut = await runCliCapture(connectArgs, { env });
    expect(JSON.parse(timedOut.stdout).error.details.reason).toBe('cloud_session_connect_timeout');
    expect(readCloudConnection(location)?.id).toBeUndefined();
    fetchMock.mockResolvedValueOnce(
      Response.json(status === 404 ? { error: 'not_found' } : { id: hostedDevice.id, state }, {
        status,
      }),
    );
    expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
    const [, first] = fetchMock.mock.calls[0]!;
    const [lookup, recovery] = fetchMock.mock.calls[1]!;
    expect(lookup.searchParams.get('idempotencyKey')).toBe(postKey(first));
    expect(recovery.body).toBeUndefined();
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(
      deletes ? ['POST', 'GET', 'DELETE'] : ['POST', 'GET'],
    );
    expect(readCloudConnection(location)).toBeNull();
  },
);

test.each([
  { status: 400, reason: 'invalid_request', code: 'COMMAND_FAILED', clears: true },
  { status: 402, reason: 'insufficient_balance', code: 'INVALID_ARGS', clears: true },
  { status: 422, reason: 'no_vendor_matches', code: 'COMMAND_FAILED', clears: true },
  { status: 409, reason: 'session_not_running', code: 'COMMAND_FAILED', clears: true },
  { status: 409, reason: 'session_not_running', code: 'COMMAND_FAILED', clears: false },
  { status: 409, reason: 'other_conflict', code: 'COMMAND_FAILED', clears: false },
])(
  'create rejection $status $reason clears pending state ($clears)',
  async ({ status, reason, code, clears }) => {
    const env = cloudEnv();
    const fetchMock = stubCloudApi();
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: reason,
          message: 'The cloud session is no longer running.',
        },
        { status },
      ),
    );
    if (clears) {
      fetchMock.mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));
    }
    const refused = await runCliCapture(connectArgs, { env });
    expect(JSON.parse(refused.stdout).error).toMatchObject({
      code,
      details: { status, ...(reason === 'other_conflict' ? {} : { reason }) },
    });
    if (reason === 'other_conflict') expect(refused.stdout).not.toContain(reason);
    if (clears) {
      const [url, init] = fetchMock.mock.calls[1]!;
      expect(init.method).toBe('GET');
      expect(url.searchParams.get('idempotencyKey')).toBe(postKey(fetchMock.mock.calls[0]![1]));
    }
    expect(readCloudConnection(locationOf(env))?.phase).toBe(clears ? undefined : 'pending');
  },
);

test.each(['pending', 'committed', 'closing'] as const)(
  'dispatch refuses a local route when cloud ownership becomes %s after resolution',
  async (phase) => {
    const env = cloudEnv();
    const location = locationOf(env);
    const resolveDefaults = commandConnection.resolveCommandConnection;
    vi.spyOn(commandConnection, 'resolveCommandConnection').mockImplementationOnce((options) => {
      const defaults = resolveDefaults(options);
      const record = prepareCloudConnection(
        location.session,
        {
          platform: 'ios',
          vendor: undefined,
          accepts: ['agent-device-daemon'],
          maxMinutes: undefined,
        },
        env.AGENT_DEVICE_CLOUD_BASE_URL,
        null,
      );
      writeCloudConnection(location, { ...record, phase });
      return defaults;
    });
    const blocked = await runCliCapture(['open', 'com.apple.Preferences', '--json'], { env });
    expect(JSON.parse(blocked.stdout).error).toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'cloud_connection_owns_session' },
    });
    expect(blocked.calls).toEqual([]);
  },
);

test('refuses dispatch while an allocation holds the named session lock', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  await withConnectionLock(location.stateDir, location.session, async () => {
    writeCloudConnection(
      location,
      prepareCloudConnection(
        location.session,
        {
          platform: 'ios',
          vendor: undefined,
          accepts: ['agent-device-daemon'],
          maxMinutes: undefined,
        },
        env.AGENT_DEVICE_CLOUD_BASE_URL,
        null,
      ),
    );
    const blocked = await runCliCapture(['snapshot', '--json'], { env });
    expect(JSON.parse(blocked.stdout).error.details.reason).toBe('cloud_connection_owns_session');
    expect(blocked.calls).toEqual([]);
  });
});

for (const scope of ['named', 'default']) {
  test(`CLI keeps the ${scope} local RPC on its existing daemon when cloud ownership appears during preparation`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const daemon = await startRegisteredHttpDaemon();
    const env = {
      ...cloudEnv(),
      AGENT_DEVICE_STATE_DIR: daemon.stateDir,
      AGENT_DEVICE_SESSION: scope === 'default' ? undefined : sessionName,
    };
    const location = { stateDir: daemon.stateDir, session: env.AGENT_DEVICE_SESSION ?? 'default' };
    const prepareArtifacts = daemonArtifacts.prepareRemoteRequestArtifacts;
    const prepare = vi
      .spyOn(daemonArtifacts, 'prepareRemoteRequestArtifacts')
      .mockImplementationOnce(async (...args) => {
        await withConnectionLock(location.stateDir, location.session, async () => {
          writeCloudConnection(
            location,
            prepareCloudConnection(
              location.session,
              {
                platform: 'ios',
                vendor: undefined,
                accepts: ['agent-device-daemon'],
                maxMinutes: undefined,
              },
              env.AGENT_DEVICE_CLOUD_BASE_URL,
              null,
            ),
          );
        });
        return await prepareArtifacts(...args);
      });
    try {
      const blocked = await runCliCapture(['open', 'com.apple.Preferences', '--json'], {
        env,
        useRealDaemonClient: true,
      });
      expect(prepare).toHaveBeenCalledOnce();
      expect(readCloudConnection(location)?.phase).toBe('pending');
      expect(blocked.code).toBeNull();
      expect(daemon.commands()).toEqual(['open']);
    } finally {
      await daemon.close();
    }
  });
}

test('connect refuses a non-loopback plaintext cloud origin before sending the API key', async () => {
  const env = { ...cloudEnv(), AGENT_DEVICE_CLOUD_BASE_URL: 'http://cloud.example' };
  const fetchMock = stubCloudApi();
  const refused = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(refused.stdout).error).toMatchObject({
    code: 'INVALID_ARGS',
    details: { reason: 'cloud_invalid_origin' },
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('disconnect refuses a different session exposed by a case-insensitive state path', async () => {
  const env = { ...cloudEnv(), AGENT_DEVICE_SESSION: 'QA' };
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const state = readRemoteConnectionState(location)!;
  const connections = path.join(location.stateDir, 'remote-connections');
  const lower = path.join(connections, 'qa.json');
  fs.writeFileSync(lower, JSON.stringify(state));

  const refused = await runCliCapture(['disconnect', '--session', 'qa', '--json'], { env });
  expect(JSON.parse(refused.stdout).error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'connection_session_mismatch' },
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(readCloudConnection(location)).toMatchObject({ session: 'QA', phase: 'committed' });
  fs.rmSync(lower);
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'DELETE']);
});

test('disconnect refuses a cloud record whose saved session does not own the directory', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const record = readCloudConnection(location)!;
  fs.writeFileSync(
    path.join(cloudConnectionDir(location), 'record.json'),
    JSON.stringify({
      ...record,
      session: location.session.toUpperCase(),
    }),
  );

  const refused = await runCliCapture(['disconnect', '--json'], { env });
  expect(JSON.parse(refused.stdout).error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'cloud_connection_session_mismatch' },
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fs.existsSync(cloudAttachmentPath(location))).toBe(true);
});

test('a failed forced direct replacement leaves the cloud rental usable', async () => {
  const env = { ...cloudEnv(), TEST_CLOUD_PLUGIN: '1' };
  const fetchMock = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const failed = await runCliCapture(
    ['connect', 'limrun', '--platform', 'ios', '--force', '--json'],
    {
      env: {
        ...env,
        LIMRUN_API_KEY: undefined,
        LIM_IOS_INSTANCE_URL: undefined,
        LIM_IOS_INSTANCE_TOKEN: undefined,
      },
    },
  );
  expect(JSON.parse(failed.stdout).error).toMatchObject({ code: 'INVALID_ARGS' });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(readRemoteConnectionState(locationOf(env))?.cloudSession?.id).toBe(hostedDevice.id);
  expect(readCloudConnection(locationOf(env))?.phase).toBe('committed');
  const used = await runCliCapture(['snapshot', '--json'], { env });
  expect(used.code).toBeNull();
  expect(used.calls.map((call) => call.command)).toEqual(['snapshot']);
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
});

test('a command holding a revoked attachment cannot write another hosted RPC', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const session = readRemoteConnectionState(location)!.cloudSession!;
  const attachment = await bindCloudAttachment({
    location,
    session,
    host: createTestHostEnvironment(),
    flags: { help: false, json: true, version: false, session: sessionName },
  });
  expect(attachment.flags.daemonAuthToken).toBe(hostedDevice.attach.daemonAuthToken);
  const admit = (await activeConnection.resolveCloudAdmission({
    host: createTestHostEnvironment(),
    ...location,
    command: 'open',
    usesSessions: true,
    binding: session,
  }))!;
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  const startDaemon = vi.fn(async () => {});
  await expect(admit(startDaemon, 'dispatch')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'cloud_connection_changed' },
  });
  expect(startDaemon).not.toHaveBeenCalled();
});

test('disconnect recovers a credential file left by interrupted publication', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  const writeFile = fs.writeFileSync;
  const attachmentBeforeCommit = vi.fn();
  vi.spyOn(fs, 'writeFileSync').mockImplementation((destination, contents, options) => {
    if (destination === cloudAttachmentPath(location)) {
      attachmentBeforeCommit(readCloudConnection(location), fs.existsSync(destination));
    }
    writeFile(destination, contents, options);
  });
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  expect(attachmentBeforeCommit).toHaveBeenCalledWith(
    expect.objectContaining({ phase: 'pending', id: hostedDevice.id }),
    false,
  );
  await withConnectionLock(location.stateDir, sessionName, async () => {
    writeCloudConnection(location, { ...readCloudConnection(location)!, phase: 'pending' });
  });
  const blocked = await runCliCapture(['open', 'com.apple.Preferences', '--json'], { env });
  expect(JSON.parse(blocked.stdout).error.details.reason).toBe('cloud_connection_changed');
  expect(blocked.calls).toEqual([]);
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url.pathname])).toEqual([
    ['POST', '/v1/sessions'],
    ['DELETE', '/v1/sessions/00000000-0000-4000-8000-000000000001'],
  ]);
  expect(fs.existsSync(cloudAttachmentPath(location))).toBe(false);
  expect(readCloudConnection(location)).toBeNull();
});

test('disconnect closes a cloud session while an admitted RPC is still in flight', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const admit = (await activeConnection.resolveCloudAdmission({
    host: createTestHostEnvironment(),
    ...location,
    command: 'open',
    usesSessions: true,
    binding: readRemoteConnectionState(location)?.cloudSession,
  }))!;
  const lateDispatch = vi.fn(async () => {});
  const opened = await runCliCapture(['open', 'com.apple.Preferences', '--json'], {
    env,
    sendToDaemon: async () => {
      fetchMock.mockImplementationOnce(async (_url, init) => {
        expect(init.method).toBe('DELETE');
        expect(readCloudConnection(location)?.phase).toBe('closing');
        return new Response(null, { status: 204 });
      });
      expect(
        await disconnectCommand({
          flags: {
            help: false,
            json: true,
            version: false,
            stateDir: location.stateDir,
            session: location.session,
          },
          positionals: [],
          client: createTestClient(),
          host: createTestHostEnvironment({ env }),
        }),
      ).toBe(true);
      await expect(admit(lateDispatch, 'dispatch')).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: { reason: 'cloud_connection_changed' },
      });
      return { ok: true, data: {} };
    },
  });
  expect(opened.code).toBeNull();
  expect(opened.calls.map(({ command }) => command)).toEqual(['open']);
  expect(lateDispatch).not.toHaveBeenCalled();
  expect(readCloudConnection(location)).toBeNull();
});

test('a connection command sweeps expired attachments for other sessions in its state directory', async () => {
  const env = cloudEnv();
  const otherState = cloudEnv();
  const liveEnv = { ...env, AGENT_DEVICE_SESSION: 'still-running' };
  const fetchMock = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  expect((await runCliCapture(connectArgs, { env: otherState })).code).toBeNull();
  fetchMock.mockResolvedValueOnce(
    Response.json(
      {
        ...hostedDevice,
        id: '00000000-0000-4000-8000-000000000003',
        deadlineAt: new Date(Date.parse(hostedDevice.deadlineAt) + 60_000).toISOString(),
      },
      { status: 201 },
    ),
  );
  expect((await runCliCapture(connectArgs, { env: liveEnv })).code).toBeNull();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(hostedDevice.deadlineAt) + 1);
  const run = await runCliCapture(['connection', 'status', '--json'], { env: liveEnv });
  expect(run.code).toBeNull();
  expect(fs.existsSync(cloudAttachmentPath(locationOf(env)))).toBe(false);
  expect(fs.existsSync(cloudAttachmentPath(locationOf(liveEnv)))).toBe(true);
  expect(fs.existsSync(cloudAttachmentPath(locationOf(otherState)))).toBe(true);
  expect(readCloudConnection(locationOf(env))?.phase).toBe('committed');
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('a malformed expired record does not block a different session', async () => {
  const env = cloudEnv();
  const expired = locationOf(env);
  const liveEnv = { ...env, AGENT_DEVICE_SESSION: 'still-running' };
  const broker = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  expect((await runCliCapture(connectArgs, { env: liveEnv })).code).toBeNull();
  const record = readCloudConnection(expired)!;
  fs.writeFileSync(
    path.join(cloudConnectionDir(expired), 'record.json'),
    JSON.stringify({ ...record, generation: null, deadlineAt: new Date(0).toISOString() }),
  );

  const run = await runCliCapture(['connection', 'status', '--json'], { env: liveEnv });

  expect(run.code).toBeNull();
  expect(fs.existsSync(cloudAttachmentPath(expired))).toBe(true);
  expect(fs.existsSync(cloudAttachmentPath(locationOf(liveEnv)))).toBe(true);
  expect(broker).toHaveBeenCalledTimes(2);
});

test('expiry removes scoped credentials and refuses to route the command', async () => {
  const env = cloudEnv();
  const location = locationOf(env);
  stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const attachment = cloudAttachmentPath(location);
  if (process.platform !== 'win32') expect(fs.statSync(attachment).mode & 0o777).toBe(0o600);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(hostedDevice.deadlineAt) + 1);
  const expired = await runCliCapture(['snapshot', '-i', '--json'], { env });
  expect(JSON.parse(expired.stdout).error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'cloud_connection_expired' },
  });
  expect(expired.calls).toEqual([]);
  expect(fs.existsSync(attachment)).toBe(false);
});

test('rolls back a malformed allocation whose ID was observed', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi({ ...hostedDevice, platform: 'android' });
  const invalid = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(invalid.stdout).error.details.reason).toBe('cloud_session_invalid');
  expect(fetchMock.mock.calls.map(([url, init]) => [init.method, url.pathname])).toEqual([
    ['POST', '/v1/sessions'],
    ['DELETE', '/v1/sessions/00000000-0000-4000-8000-000000000001'],
  ]);
  expect(readCloudConnection(locationOf(env))).toBeNull();
});

test.each([
  ['http://unsafe.example', 'cloud_invalid_origin'],
  ['https://other.example', 'cloud_login_origin_mismatch'],
])('disconnect refuses saved login issuer %s before any auth request', async (issuer, reason) => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  writeCliSession({
    stateDir: env.AGENT_DEVICE_STATE_DIR,
    session: {
      version: 2,
      id: 'fixture-session',
      cloudBaseUrl: issuer,
      refreshCredential: 'fixture-refresh-token',
      createdAt: new Date().toISOString(),
    },
  });
  fetchMock.mockClear();
  const result = await runCliCapture(['disconnect', '--json'], {
    env: {
      ...env,
      AGENT_DEVICE_CLOUD_BASE_URL: undefined,
      AGENT_DEVICE_CLOUD_API_KEY: undefined,
    },
  });
  expect(JSON.parse(result.stdout).error.details.reason).toBe(reason);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(readCloudConnection(locationOf(env))?.id).toBe(hostedDevice.id);
});

test.skipIf(process.platform === 'win32').each(['symlink', 'writable'])(
  'refuses a %s credential directory before sending a create request',
  async (kind) => {
    const env = cloudEnv();
    const location = locationOf(env);
    const directory = cloudConnectionDir(location);
    fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
    if (kind === 'symlink') {
      fs.symlinkSync(mkdtempForTestSync('untrusted-cloud-dir-'), directory, 'dir');
    } else {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.chmodSync(directory, 0o777);
    }
    const fetchMock = stubCloudApi();
    const result = await runCliCapture(connectArgs, { env });
    expect(JSON.parse(result.stdout).error.details.reason).toBe('cloud_credential_store_unsafe');
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test.skipIf(process.platform === 'win32')(
  'credential writes refuse a state root another local user could modify',
  () => {
    const env = cloudEnv();
    const location = locationOf(env);
    fs.chmodSync(location.stateDir, 0o777);
    const record = prepareCloudConnection(
      location.session,
      {
        platform: 'ios',
        accepts: ['agent-device-daemon'],
        vendor: undefined,
        maxMinutes: undefined,
      },
      env.AGENT_DEVICE_CLOUD_BASE_URL,
      null,
    );
    expect(() => writeCloudConnection(location, record)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'cloud_credential_store_unsafe' }),
      }),
    );
    expect(fs.existsSync(cloudConnectionDir(location))).toBe(false);
  },
);

test('a direct leased disconnect consumes endedLeases without reacquiring its connection lock', async () => {
  const workspace = proxyWorkspace('direct-disconnect-lock-', { leaseId: 'fixture-lease' });
  const provider = { warnings: [{ code: 'fixture', message: 'provider closed the session' }] };
  const result = await runCliCapture(
    [
      'disconnect',
      '--session',
      workspace.flags.session,
      '--state-dir',
      workspace.stateDir,
      '--json',
    ],
    {
      sendToDaemon: async (request) => ({
        ok: true,
        data:
          request.command === 'close'
            ? {
                session: workspace.flags.session,
                endedLeases: [{ leaseId: 'fixture-lease', outcome: 'released' }],
                provider,
              }
            : { released: true },
      }),
    },
  );
  expect(result.code, result.stdout + result.stderr).toBeNull();
  expect(JSON.parse(result.stdout).data).toMatchObject({ provider });
});

test('a current API key cannot follow a saved lease to another origin', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  fetchMock.mockClear();
  const result = await runCliCapture(['disconnect', '--json'], {
    env: {
      ...env,
      AGENT_DEVICE_CLOUD_BASE_URL: undefined,
      AGENT_DEVICE_CLOUD_API_KEY_ORIGIN: undefined,
      AGENT_DEVICE_CLOUD_API_KEY: 'default-cloud-key',
    },
  });
  expect(JSON.parse(result.stdout).error.details.reason).toBe('cloud_origin_mismatch');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(readCloudConnection(locationOf(env))?.id).toBe(hostedDevice.id);
});

test('refuses a broker bearer offered as an attachment token', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  fetchMock.mockResolvedValueOnce(
    Response.json({
      ...hostedDevice,
      attach: { ...hostedDevice.attach, daemonAuthToken: env.AGENT_DEVICE_CLOUD_API_KEY },
    }),
  );
  const result = await runCliCapture(connectArgs, { env });
  expect(JSON.parse(result.stdout).error.details.reason).toBe('cloud_session_invalid');
  expect(result.stdout + result.stderr).not.toContain(env.AGENT_DEVICE_CLOUD_API_KEY);
  expect(fs.existsSync(cloudAttachmentPath(locationOf(env)))).toBe(false);
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'DELETE']);
});

test('retains an unknown attempt when lookup only returns a bare 404', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  timeOutNextCreate(fetchMock);
  expect((await runCliCapture(connectArgs, { env })).code).toBe(1);
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBe(1);
  expect(readCloudConnection(locationOf(env))).toMatchObject({ phase: 'closing' });
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET']);
});

test('an inconclusive create refusal keeps an already observed lease ID', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  timeOutNextCreate(
    fetchMock,
    Response.json(
      {
        error: 'allocation_in_progress',
        id: hostedDevice.id,
      },
      { status: 409 },
    ),
  );
  expect((await runCliCapture(connectArgs, { env })).code).toBe(1);
  fetchMock.mockResolvedValueOnce(Response.json({ error: 'rate_limited' }, { status: 429 }));
  expect((await runCliCapture(connectArgs, { env })).code).toBe(1);
  expect(readCloudConnection(locationOf(env))?.id).toBe(hostedDevice.id);
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  expect(fetchMock.mock.calls.at(-1)?.[0].pathname).toBe(`/v1/sessions/${hostedDevice.id}`);
});

test('an invalid ID cannot replace an attempt key or enter a DELETE URL', async () => {
  const env = cloudEnv();
  const fetchMock = stubCloudApi();
  fetchMock.mockResolvedValueOnce(Response.json({ ...hostedDevice, id: '\ud800' }));
  expect((await runCliCapture(connectArgs, { env })).code).toBe(1);
  expect(readCloudConnection(locationOf(env))).toMatchObject({ phase: 'pending' });
  expect(readCloudConnection(locationOf(env))?.id).toBeUndefined();
  fetchMock.mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET']);
});

test.each([true, false])('refuses scoped attachment token echoes (RPC success %s)', async (ok) => {
  const env = cloudEnv();
  stubCloudApi();
  expect((await runCliCapture(connectArgs, { env })).code).toBeNull();
  const token = hostedDevice.attach.daemonAuthToken;
  const result = await runCliCapture(['snapshot', '--json'], {
    env,
    sendToDaemon: async () =>
      ok
        ? { ok: true, data: { nodes: [{ text: token }] } }
        : { ok: false, error: { code: 'COMMAND_FAILED', message: `peer echoed ${token}` } },
  });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error.message).toBe(
    'The hosted daemon returned an invalid response.',
  );
  expect(result.stdout + result.stderr).not.toContain(token);
});
