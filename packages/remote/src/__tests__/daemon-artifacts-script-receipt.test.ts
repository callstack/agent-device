import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { DaemonBatchStep, DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { materializeRemoteArtifacts } from '../daemon-artifacts.ts';
import { sendRemoteScriptOpen } from '../session-script-destination.ts';

/**
 * The client half of the batch delivery receipt (ADR 0016, #4595). Every case answers a batch the
 * way a daemon does and materializes the answer the way the real client does, so a receipt that
 * would make this client deliver the wrong version, retire a recording that never closed, or drop a
 * failure is caught here rather than in a step-result interpreter.
 */

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeLoopbackServer(server)));
});

async function artifactServer(
  artifacts: Record<string, string | { refused: true }>,
): Promise<string> {
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url?.replace(/^\/+artifacts\//, '') ?? '');
    const served = artifacts[id];
    if (served === undefined) {
      res.writeHead(404).end();
      return;
    }
    if (typeof served !== 'string') {
      res.writeHead(503).end('unavailable');
      return;
    }
    res.writeHead(200, { 'content-length': Buffer.byteLength(served) });
    res.end(served);
  });
  servers.push(server);
  return `http://127.0.0.1:${await listenOnLoopback(server)}`;
}

function world() {
  const root = fs.realpathSync(mkdtempForTestSync('script-receipt-'));
  const stateDir = path.join(root, 'state');
  return { root, stateDir, destination: path.join(root, 'caller', 'journey.ad') };
}

function batchRequest(
  steps: DaemonBatchStep[],
  meta: DaemonWireRequest['meta'] = {},
): DaemonWireRequest {
  return {
    token: 't',
    session: 'journey',
    command: 'batch',
    positionals: [],
    flags: { batchSteps: steps },
    meta,
  };
}

/** A `session-script` artifact of the recording this client opened. */
function script(artifactId: string, revision: number, publicationId: string): DaemonArtifact {
  return {
    field: 'savedScript',
    artifactType: 'session-script',
    artifactId,
    scriptPublicationId: publicationId,
    scriptRevision: revision,
  };
}

/** The one receipt field, as the daemon answers it on a batch response. */
function receipt(version: unknown, extra: Record<string, unknown> = {}) {
  return { scriptDeliveryReceipt: { publicationId: version, ...extra } };
}

function records(stateDir: string): string[] {
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.endsWith('.json'))
    : [];
}

/** Opens a recording so the client holds a record and its first version, and reports the ID. */
async function opened(baseUrl: string, stateDir: string, destination: string): Promise<string> {
  const openRequest: DaemonWireRequest = {
    ...batchRequest([], { clientArtifactPaths: { savedScript: destination } }),
    command: 'open',
    flags: { saveScript: true },
  };
  let id = '';
  const response = await sendRemoteScriptOpen(
    { baseUrl, token: 't', capabilities: ['script-artifacts'] },
    openRequest,
    stateDir,
    async (req) => {
      id = req.meta?.scriptPublicationId as string;
      return {
        ok: true,
        data: { scriptPublicationId: id, artifacts: [script('open-v1', 1, id)] },
      };
    },
  );
  await materializeRemoteArtifacts(
    { baseUrl, token: 't' },
    openRequest,
    response as Extract<DaemonResponse, { ok: true }>,
    createTestHostEnvironment(),
    stateDir,
  );
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  return id;
}

function answer(
  baseUrl: string,
  stateDir: string,
  req: DaemonWireRequest,
  data: Record<string, unknown>,
): Promise<DaemonResponse> {
  return materializeRemoteArtifacts(
    { baseUrl, token: 't' },
    req,
    { ok: true, data },
    createTestHostEnvironment(),
    stateDir,
  );
}

test('a batch receipt delivers the newest full-script version to the caller file', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({
    'open-v1': 'open Demo\n',
    'step-v2': 'open Demo\nwait "label=\\"Apps\\""\n',
  });
  const id = await opened(baseUrl, stateDir, destination);
  expect(records(stateDir)).toHaveLength(1);

  await answer(
    baseUrl,
    stateDir,
    batchRequest([{ command: 'wait', input: {} }]),
    receipt(id, { version: script('step-v2', 2, id) }),
  );

  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait "label=\\"Apps\\""\n');
});

