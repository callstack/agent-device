import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { DaemonBatchStep, DaemonWireRequest } from '@agent-device/contracts/command';
import {
  readScriptDeliveryFailure,
  readScriptDeliveryReceipt,
  type DaemonArtifact,
  type DaemonResponse,
} from '@agent-device/kernel/contracts';
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
 * would make this client deliver the wrong version or drop a failure is caught here rather than in
 * a step-result interpreter.
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

test('a batch receipt that names a close delivers the final script and retires the record', async () => {
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
  // The final version is the one already saved, so it is answered from the record with no warning of its own.
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

test('a failed batch whose receipt names no close delivers the version and keeps the record', async () => {
  const { settleScriptDeliveryReceiptOfFailure, fetchRemoteArtifact } =
    await import('../daemon-artifacts.ts');
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({
    'open-v1': 'open Demo\n',
    v2: 'open Demo\nwait\n',
  });
  const id = await opened(baseUrl, stateDir, destination);
  const settled = await settleScriptDeliveryReceiptOfFailure(
    { baseUrl, token: 't' },
    batchRequest([
      { command: 'wait', input: {} },
      { command: 'close', input: {} },
    ]),
    {
      code: 'COMMAND_FAILED' as const,
      message: 'original batch failure',
      details: { step: 2, command: 'close', ...receipt(id, { version: script('v2', 2, id) }) },
    },
    stateDir,
    fetchRemoteArtifact,
  );
  expect(settled.message).toBe('original batch failure');
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait\n');
  expect(records(stateDir)).toHaveLength(1);
});

test('a failed batch whose receipt names a close delivers the version, discloses, and retires the record', async () => {
  // The daemon names a close only for a step that ran one, so the receipt's close retires the record
  // whatever position the batch failure itself names.
  const { settleScriptDeliveryReceiptOfFailure, fetchRemoteArtifact } =
    await import('../daemon-artifacts.ts');
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({
    'open-v1': 'open Demo\n',
    v2: 'open Demo\nwait\nclose\n',
  });
  const id = await opened(baseUrl, stateDir, destination);
  const failure = {
    reason: 'script_delivery_failed',
    publicationId: id,
    message: 'The daemon could not write a version.',
    hint: 'Keep the previous recording.',
  };
  const settled = await settleScriptDeliveryReceiptOfFailure(
    { baseUrl, token: 't' },
    batchRequest([
      { command: 'wait', input: {} },
      { command: 'close', input: {} },
    ]),
    {
      code: 'COMMAND_FAILED' as const,
      message: 'original batch failure',
      details: receipt(id, {
        version: script('v2', 2, id),
        close: { step: 2 },
        failures: [failure],
      }),
    },
    stateDir,
    fetchRemoteArtifact,
  );
  expect(settled.message).toBe('original batch failure');
  expect(settled.details?.scriptDeliveryReceipt).toBeDefined();
  expect(settled.details?.scriptDeliveryFailure).toEqual(failure);
  expect(settled.details?.warnings).toEqual([`${failure.message} ${failure.hint}`]);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait\nclose\n');
  expect(records(stateDir)).toEqual([]);
});

test('script artifacts aimed at the disclosure fields erase neither a failure nor a publication', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({
    'open-v1': 'open Demo\n',
    'close-v2': { refused: true },
    ghost: 'not a script artifact\n',
  });
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
        publicationId: id,
        version: script('close-v2', 2, id),
        close: { step: 2 },
      },
      artifacts: [
        { ...script('close-v2', 2, id), field: 'warnings' },
        { ...script('close-v2', 2, id), field: 'scriptDeliveryFailure' },
        { ...script('ghost', 9, id), field: 'warnings', artifactId: 7 },
        { ...script('ghost', 9, id), field: 'scriptDeliveryFailure', artifactType: 'screenshot' },
      ],
    },
  );

  const data = (response as Extract<DaemonResponse, { ok: true }>).data ?? {};
  expect(response.ok).toBe(true);
  const failure = data.scriptDeliveryFailure as { reason: string; cause?: string };
  expect(failure.reason).toBe('script_delivery_failed');
  expect(failure.cause).toBe('script_download_failed');
  expect(data.warnings).toEqual([expect.stringContaining('could not be saved')]);
  expect(data.savedScript).toBeUndefined();
  expect(data.artifacts).toEqual([]);
  // The file keeps the version it had, and the close the receipt names still retires the record.
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(records(stateDir)).toEqual([]);
});

test('a malformed script artifact cannot erase the version a valid one just published', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({
    'open-v1': 'open Demo\n',
    'close-v2': 'open Demo\nwait\nclose\n',
  });
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
        publicationId: id,
        version: script('close-v2', 2, id),
        close: { step: 2 },
      },
      artifacts: [
        script('close-v2', 2, id),
        { ...script('ghost', 9, id), field: 'savedScript', artifactType: 'screenshot' },
        { ...script('ghost', 9, id), field: 'scriptDeliveryFailure' },
        { ...script('ghost', 9, id), field: 'warnings' },
      ],
    },
  );

  const data = (response as Extract<DaemonResponse, { ok: true }>).data ?? {};
  expect(data.savedScript).toBe(destination);
  expect(data.scriptDeliveryFailure).toBeUndefined();
  expect(data.warnings).toBeUndefined();
  expect(data.artifacts).toEqual([
    expect.objectContaining({ artifactId: 'close-v2', localPath: destination }),
  ]);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nwait\nclose\n');
  expect(records(stateDir)).toEqual([]);
});

