import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { startDaemonRuntime } from '@agent-device/daemon';
import { readRegisteredDaemon, sendDaemonRequest } from '@agent-device/daemon-client';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { tryAcquireDaemonRegistration } from '@agent-device/daemon-contracts/daemon-registration-owner';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import {
  readRemoteConnectionState,
  removeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import * as browserLaunch from '../cli/browser-launch.ts';
import { bindCloudAttachment, bindHostedDaemon } from '../cli/connection/cloud-attachment.ts';
import {
  cloudAttachmentPath,
  readCloudConnection,
  writeCloudConnection,
} from '../cli/connection/cloud-connection-record.ts';
import { resolveCloudAdmission } from '../cli/connection/active-connection.ts';
import { cloudLimrunDaemonDir } from '../cli/connection/cloud-limrun.ts';
import { materializeRemoteConnectionForCommand } from '../cli/commands/connection-runtime.ts';
import { createTestClient, grantedLease } from './remote-connection.fixtures.ts';
import { runCliCapture } from './cli-capture.ts';
import { cloudEnv, hostedDevice, locationOf, stubCloudApi } from './cli-cloud-session.fixtures.ts';
import { createDaemonRuntimeDeps } from '../daemon-composition.ts';

const { stop } = vi.hoisted(() => ({ stop: vi.fn(async () => undefined) }));

vi.mock('@agent-device/daemon-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/daemon-client')>()),
  stopRecordedDaemon: stop,
}));

vi.mock('@agent-device/plugins/store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agent-device/plugins/store')>();
  const { limrunPluginCandidate } = await import('./test-utils/limrun-plugin-store.ts');
  return {
    ...original,
    storePluginCandidates: async (env: NodeJS.ProcessEnv) => {
      if (!env.TEST_HOSTED_LIMRUN) return [];
      const candidate = limrunPluginCandidate();
      if (env.TEST_HOSTED_LIMRUN === 'current') return [candidate];
      if (env.TEST_HOSTED_LIMRUN === 'alias') return [{ ...candidate, package: 'other-provider' }];
      return [
        {
          ...candidate,
          load: async () => {
            const plugin = (await import('@agent-device/limrun')).default();
            return {
              ...plugin,
              contributes: plugin.contributes.map((entry) => {
                if (entry.kind !== 'provider' || !entry.connection) return entry;
                const { acceptsHostedAttachment: _introduced, ...capabilities } =
                  entry.connection.capabilities;
                return { ...entry, connection: { ...entry.connection, capabilities } };
              }),
            };
          },
        },
      ];
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  stop.mockReset();
});

const instance = 'https://instance.example';
const scopedToken = 'fixture-instance-credential';
const adb = 'wss://instance.example/adb';

function limrunLease(platform: 'ios' | 'android') {
  return {
    ...hostedDevice,
    vendor: 'limrun',
    transport: 'limrun',
    platform,
    attach: {
      kind: 'limrun',
      platform,
      apiUrl: instance,
      token: scopedToken,
      ...(platform === 'android' ? { adbWebSocketUrl: adb } : {}),
    },
  };
}

function limrunEnv(version?: 'current' | 'old' | 'alias') {
  return {
    ...cloudEnv(),
    AGENT_DEVICE_HOME: mkdtempForTestSync('hosted-limrun-home-'),
    TEST_HOSTED_LIMRUN: version,
    LIMRUN_API_KEY: 'fixture-ambient-account-key',
    LIMRUN_KEEP_ALIVE: '1',
    LIM_IOS_INSTANCE_TOKEN: 'fixture-ambient-ios',
    LIM_ANDROID_INSTANCE_TOKEN: 'fixture-ambient-android',
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'fixture-unrelated-daemon-key',
  };
}

const args = (platform: 'ios' | 'android') => [
  'connect',
  'cloud',
  '--platform',
  platform,
  '--json',
];