test('a batch receipt whose close its plan does not carry retires nothing', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({
    'open-v1': 'open Demo\n',
    'step-v2': 'open Demo\nwait\n',
  });
  const id = await opened(baseUrl, stateDir, destination);

  await answer(
    baseUrl,
    stateDir,
    batchRequest([{ command: 'wait', input: {} }]),
    receipt(id, {
      version: script('step-v2', 2, id),
      close: { step: 2 },
    }),
  );

  expect(records(stateDir)).toHaveLength(1);
  expect(fs.existsSync(destination)).toBe(true);
});

test('a batch receipt whose close names a step beyond the plan retires nothing', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({
    'open-v1': 'open Demo\n',
    'close-v2': 'open Demo\nclose\n',
  });
  const id = await opened(baseUrl, stateDir, destination);

  await answer(
    baseUrl,
    stateDir,
    batchRequest([
      { command: 'wait', input: {} },
      { command: 'tap', input: {} },
    ]),
    receipt(id, { version: script('close-v2', 2, id), close: { step: 3 } }),
  );

  expect(records(stateDir)).toHaveLength(1);
});

test('a batch receipt whose close its plan carries delivers the final script and retires', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({
    'open-v1': 'open Demo\n',
    'close-v2': 'open Demo\nwait\nclose\n',
  });
  const id = await opened(baseUrl, stateDir, destination);

  await answer(
    baseUrl,
    stateDir,
    batchRequest([
      { command: 'wait', input: {} },
      { command: 'CLOSE', input: {} },
    ]),
    receipt(id, { version: script('close-v2', 2, id), close: { step: 2 } }),
  );

  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait\nclose\n');
  expect(records(stateDir)).toEqual([]);
});

test.each([
  { name: 'padded with whitespace', publicationId: ' padded-publication-id-0000000000  ' },
  { name: 'not a string', publicationId: 42 },
  { name: 'absent', publicationId: undefined },
])(
  'a receipt whose publication ID is $name delivers and retires nothing',
  async ({ publicationId }) => {
    const { stateDir, destination } = world();
    const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n', v2: 'open Demo\nwait\n' });
    const id = await opened(baseUrl, stateDir, destination);

    const response = await answer(
      baseUrl,
      stateDir,
      batchRequest([
        { command: 'wait', input: {} },
        { command: 'close', input: {} },
      ]),
      {
        scriptDeliveryReceipt: {
          publicationId,
          version: script('v2', 2, id),
          close: { step: 2 },
        },
      },
    );

    expect(response.ok).toBe(true);
    expect(records(stateDir)).toHaveLength(1);
    expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  },
);

test('a receipt names at most one version and no other script artifact is downloaded', async () => {
  const { stateDir, destination } = world();
  const downloads: string[] = [];
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url?.replace(/^\/+artifacts\//, '') ?? '');
    downloads.push(id);
    res.writeHead(200).end(id === 'v3' ? 'open Demo\nwait\nclose\n' : 'open Demo\n');
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const id = await opened(baseUrl, stateDir, destination);
  downloads.length = 0;

  await answer(
    baseUrl,
    stateDir,
    batchRequest([
      { command: 'wait', input: {} },
      { command: 'close', input: {} },
    ]),
    {
      scriptDeliveryReceipt: {
        publicationId: id,
        version: script('v3', 3, id),
        close: { step: 2 },
      },
      artifacts: [
        script('v1', 1, id),
        script('v2', 2, id),
        script('v3', 3, id),
        script('v4', 4, id),
      ],
    },
  );

  expect(downloads).toEqual(['v3']);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait\nclose\n');
  expect(records(stateDir)).toEqual([]);
});

test('a newer receipt version of the wrong artifact type authorizes nothing', async () => {
  // A half-shaped receipt is not repaired: a client that acted on its close while dropping its
  // version is how a batch retired a recording while its caller file stayed stale.
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n', v2: 'not a script\n' });
  const id = await opened(baseUrl, stateDir, destination);

  await answer(
    baseUrl,
    stateDir,
    batchRequest([
      { command: 'wait', input: {} },
      { command: 'close', input: {} },
    ]),
    {
      scriptDeliveryReceipt: {
        publicationId: id,
        version: { ...script('v2', 2, id), artifactType: 'screenshot' },
        close: { step: 2 },
      },
    },
  );

  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toHaveLength(1);
});

test('a newer receipt version for another recording never masks this recording’s version', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({
    'open-v1': 'open Demo\n',
    'other-v9': 'an open of another recording\n',
    v2: 'open Demo\nwait\nclose\n',
  });
  const id = await opened(baseUrl, stateDir, destination);

  await answer(
    baseUrl,
    stateDir,
    batchRequest([
      { command: 'wait', input: {} },
      { command: 'close', input: {} },
    ]),
    {
      scriptDeliveryReceipt: {
        publicationId: id,
        version: script('v2', 2, id),
        close: { step: 2 },
      },
      artifacts: [{ ...script('other-v9', 9, cryptoRandomUUIDish()), field: 'savedScript' }],
    },
  );

  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait\nclose\n');
  expect(records(stateDir)).toEqual([]);
});

