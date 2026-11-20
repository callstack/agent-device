import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { expect, onTestFinished, test, vi } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { fetchRemoteArtifact, materializeRemoteArtifacts } from '../daemon-artifacts.ts';
import { withRecordLock } from '../script-publication-record.ts';
import { publishScriptVersion } from '../script-version-publisher.ts';
import { sendRemoteScriptOpen } from '../session-script-destination.ts';
import {
  answer,
  artifactServer,
  open,
  records,
  request,
  script,
  soleRecord,
} from './support/script-publication-fixtures.ts';

function journey() {
  // The real path, so a destination names the same file the publication renames into place.
  const root = fs.realpathSync(mkdtempForTestSync('script-download-'));
  const stateDir = path.join(root, 'state');
  return { root, stateDir, destination: path.join(root, 'caller', 'journey.ad') };
}

/** A successful response whose script version could not be saved on this machine. */
function deliveryFailure(cause: string) {
  return expect.objectContaining({
    ok: true,
    data: expect.objectContaining({
      scriptDeliveryFailure: expect.objectContaining({ reason: 'script_delivery_failed', cause }),
      warnings: [expect.stringContaining('script')],
    }),
  });
}

test('an open records its destination before it is sent, and sends only its publication ID', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

  const { id, sent, recordsAtSend, response } = await open(baseUrl, stateDir, destination);

  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(recordsAtSend).toHaveLength(1);
  expect(sent?.meta?.clientArtifactPaths).toEqual({});
  expect(JSON.stringify(sent)).not.toContain(destination);
  expect(response).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  if (process.platform !== 'win32') expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
});

test('an older daemon is refused before the open is sent', async () => {
  const { stateDir, destination } = journey();
  const send = vi.fn();
  const req = request('open', { clientArtifactPaths: { savedScript: destination } });

  await expect(
    sendRemoteScriptOpen({ baseUrl: 'http://127.0.0.1:9', token: 't' }, req, stateDir, send),
  ).rejects.toMatchObject({ details: { reason: 'remote_script_artifacts_unsupported' } });
  expect(send).not.toHaveBeenCalled();
  expect(records(stateDir)).toEqual([]);
});

test.each([
  {
    name: 'a refused open',
    respond: (): DaemonResponse => ({ ok: false, error: { code: 'X', message: 'no' } }),
  },
  { name: 'an open that armed nothing', respond: (): DaemonResponse => ({ ok: true, data: {} }) },
])('$name removes its record', async ({ respond }) => {
  const { stateDir, destination } = journey();

  await open('http://127.0.0.1:9', stateDir, destination, { respond }).catch(() => undefined);

  expect(records(stateDir)).toEqual([]);
});

test('a failed open may have armed the recording, so it keeps its inert record', async () => {
  const { stateDir, destination } = journey();
  const lost = new AppError('COMMAND_FAILED', 'Daemon request timed out', {
    dispatched: 'unknown',
  });

  await expect(
    open('http://127.0.0.1:9', stateDir, destination, {
      respond: () => {
        throw lost;
      },
    }),
  ).rejects.toBe(lost);

  expect(records(stateDir)).toHaveLength(1);
});

test('only a newer version of a recorded publication writes', async () => {
  const { root, stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: { body: 'v1\n' },
    v2: { body: 'v2\n' },
    v3: { body: 'v3\n' },
    foreign: { body: 'foreign\n' },
  });
  const otherEndpoint = await artifactServer({ foreign: { body: 'foreign\n' } });
  const { id } = await open(baseUrl, stateDir, destination);

  await answer(baseUrl, stateDir, request('click'), { artifacts: [script('v3', 3, id)] });
  await answer(baseUrl, stateDir, request('click'), { artifacts: [script('v2', 2, id)] });
  const foreign = [
    answer(baseUrl, stateDir, request('click'), {
      savedScript: '/daemon/x.ad',
      artifacts: [script('foreign', 4, '00000000-0000-4000-8000-000000000000')],
    }),
    answer(
      baseUrl,
      stateDir,
      { ...request('click'), session: 'other' },
      {
        artifacts: [script('foreign', 4, id)],
      },
    ),
    answer(baseUrl, stateDir, request('click', { tenantId: 'other' }), {
      artifacts: [script('foreign', 4, id)],
    }),
    answer(otherEndpoint, stateDir, request('click'), { artifacts: [script('foreign', 4, id)] }),
    answer(baseUrl, stateDir, request('click'), {
      artifacts: [{ ...script('foreign', 4, id), artifactType: 'screenshot' }],
    }),
  ];

  for (const response of await Promise.all(foreign)) {
    expect(response).toEqual({ ok: true, data: { artifacts: [] } });
  }
  expect(fs.readFileSync(destination, 'utf8')).toBe('v3\n');
  expect(fs.readdirSync(path.join(root, 'caller'))).toEqual(['journey.ad']);
});