test.each(['success', 'failure'])(
  'an unreadable receipt on %s discloses and delivers nothing',
  async (outcome) => {
    const { stateDir, destination } = world();
    const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n', v2: 'untrusted\n' });
    const id = await opened(baseUrl, stateDir, destination);

    const plan = batchRequest([{ command: 'wait', input: {} }]);
    const invalid = { scriptDeliveryReceipt: { publicationId: id, version: 'close-v2' } };
    let data: Record<string, unknown>;
    if (outcome === 'success') {
      const response = await answer(baseUrl, stateDir, plan, {
        ...invalid,
        artifacts: [script('v2', 2, id)],
      });
      expect(response.ok).toBe(true);
      data = (response as Extract<DaemonResponse, { ok: true }>).data ?? {};
    } else {
      const { settleScriptDeliveryReceiptOfFailure, fetchRemoteArtifact } =
        await import('../daemon-artifacts.ts');
      const error = await settleScriptDeliveryReceiptOfFailure(
        { baseUrl, token: 't' },
        plan,
        { code: 'COMMAND_FAILED', message: 'original error', details: invalid },
        stateDir,
        fetchRemoteArtifact,
      );
      expect(error.message).toBe('original error');
      data = error.details ?? {};
    }
    expect(data.scriptDeliveryFailure).toMatchObject({ reason: 'script_delivery_failed' });
    expect(data.warnings).toEqual([expect.stringContaining('malformed script delivery receipt')]);
    expect(data.savedScript).toBeUndefined();
    expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
    expect(records(stateDir)).toHaveLength(1);
  },
);

test.each(['publicationId', 'artifactId', 'message', 'hint', 'cause'] as const)(
  'receipt string bounds cover %s at the accepted limit and one character past it',
  (field) => {
    for (const length of [4096, 4097]) {
      const value = 'x'.repeat(length);
      const publicationId = field === 'publicationId' ? value : 'recording-id';
      const failure = {
        reason: 'script_delivery_failed',
        publicationId,
        message: 'failed',
        hint: 'keep the file',
        cause: 'EIO',
      };
      if (field !== 'publicationId' && field !== 'artifactId') failure[field] = value;
      const delivery = {
        publicationId,
        version: script(field === 'artifactId' ? value : 'v2', 2, publicationId),
        failures: [failure],
      };
      const result = readScriptDeliveryReceipt({
        ok: true,
        data: { scriptDeliveryReceipt: delivery },
      });
      expect(result !== undefined, `${field}: ${length}`).toBe(length === 4096);
    }
  },
);

test.each([
  {
    name: 'a close',
    steps: [
      { command: 'wait', input: {} },
      { command: 'close', input: {} },
    ],
    close: { step: 2 },
    offers: 'The session is closed, so no later version follows.',
    withholds: 'The next recorded action or close delivers',
  },
  {
    name: 'no close',
    steps: [{ command: 'wait', input: {} }],
    close: undefined,
    offers: 'The next recorded action or close delivers the full recording again.',
    withholds: 'The session is closed',
  },
])(
  'a failed batch version of $name offers the recovery that is still left',
  async ({ steps, close, offers, withholds }) => {
    // A close retires the record, so promising that a later action delivers again would send the
    // caller after a session that is already gone.
    const { stateDir, destination } = world();
    const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n', v2: { refused: true } });
    const id = await opened(baseUrl, stateDir, destination);

    const response = await answer(
      baseUrl,
      stateDir,
      batchRequest(steps),
      receipt(id, { version: script('v2', 2, id), ...(close ? { close } : {}) }),
    );

    const hint = readScriptDeliveryFailure(response.ok ? response.data : undefined)?.hint;
    expect(hint).toContain(offers);
    expect(hint).not.toContain(withholds);
  },
);

test('a peer value for savedScript never reaches the caller', async () => {
  const { stateDir, destination } = world();
  const baseUrl = await artifactServer({ 'open-v1': 'open Demo\n' });
  const id = await opened(baseUrl, stateDir, destination);

  const armed = await answer(baseUrl, stateDir, batchRequest([{ command: 'wait', input: {} }]), {
    savedScript: '/daemon/x.ad',
    scriptPublicationId: id,
  });
  const bare = await answer(baseUrl, stateDir, batchRequest([{ command: 'wait', input: {} }]), {
    savedScript: '/daemon/y.ad',
  });

  expect((armed as Extract<DaemonResponse, { ok: true }>).data?.savedScript).toBeUndefined();
  expect((bare as Extract<DaemonResponse, { ok: true }>).data?.savedScript).toBeUndefined();
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
      const { settleScriptDeliveryReceiptOfFailure, fetchRemoteArtifact } =
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
        fetchRemoteArtifact,
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