test.each([undefined, 'old', 'alias'] as const)(
  'skips Limrun offers when plugin version is %s',
  async (version) => {
    const mock = stubCloudApi();
    const result = await runCliCapture(args('ios'), { env: limrunEnv(version) });
    expect(result.code, result.stderr || result.stdout).toBeNull();
    expect(JSON.parse(String(mock.mock.calls[0]?.[1].body)).accepts).toEqual([
      'agent-device-daemon',
    ]);
  },
);

test.each([undefined, 'current'] as const)(
  'keeps the transport offer of a pending allocation after plugin inventory changes (%s)',
  async (firstVersion) => {
    const env = limrunEnv(firstVersion);
    const mock = stubCloudApi();
    mock.mockResolvedValueOnce(Response.json({ ...hostedDevice, id: 'bad id' }));
    expect((await runCliCapture(args('ios'), { env })).code).toBe(1);
    const pending = readCloudConnection(locationOf(env));
    expect(pending?.phase).toBe('pending');
    const changedEnv = {
      ...env,
      AGENT_DEVICE_HOME: mkdtempForTestSync('changed-hosted-limrun-home-'),
      TEST_HOSTED_LIMRUN: firstVersion ? undefined : 'current',
    };
    const retried = await runCliCapture(args('ios'), { env: changedEnv });
    expect(retried.code, retried.stdout).toBeNull();
    expect(mock.mock.calls).toHaveLength(2);
    expect(mock.mock.calls[1]?.[1].body).toBe(mock.mock.calls[0]?.[1].body);
    expect(new Headers(mock.mock.calls[1]?.[1].headers).get('idempotency-key')).toBe(
      pending?.generation,
    );
  },
);

test('fences and retires the attachment before a missing broker credential prevents release', async () => {
  const env = limrunEnv('current');
  const location = locationOf(env);
  const mock = stubCloudApi();
  mock.mockResolvedValueOnce(Response.json(limrunLease('ios'), { status: 201 }));
  expect((await runCliCapture(args('ios'), { env })).code).toBeNull();
  const result = await runCliCapture(['disconnect', '--json'], {
    env: { ...env, AGENT_DEVICE_CLOUD_API_KEY: undefined },
  });
  expect(JSON.parse(result.stdout).error.details.reason).toBe('cloud_api_key_required');
  expect(readCloudConnection(location)).toMatchObject({ phase: 'closing', id: hostedDevice.id });
  expect(fs.existsSync(cloudAttachmentPath(location))).toBe(false);
  expect(stop).toHaveBeenCalledOnce();
  expect(mock.mock.calls).toHaveLength(1);
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  expect(mock.mock.calls[1]?.[1].method).toBe('DELETE');
});

test('expired attachments without a saved binding retire their generation before removing credentials', async () => {
  const env = limrunEnv('current');
  const location = locationOf(env);
  const broker = stubCloudApi();
  broker.mockResolvedValueOnce(Response.json(limrunLease('ios'), { status: 201 }));
  expect((await runCliCapture(args('ios'), { env })).code).toBeNull();
  const record = readCloudConnection(location)!;
  writeCloudConnection(location, { ...record, deadlineAt: new Date(0).toISOString() });
  removeRemoteConnectionState(location);

  const sweep = () =>
    resolveCloudAdmission({
      command: 'connect',
      usesSessions: true,
      stateDir: location.stateDir,
      host: createTestHostEnvironment({ env }),
      session: location.session,
      binding: undefined,
    });
  const credential = cloudAttachmentPath(location);
  const logPath = path.join(location.stateDir, 'expired-retirement.ndjson');
  stop.mockRejectedValueOnce(new Error('private retirement failure'));
  await withDiagnosticsScope({ debug: true, logPath }, sweep);
  const diagnostics = fs.readFileSync(logPath, 'utf8');
  expect(diagnostics).toContain('cloud_attachment_daemon_stop_unconfirmed');
  expect(diagnostics).toContain('Run agent-device disconnect again');
  expect(diagnostics).not.toContain('private retirement failure');
  expect(stop).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({
      paths: expect.objectContaining({ baseDir: cloudLimrunDaemonDir(location, record) }),
    }),
  );
  expect(fs.existsSync(credential)).toBe(true);

  await sweep();
  expect(stop).toHaveBeenCalledTimes(2);
  expect(fs.existsSync(credential)).toBe(false);
});