test.each([
  { name: 'a regular file', link: false },
  { name: 'a symlink', link: true },
])(
  'the first version never replaces $name that appeared while the open was pending',
  async ({ link }) => {
    const { root, stateDir, destination } = journey();
    const appeared = path.join(root, 'appeared.ad');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(appeared, 'appeared\n');
    if (link) fs.symlinkSync(appeared, destination);
    else fs.renameSync(appeared, destination);
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(deliveryFailure('script_target_exists'));
    expect(response.ok && response.data?.savedScript).toBeUndefined();
    expect(fs.readFileSync(destination, 'utf8')).toBe('appeared\n');
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(link);
  },
);

test('an open with --force replaces a file that appeared while it was pending', async () => {
  const { stateDir, destination } = journey();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, 'appeared\n');
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

  await open(baseUrl, stateDir, destination, { force: true });

  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
});

const SCRIPT_CAP_BYTES = 8 * 1024 * 1024;

test.each([
  { name: 'one byte over the cap', served: { body: 'x'.repeat(SCRIPT_CAP_BYTES + 1) } },
  { name: 'that never ends', served: { body: 'x'.repeat(64 * 1024), endless: true } },
])('a version $name keeps the previous one and writes nothing', async ({ served }) => {
  const { root, stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' }, big: served });
  const { id } = await open(baseUrl, stateDir, destination);

  await expect(
    answer(baseUrl, stateDir, request('click'), { artifacts: [script('big', 2, id)] }),
  ).resolves.toEqual(deliveryFailure('script_download_failed'));
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(fs.readdirSync(path.join(root, 'caller'))).toEqual(['journey.ad']);
});

test('a version of exactly the size cap is saved', async () => {
  const { stateDir, destination } = journey();
  const body = 'x'.repeat(SCRIPT_CAP_BYTES);
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' }, full: { body } });
  const { id } = await open(baseUrl, stateDir, destination);

  await answer(baseUrl, stateDir, request('click'), { artifacts: [script('full', 2, id)] });

  expect(fs.statSync(destination).size).toBe(SCRIPT_CAP_BYTES);
});

test('close keeps its success and retires the record when its final download fails', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: { body: 'open Demo\n' },
    v2: { body: 'open Demo\nclose\n', broken: true },
    late: { body: 'late\n' },
  });
  const { id } = await open(baseUrl, stateDir, destination);

  await expect(
    answer(baseUrl, stateDir, request('close'), {
      scriptPublicationId: id,
      artifacts: [script('v2', 2, id)],
    }),
  ).resolves.toEqual(deliveryFailure('script_download_failed'));
  expect(records(stateDir)).toEqual([]);
  await answer(baseUrl, stateDir, request('click'), { artifacts: [script('late', 3, id)] });
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
});

test('a close that publishes nothing still retires the record it names', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });
  const { id } = await open(baseUrl, stateDir, destination);

  await answer(baseUrl, stateDir, request('close'), { scriptPublicationId: id });

  expect(records(stateDir)).toEqual([]);
});

test('creating a record removes records nobody touched for a week', async () => {
  const { stateDir, destination } = journey();
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  fs.mkdirSync(directory, { recursive: true });
  const stale = path.join(directory, 'stale.json');
  const fresh = path.join(directory, 'fresh.json');
  fs.writeFileSync(stale, JSON.stringify({ destination, force: false, revision: 0 }));
  fs.writeFileSync(fresh, '{}');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);

  await open('http://127.0.0.1:9', stateDir, destination, {
    respond: () => ({ ok: true, data: {} }),
  });

  expect(fs.existsSync(stale)).toBe(false);
  expect(fs.existsSync(fresh)).toBe(true);
});

test('a recording whose first download failed still delivers later versions', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: { body: 'open Demo\n', broken: true },
    v2: { body: 'open Demo\nclose\n' },
  });
  const { id, response } = await open(baseUrl, stateDir, destination);
  expect(response).toEqual(deliveryFailure('script_download_failed'));

  await answer(baseUrl, stateDir, request('close'), {
    scriptPublicationId: id,
    artifacts: [script('v2', 2, id)],
  });

  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\nclose\n');
  expect(records(stateDir)).toEqual([]);
});