/** A well-formed publication ID belonging to a recording this client never opened. */
function cryptoRandomUUIDish(): string {
  return '0f6f0a3d-1b2c-4d5e-8f90-abcdef012345';
}

test('a receipt close with a failed final version still retires the record and discloses the failure', async () => {
  // The daemon could not write the FINAL version, so the receipt names the newest one it did write
  // — already published here — and the typed failure of the final write.
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n' });
  const id = await opened(baseUrl, stateDir, destination);
  const failure = {
    reason: 'script_delivery_failed' as const,
    publicationId: id,
    message: 'The session was closed, but the daemon could not write its final script.',
    hint: 'The --save-script file keeps the version from the last recorded action.',
  };

  const response = await answer(
    baseUrl,
    stateDir,
    batchRequest([
      { command: 'wait', input: {} },
      { command: 'close', input: {} },
    ]),
    {
      scriptDeliveryReceipt: {
        publicationId: id,
        version: script('open-v1', 1, id),
        close: { step: 2 },
        failures: [failure],
      },
    },
  );

  expect(response.ok).toBe(true);
  const data = (response as Extract<DaemonResponse, { ok: true }>).data ?? {};
  expect(data.scriptDeliveryFailure).toEqual(failure);
  expect(data.warnings).toEqual([expect.stringContaining(failure.hint)]);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toEqual([]);
});

test('a receipt publication failure and this client’s download failure are both disclosed', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n', v2: { refused: true } });
  const id = await opened(baseUrl, stateDir, destination);
  const daemonFailure = {
    reason: 'script_delivery_failed' as const,
    publicationId: id,
    message: 'The action succeeded, but the daemon could not write the remote recording.',
    hint: 'DAEMON-HINT',
  };

  const response = await answer(baseUrl, stateDir, batchRequest([{ command: 'wait', input: {} }]), {
    scriptDeliveryReceipt: {
      publicationId: id,
      version: script('v2', 2, id),
      failures: [daemonFailure],
    },
  });

  const data = (response as Extract<DaemonResponse, { ok: true }>).data ?? {};
  const clientFailure = data.scriptDeliveryFailure as { reason: string; cause?: string };
  expect(clientFailure.reason).toBe('script_delivery_failed');
  expect(clientFailure.cause).toBe('script_download_failed');
  expect(data.warnings).toEqual([
    expect.stringContaining('DAEMON-HINT'),
    expect.stringContaining('remote script could not be saved'),
  ]);
});

test('a receipt naming no version delivers nothing and keeps the caller file', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n' });
  const id = await opened(baseUrl, stateDir, destination);

  const response = await answer(baseUrl, stateDir, batchRequest([{ command: 'wait', input: {} }]), {
    scriptDeliveryReceipt: {
      publicationId: id,
      failures: [
        {
          reason: 'script_delivery_failed',
          publicationId: id,
          message: 'The action succeeded, but the daemon could not write the remote recording.',
          hint: 'DAEMON-HINT',
        },
      ],
    },
  });

  const data = (response as Extract<DaemonResponse, { ok: true }>).data ?? {};
  expect(data.savedScript).toBeUndefined();
  expect(data.warnings).toEqual([expect.stringContaining('DAEMON-HINT')]);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toHaveLength(1);
});

test('a receipt naming more failures than the field contract allows authorizes nothing', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({
    'open-v1': 'open Demo\n',
    v2: 'open Demo\nwait\nclose\n',
  });
  const id = await opened(baseUrl, stateDir, destination);
  const failure = {
    reason: 'script_delivery_failed',
    publicationId: id,
    message: 'The daemon could not write the remote recording.',
    hint: 'DAEMON-HINT',
  };

  await answer(
    baseUrl,
    stateDir,
    batchRequest([
      { command: 'wait', input: {} },
      { command: 'close', input: {} },
    ]),
    {
      scriptDeliveryReceipt: {
        publicationId: id,
        version: script('v2', 2, id),
        close: { step: 2 },
        failures: Array.from({ length: 4_000 }, () => failure),
      },
    },
  );

  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toHaveLength(1);
});