test('disconnect preserves recovery when a startup owns the lock before publishing a registration', async () => {
  const env = limrunEnv('current');
  const location = locationOf(env);
  const mock = stubCloudApi();
  mock.mockResolvedValueOnce(Response.json(limrunLease('ios'), { status: 201 }));
  expect((await runCliCapture(args('ios'), { env })).code).toBeNull();
  const state = readRemoteConnectionState(location)!;
  const attached = await bindCloudAttachment({
    location,
    session: state.cloudSession!,
    host: createTestHostEnvironment({ env }),
    flags: { help: false, json: true, version: false },
  });
  const paths = resolveDaemonPaths(attached.daemonStateDir);
  fs.mkdirSync(paths.baseDir, { mode: 0o700 });
  const startup = await tryAcquireDaemonRegistration(paths);
  if (startup.status !== 'acquired') throw new Error('Could not hold the fixture startup lock.');
  try {
    expect(fs.existsSync(paths.infoPath)).toBe(false);
    const disconnect = await runCliCapture(['disconnect', '--json'], { env });
    expect(JSON.parse(disconnect.stdout).error?.details.reason).toBe(
      'cloud_attachment_daemon_stop_unconfirmed',
    );
    expect(readCloudConnection(location)).toMatchObject({
      phase: 'closing',
      brokerReleased: true,
      id: hostedDevice.id,
    });
    expect(stop).not.toHaveBeenCalled();
  } finally {
    await startup.owner.finish();
  }
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  expect(mock.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
});

test('hosted daemon ownership precedes credential read and bounds allocation over HTTP and socket', async () => {
  const env = limrunEnv('current');
  const location = locationOf(env);
  const mock = stubCloudApi();
  mock.mockResolvedValueOnce(Response.json(limrunLease('ios'), { status: 201 }));
  expect((await runCliCapture(args('ios'), { env })).code).toBeNull();
  vi.unstubAllGlobals();
  const state = readRemoteConnectionState(location)!;
  const attached = await bindCloudAttachment({
    location,
    session: state.cloudSession!,
    host: createTestHostEnvironment({ env }),
    flags: { help: false, json: true, version: false },
  });
  const paths = resolveDaemonPaths(attached.daemonStateDir);
  const host = createTestHostEnvironment({
    env: {
      ...attached.host.env,
      AGENT_DEVICE_STATE_DIR: paths.baseDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'dual',
    },
  });
  const captureAllocate = vi.fn(async () => undefined);
  const bindAttachment = vi.fn(async (stateDir: string) => {
    expect(fs.existsSync(paths.lockPath)).toBe(true);
    expect(fs.existsSync(paths.infoPath)).toBe(false);
    expect(host.env.LIM_IOS_INSTANCE_TOKEN).toBeUndefined();
    return bindHostedDaemon(host, stateDir);
  });
  const runtime = await startDaemonRuntime({
    host,
    bindAttachment,
    ownership: 'embedded',
    composeDeps: async (params) => {
      const deps = await createDaemonRuntimeDeps(params);
      return {
        ...deps,
        providerRuntimeIds: ['limrun'],
        leaseLifecycleProvider: {
          allocate: captureAllocate,
          release: async () => ({ release: 'confirmed' }),
        },
      };
    },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  try {
    const info = await readRegisteredDaemon(paths, { required: true });
    const admin = await fetch(`http://127.0.0.1:${info.httpPort}/admin/leases`, {
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    expect(admin.status).toBe(404);
    await admin.body?.cancel();
    const request: DaemonWireRequest = {
      session: location.session,
      token: runtime.token,
      command: 'lease_allocate',
      positionals: [],
      meta: {
        sessionExplicit: true,
        tenantId: state.tenant,
        runId: state.runId,
        leaseProvider: 'limrun',
        leaseBackend: state.leaseBackend,
        clientId: state.clientId,
        leaseId: attached.hostedLease?.id ?? '0'.repeat(32),
      },
    };
    const scopeError = { details: { reason: 'LEASE_SESSION_MISMATCH' } };
    for (const transport of ['http', 'socket'] as const) {
      const send = (req: DaemonWireRequest) =>
        sendDaemonRequest(info, req, transport, paths, 3_000, {
          host: createTestHostEnvironment(),
        });
      for (const refused of [
        { ...request, session: 'unrelated-session' },
        { ...request, meta: { ...request.meta, tenantId: 'unrelated-tenant' } },
        { ...request, meta: { ...request.meta, runId: 'unrelated-run' } },
        { ...request, meta: { ...request.meta, leaseId: undefined } },
        { ...request, command: 'snapshot', meta: { ...request.meta, leaseId: 'unrelated-lease' } },
      ]) {
        const result = await send(refused).catch((error: unknown) => ({ ok: false, error }));
        expect(result).toMatchObject({ ok: false, error: scopeError });
      }
      expect(captureAllocate).toHaveBeenCalledTimes(transport === 'http' ? 0 : 1);
      expect(await send(request)).toMatchObject({
        ok: true,
        data: { lease: { leaseId: attached.hostedLease?.id } },
      });
    }
    expect(bindAttachment).toHaveBeenCalledOnce();
    const listDevices = () =>
      runCliCapture(['devices', '--json'], {
        env,
        sendToDaemon: async (req) =>
          ['lease_allocate', 'lease_heartbeat'].includes(req.command)
            ? await sendDaemonRequest(
                info,
                { ...req, token: runtime.token },
                'socket',
                paths,
                3_000,
                { host },
              )
            : { ok: true, data: { devices: [] } },
      });
    const devices = await listDevices();
    expect(devices.code, devices.stdout).toBeNull();
    const settledId = attached.hostedLease?.id;
    expect(readRemoteConnectionState(location)?.leaseId).toBe(settledId);
    const released = await sendDaemonRequest(
      info,
      { ...request, command: 'lease_release' },
      'socket',
      paths,
      3_000,
      { host },
    );
    expect(released).toMatchObject({ ok: true, data: { released: true } });
    const reopened = await listDevices();
    expect(reopened.code, reopened.stdout).toBeNull();
    const replacement = readRemoteConnectionState(location)?.leaseId;
    expect(replacement).toEqual(expect.any(String));
    expect(replacement).not.toBe(settledId);
    expect(readCloudConnection(location)).toMatchObject({
      hostedLeaseId: replacement,
      generation: state.cloudSession?.generation,
    });
    expect(await sendDaemonRequest(info, request, 'socket', paths, 3_000, { host })).toMatchObject({
      ok: false,
      error: scopeError,
    });
    const releaseMock = stubCloudApi();
    const localOnly = await runCliCapture(['disconnect', '--json'], {
      env: { ...env, AGENT_DEVICE_CLOUD_API_KEY: undefined },
    });
    expect(localOnly.code).toBe(1);
    expect(releaseMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    expect(await sendDaemonRequest(info, request, 'socket', paths, 3_000, { host })).toMatchObject({
      ok: false,
      error: { details: { reason: 'cloud_connection_changed' } },
    });
  } finally {
    await runtime.close();
  }
});

test.each(['ios', 'android'] as const)(
  'binds only the scoped %s credential and tears down the generation before DELETE',
  async (platform) => {
    const env = limrunEnv('current');
    const location = locationOf(env);
    const mock = stubCloudApi();
    mock.mockResolvedValueOnce(Response.json(limrunLease(platform), { status: 201 }));
    const connected = await runCliCapture(args(platform), { env });
    expect(connected.code, connected.stderr || connected.stdout).toBeNull();
    expect(JSON.parse(String(mock.mock.calls[0]?.[1].body)).accepts).toEqual([
      'agent-device-daemon',
      'limrun',
    ]);
    expect(connected.stdout + connected.stderr).not.toContain(scopedToken);
    const saved = readRemoteConnectionState(location)!;
    expect(saved.cloudSession).toMatchObject({ transport: 'limrun', id: hostedDevice.id });
    expect(fs.readFileSync(saved.remoteConfigPath, 'utf8')).not.toContain(scopedToken);
    const attachmentFile = cloudAttachmentPath(location);
    expect(fs.statSync(attachmentFile).mode & 0o077).toBe(0);

    const bind = (suppliedEnv = env) =>
      bindCloudAttachment({
        host: createTestHostEnvironment({ env: suppliedEnv }),
        location,
        flags: { help: false, json: true, version: false },
        session: saved.cloudSession!,
      });
    const attached = await bind();
    const role = platform === 'ios' ? 'IOS' : 'ANDROID';
    const other = platform === 'ios' ? 'ANDROID' : 'IOS';
    expect(attached.host.env).toMatchObject({
      [`LIM_${role}_INSTANCE_TOKEN`]: undefined,
      [`LIM_${other}_INSTANCE_TOKEN`]: undefined,
      LIM_ANDROID_INSTANCE_ADB_URL: undefined,
      LIMRUN_HOSTED_ATTACHMENT_DEADLINE: undefined,
    });
    expect(attached.host.env.AGENT_DEVICE_HOSTED_ATTACHMENT).not.toContain(scopedToken);
    const daemon = bindHostedDaemon(attached.host, attached.daemonStateDir!);
    expect(daemon.host.env).toMatchObject({
      [`LIM_${role}_INSTANCE_URL`]: instance,
      [`LIM_${role}_INSTANCE_TOKEN`]: scopedToken,
      [`LIM_${other}_INSTANCE_TOKEN`]: undefined,
      LIM_ANDROID_INSTANCE_ADB_URL: platform === 'android' ? adb : undefined,
      LIMRUN_API_KEY: undefined,
      LIMRUN_KEEP_ALIVE: undefined,
      LIMRUN_HOSTED_ATTACHMENT_DEADLINE: hostedDevice.deadlineAt,
    });
    expect(attached.host.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN).toBeUndefined();
    expect(attached.host.env.AGENT_DEVICE_CLOUD_API_KEY).toBeUndefined();
    expect(attached.host.env.AGENT_DEVICE_CLOUD_API_KEY_ORIGIN).toBeUndefined();
    expect(attached.flags.daemonAuthToken).toBeUndefined();
    expect(attached.daemonStateDir).toMatch(/cloud-connections.*daemon-/);

    mock.mockImplementationOnce(async () => {
      expect(stop).toHaveBeenCalledOnce();
      expect(fs.existsSync(attachmentFile)).toBe(false);
      expect(readCloudConnection(location)?.phase).toBe('closing');
      return new Response(null, { status: 503 });
    });
    expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBe(1);
    expect(readCloudConnection(location)).toMatchObject({ phase: 'closing', id: hostedDevice.id });
    await expect(bind()).rejects.toMatchObject({
      details: { reason: 'cloud_connection_changed' },
    });
    expect(() => bindHostedDaemon(attached.host, attached.daemonStateDir!)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'cloud_connection_changed' }),
      }),
    );
    expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
    expect(readCloudConnection(location)).toBeNull();
    expect(mock.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(2);
  },
);

test('a stale materialization cannot overwrite the replacement cloud session', async () => {
  const env = limrunEnv('current');
  const location = locationOf(env);
  const fetchMock = stubCloudApi();
  fetchMock.mockResolvedValueOnce(Response.json(limrunLease('android'), { status: 201 }));
  expect(
    (await runCliCapture(['connect', 'cloud', '--platform', 'android', '--json'], { env })).code,
  ).toBeNull();
  const state = readRemoteConnectionState(location)!;
  let signalAllocating!: () => void;
  const allocating = new Promise<void>((resolve) => {
    signalAllocating = resolve;
  });
  let resumeAllocation!: () => void;
  const resume = new Promise<void>((resolve) => {
    resumeAllocation = resolve;
  });
  const materialized = materializeRemoteConnectionForCommand({
    host: createTestHostEnvironment(),
    command: 'open',
    flags: {
      help: false,
      json: true,
      version: false,
      session: location.session,
      stateDir: location.stateDir,
      remoteConfig: state.remoteConfigPath,
    },
    cloudGeneration: state.cloudSession?.generation,
    selection: { stateDir: location.stateDir, state, existing: true },
    client: createTestClient({
      allocate: async (request) => {
        signalAllocating();
        await resume;
        return grantedLease(request);
      },
    }),
  });
  const stale = expect(materialized).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'cloud_connection_changed' },
  });
  await Promise.race([allocating, materialized]);
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
  fetchMock.mockResolvedValueOnce(
    Response.json({ ...hostedDevice, id: '00000000-0000-4000-8000-000000000002' }, { status: 201 }),
  );
  expect((await runCliCapture(args('ios'), { env })).code).toBeNull();
  resumeAllocation();
  await stale;
  expect(readRemoteConnectionState(location)?.cloudSession?.id).toBe(
    '00000000-0000-4000-8000-000000000002',
  );
});