test('a later version stays exclusive while no version was saved yet', async () => {
  // Version 1 never arrived, so the record still says revision 0: version 2 is the first one saved.
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: { body: 'open Demo\n', broken: true },
    v2: { body: 'open Demo\nclick Next\n' },
  });
  const { id, response } = await open(baseUrl, stateDir, destination);
  expect(response).toEqual(deliveryFailure('script_download_failed'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, 'appeared\n');

  await expect(
    answer(baseUrl, stateDir, request('click'), { artifacts: [script('v2', 2, id)] }),
  ).resolves.toEqual(deliveryFailure('script_target_exists'));
  expect(fs.readFileSync(destination, 'utf8')).toBe('appeared\n');
});

test('a session-script artifact under another field writes nothing', async () => {
  const { root, stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' }, hostile: { body: 'x\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const req = request('click', { cwd: root });

  const response = await answer(baseUrl, stateDir, req, {
    path: '/daemon/x.ad',
    artifacts: [{ ...script('hostile', 2, id), field: 'path', fileName: 'victim.ad' }],
  });

  expect(response).toEqual({ ok: true, data: { path: '/daemon/x.ad', artifacts: [] } });
  expect(fs.existsSync(path.join(root, 'victim.ad'))).toBe(false);
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([
  { name: 'it publishes nothing', artifacts: false },
  { name: 'its final version also fails', artifacts: true },
])(
  'a close keeps its success when its record cannot be retired and $name',
  async ({ artifacts }) => {
    const { stateDir, destination } = journey();
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' }, v2: { body: 'final\n' } });
    const { id } = await open(baseUrl, stateDir, destination);
    const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
    fs.chmodSync(directory, 0o500);
    let response: DaemonResponse;
    try {
      response = await answer(baseUrl, stateDir, request('close'), {
        scriptPublicationId: id,
        ...(artifacts ? { artifacts: [script('v2', 2, id)] } : {}),
      });
    } finally {
      fs.chmodSync(directory, 0o700);
    }
    expect(response).toEqual(
      artifacts
        ? deliveryFailure('script_download_failed')
        : { ok: true, data: { scriptPublicationId: id } },
    );
    expect(records(stateDir)).toHaveLength(1);
  },
);

test('a stale record that cannot be swept never blocks a new open', async () => {
  const { stateDir, destination } = journey();
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  fs.mkdirSync(directory, { recursive: true });
  const stale = path.join(directory, 'stale.json');
  fs.writeFileSync(stale, JSON.stringify({ destination, force: false, revision: 0 }));
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);
  const realRm = fs.rmSync;
  const rm = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (String(target) === stale) throw new Error('record removal failed');
    realRm(target, options);
  });

  let opened: Awaited<ReturnType<typeof open>>;
  try {
    opened = await open('http://127.0.0.1:9', stateDir, destination, {
      respond: (id) => ({ ok: true, data: { scriptPublicationId: id } }),
    });
  } finally {
    rm.mockRestore();
  }

  expect(opened.response).toMatchObject({ ok: true });
  expect(fs.existsSync(stale)).toBe(true);
  expect(records(stateDir)).toHaveLength(2);
});

test('an endpoint spelled with trailing slashes finds the record its open created', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' }, v2: { body: 'close\n' } });
  const opened = await open(`${baseUrl}//`, stateDir, destination);
  const { id } = opened;
  expect(opened.response).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');

  const response = await answer(baseUrl, stateDir, request('close'), {
    scriptPublicationId: id,
    artifacts: [script('v2', 2, id)],
  });

  expect(response).toMatchObject({ ok: true, data: { savedScript: destination } });
  expect(fs.readFileSync(destination, 'utf8')).toBe('close\n');
});

// #4518: a caller abort after the answer never publishes the script version it carries, on any
// command that delivers one.
test.for([
  { name: 'record stop', req: { ...request('record'), positionals: ['stop'] } },
  { name: 'close', req: request('close') },
  { name: 'open --save-script', req: { ...request('open'), flags: { saveScript: true } } },
])('a canceled $name does not publish the script version it carries', async ({ req }) => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  expect(fs.readFileSync(destination, 'utf8')).toBe('v1\n');
  const controller = new AbortController();
  controller.abort();
  await expect(
    materializeRemoteArtifacts(
      { baseUrl, token: 't' },
      req,
      { ok: true, data: { scriptPublicationId: id, artifacts: [script('v2', 2, id)] } },
      createTestHostEnvironment(),
      stateDir,
      controller.signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'request_canceled' } });
  expect(fs.readFileSync(destination, 'utf8')).toBe('v1\n');
});

