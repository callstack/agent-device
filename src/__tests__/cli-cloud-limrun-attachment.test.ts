import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { bindCloudAttachment } from '../cli/connection/cloud-attachment.ts';
import {
  cloudAttachmentPath,
  readCloudConnection,
} from '../cli/connection/cloud-connection-record.ts';
import { materializeRemoteConnectionForCommand } from '../cli/commands/connection-runtime.ts';
import { createTestClient, grantedLease } from './remote-connection.fixtures.ts';
import { runCliCapture } from './cli-capture.ts';
import { cloudEnv, hostedDevice, locationOf, stubCloudApi } from './cli-cloud-session.fixtures.ts';

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
const adb = 'wss://adb.example';

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

function limrunEnv(version?: 'current' | 'old') {
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

test.each([undefined, 'old'] as const)(
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
