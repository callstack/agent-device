import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { readRemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
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
function stubBroker() {
  const byKey = new Map<string, { id: string; running: boolean }>();
  const calls: Array<{ method: string; path: string; key: string | null }> = [];
  const deadlineAt = new Date(Date.now() + 3600_000).toISOString();
  const created = (id: string) => ({
    id,
    vendor: 'provider-a',
    transport: 'agent-device-daemon',
    platform: 'ios',
    deadlineAt,
    viewerUrl: 'https://viewer.example/session?token=private',
    attach,
  });
  const loseNextCreateResponse = { armed: false };
  const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
    const key = new Headers(init.headers).get('Idempotency-Key');
    calls.push({ method: String(init.method), path: url.pathname, key });
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

afterEach(() => {
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

test('a connect that lost its create response retries the same POST with the same idempotency key and gets the same session', async () => {
  const stateDir = freshStateDir();
  const broker = stubBroker();
  broker.loseNextCreateResponse();
  const crashed = await runCliCapture(connectArgs, { env: processEnv(stateDir) });
  expect(JSON.parse(crashed.stdout).error.details.reason).toBe('cloud_session_connect_timeout');
  vi.mocked(Date.now).mockRestore();
  // The broker holds funds for the key, and the CLI holds only a pending intent.
  expect(readCloudConnection(locationOf(stateDir))).toMatchObject({ phase: 'pending' });
  expect(broker.holds.size).toBe(1);
  expect(fs.existsSync(cloudAttachmentPath(locationOf(stateDir)))).toBe(false);

  const restarted = await runCliCapture(connectArgs, { env: processEnv(stateDir) });
  expect(restarted.code, restarted.stderr || restarted.stdout).toBeNull();

  const keys = broker.posts().map((call) => call.key);
  expect(keys).toEqual([expect.any(String), keys[0]]);
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