// #4518: an abort that lands after the recording is in cwd, during script delivery, still names it.
test('an abort during script delivery keeps the recording fallback warning', async () => {
  const { root, stateDir, destination } = journey();
  const cwd = path.join(root, 'cwd');
  fs.mkdirSync(cwd);
  const controller = new AbortController();
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/v2')) controller.abort();
    res.end(req.url?.endsWith('/rec') ? 'video' : 'v\n');
  });
  onTestFinished(() => closeLoopbackServer(server));
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const { id } = await open(baseUrl, stateDir, destination);
  const failure = await materializeRemoteArtifacts(
    { baseUrl, token: 't' },
    { ...request('record', { cwd }), positionals: ['stop'] },
    {
      ok: true,
      data: {
        artifacts: [
          {
            artifactId: 'rec',
            field: 'outPath',
            role: 'recording' as const,
            artifactType: 'screen-recording',
            fileName: 'demo.mp4',
          },
          script('v2', 2, id),
        ],
      },
    },
    createTestHostEnvironment(),
    stateDir,
    controller.signal,
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    details: {
      reason: 'request_canceled',
      recordingDestinationWarnings: [
        expect.objectContaining({ field: 'outPath', path: path.join(cwd, 'demo.mp4') }),
      ],
    },
  });
});

// #4518: an abort that lands while the publish waits for the record lock still publishes nothing.
test('an abort while the publish waits for the record lock leaves the destination unchanged', async () => {
  const { root, stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const { file } = soleRecord(stateDir);
  const controller = new AbortController();
  const fetch: typeof fetchRemoteArtifact = async (params) => {
    const fetched = await fetchRemoteArtifact(params);
    // Hold the record lock, so the publish waits for it; abort, then release it.
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const releasing = new Promise<void>((resolve) => {
      release = resolve;
    });
    void withRecordLock(file, async () => {
      entered();
      await releasing;
    });
    await held;
    setImmediate(() => {
      controller.abort();
      release();
    });
    return fetched;
  };
  const outcome = await publishScriptVersion(
    {
      endpoint: { baseUrl, token: 't' },
      req: request('click'),
      stateDir,
      fetch,
      signal: controller.signal,
    },
    script('v2', 2, id),
    false,
  );
  expect(outcome).toMatchObject({ failure: expect.anything() });
  expect(fs.readFileSync(destination, 'utf8')).toBe('v1\n');
  expect(fs.readdirSync(path.join(root, 'caller'))).toEqual(['journey.ad']);
});

// #4518: `recordingDestinationWarnings` is the client's own record of cwd writes. A peer copy, even
// a malformed one, is dropped and never reported.
test('a peer recordingDestinationWarnings array with a null entry still cancels as request_canceled', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const controller = new AbortController();
  controller.abort();
  const failure = await materializeRemoteArtifacts(
    { baseUrl, token: 't' },
    { ...request('record'), positionals: ['stop'] },
    { ok: true, data: { recordingDestinationWarnings: [null], artifacts: [script('v2', 2, id)] } },
    createTestHostEnvironment(),
    stateDir,
    controller.signal,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).details?.reason).toBe('request_canceled');
  expect((failure as AppError).details?.recordingDestinationWarnings).toBeUndefined();
});

test.for(['success', 'failure', 'cancel'] as const)(
  'well-formed peer recordingDestinationWarnings with no local write report nothing on %s',
  async (outcome) => {
    const { root, stateDir, destination } = journey();
    const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v2: { body: 'v2\n' } });
    const { id } = await open(baseUrl, stateDir, destination);
    const peer = [
      { reason: 'recording_destination_not_requested', field: 'outPath', path: '/x.mp4' },
    ];
    const controller = new AbortController();
    if (outcome === 'cancel') controller.abort();
    const artifacts =
      outcome === 'failure'
        ? [
            {
              artifactId: 'missing',
              field: 'outPath',
              role: 'recording' as const,
              artifactType: 'screen-recording',
              fileName: 'x.mp4',
            },
          ]
        : outcome === 'cancel'
          ? [script('v2', 2, id)]
          : [];
    const result = await materializeRemoteArtifacts(
      { baseUrl, token: 't' },
      {
        ...request('record', { clientArtifactPaths: { outPath: path.join(root, 'out.mp4') } }),
        positionals: ['stop'],
      },
      { ok: true, data: { recordingDestinationWarnings: peer, artifacts } },
      createTestHostEnvironment(),
      stateDir,
      controller.signal,
    ).then(
      (response) => (response.ok ? response.data : undefined),
      (error: unknown) => (error as AppError).details,
    );
    expect(result?.recordingDestinationWarnings).toBeUndefined();
    expect(result?.warnings).toBeUndefined();
  },
);