test('a failed local retirement still ends the hosted lease and preserves a fenced recovery record', async () => {
  const env = limrunEnv('current');
  const location = locationOf(env);
  const broker = stubCloudApi();
  broker.mockResolvedValueOnce(Response.json(limrunLease('ios'), { status: 201 }));
  expect((await runCliCapture(args('ios'), { env })).code).toBeNull();

  stop.mockRejectedValueOnce(new Error('private retirement failure'));
  const disconnect = await runCliCapture(['disconnect', '--json'], { env });
  expect(JSON.parse(disconnect.stdout).error.details.reason).toBe(
    'cloud_attachment_daemon_stop_unconfirmed',
  );
  expect(disconnect.stdout + disconnect.stderr).not.toContain('private retirement failure');
  expect(broker.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'DELETE']);
  expect(readCloudConnection(location)).toMatchObject({
    phase: 'closing',
    id: hostedDevice.id,
    brokerReleased: true,
  });
  expect(fs.existsSync(cloudAttachmentPath(location))).toBe(false);
  const refused = await runCliCapture(['snapshot', '--json'], { env });
  expect(JSON.parse(refused.stdout).error.details.reason).toBe('cloud_connection_changed');
  expect(refused.calls).toEqual([]);

  const recovered = await runCliCapture(['disconnect', '--json'], {
    env: { ...env, AGENT_DEVICE_CLOUD_API_KEY: undefined },
  });
  expect(JSON.parse(recovered.stdout).data.released).toBe(true);
  expect(broker.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'DELETE']);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(readCloudConnection(location)).toBeNull();
});