test('a receipt version entry that is not an object delivers nothing and keeps the batch outcome', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n' });
  const id = await opened(baseUrl, stateDir, destination);

  const response = await answer(
    baseUrl,
    stateDir,
    batchRequest([{ command: 'wait', input: {} }]),
    receipt(id, { version: null }),
  );

  expect(response.ok).toBe(true);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toHaveLength(1);
});

test('a malformed close receipt cannot throw or fall back to batch script artifacts', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n', v2: 'untrusted\n' });
  const id = await opened(baseUrl, stateDir, destination);
  const response = await answer(
    baseUrl,
    stateDir,
    batchRequest([{ command: 'close', input: {} }]),
    {
      ...receipt(id, { version: script('v2', 2, id), close: null }),
      artifacts: [script('v2', 2, id)],
    },
  );
  expect(response.ok).toBe(true);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toHaveLength(1);
});

test.each([
  { name: 'an unreached close', details: { step: 1, command: 'wait' } },
  { name: 'missing failure position', details: {} },
  { name: 'a position past the plan', details: { step: 3, command: 'close' } },
  { name: 'a different command', details: { step: 1, command: 'close' } },
])('a failed batch with $name authorizes no delivery', async ({ details }) => {
  const { settleScriptDeliveryReceiptOfFailure } = await import('../daemon-artifacts.ts');
  const { downloadRemoteArtifact } = await import('../daemon-artifacts.ts');
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n', v2: 'untrusted\n' });
  const id = await opened(baseUrl, stateDir, destination);
  const error = {
    code: 'COMMAND_FAILED' as const,
    message: 'original batch failure',
    details: {
      ...details,
      ...receipt(id, { version: script('v2', 2, id), close: { step: 2 } }),
    },
  };
  const settled = await settleScriptDeliveryReceiptOfFailure(
    { baseUrl, token: 't' },
    batchRequest([
      { command: 'wait', input: {} },
      { command: 'close', input: {} },
    ]),
    error,
    stateDir,
    downloadRemoteArtifact,
  );
  expect(settled).toEqual(error);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toHaveLength(1);
});

test.each(['success', 'failure'] as const)(
  'a %s receipt discloses daemon failures after the client record is gone',
  async (outcome) => {
    const { stateDir, destination } = world();
    const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n', v2: 'must not publish\n' });
    const id = await opened(baseUrl, stateDir, destination);
    for (const file of records(stateDir)) {
      fs.unlinkSync(path.join(stateDir, 'remote-connections', 'session-scripts', file));
    }
    const failure = {
      reason: 'script_delivery_failed' as const,
      publicationId: id,
      message: 'The daemon could not write the final script.',
      hint: 'The caller file keeps its earlier recording.',
    };
    const plan = batchRequest([
      { command: 'close', input: {} },
      { command: 'press', input: {} },
    ]);
    const delivery = receipt(id, {
      version: script('v2', 2, id),
      close: { step: 1 },
      failures: [failure],
    });
    let disclosed: Record<string, unknown> | undefined;
    if (outcome === 'success') {
      const response = await answer(baseUrl, stateDir, plan, delivery);
      expect(response.ok).toBe(true);
      if (response.ok) disclosed = response.data;
    } else {
      const { settleScriptDeliveryReceiptOfFailure, downloadRemoteArtifact } =
        await import('../daemon-artifacts.ts');
      const error = await settleScriptDeliveryReceiptOfFailure(
        { baseUrl, token: 't' },
        plan,
        {
          code: 'COMMAND_FAILED',
          message: 'Original batch failure',
          details: { step: 2, command: 'press', ...delivery },
        },
        stateDir,
        downloadRemoteArtifact,
      );
      expect(error.message).toBe('Original batch failure');
      disclosed = error.details;
    }
    expect(disclosed?.scriptDeliveryFailure).toEqual(failure);
    expect(disclosed?.warnings).toEqual([`${failure.message} ${failure.hint}`]);
    expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
    expect(records(stateDir)).toEqual([]);
  },
);