test('a signed viewer link carrying the attachment credential stays out of the approved lease', async () => {
  const env = limrunEnv('current');
  const scopedFragment = Array.from(
    scopedToken,
    (char) => '%' + char.charCodeAt(0).toString(16),
  ).join('');
  const viewerUrl = `https://viewer.example/watch?view=live#token=${scopedFragment}`;
  const fetchMock = stubCloudApi();
  fetchMock.mockResolvedValueOnce(
    Response.json({ ...limrunLease('ios'), viewerUrl }, { status: 201 }),
  );
  const open = vi.spyOn(browserLaunch, 'openUrlInBrowser').mockResolvedValue(true);

  const result = await runCliCapture([...args('ios'), '--show-viewer'], { env });
  expect(result.code, result.stderr || result.stdout).toBeNull();
  expect(JSON.parse(result.stdout).data).toMatchObject({
    viewerAvailable: false,
    cloudSessionId: hostedDevice.id,
  });
  expect(open).not.toHaveBeenCalled();
  expect(result.stdout + result.stderr).not.toContain(viewerUrl);
  expect(result.stdout + result.stderr).not.toContain(scopedToken);
  const record = readRemoteConnectionState(locationOf(env))!;
  expect(JSON.stringify(record)).not.toContain(viewerUrl);
  expect(fs.readFileSync(record.remoteConfigPath, 'utf8')).not.toContain(viewerUrl);
  expect(fs.readFileSync(cloudAttachmentPath(locationOf(env)), 'utf8')).not.toContain(viewerUrl);
  expect((await runCliCapture(['disconnect', '--json'], { env })).code).toBeNull();
});
