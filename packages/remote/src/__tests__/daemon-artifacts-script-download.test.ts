import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import * as file from '@agent-device/host-kit/file';
import {
  FOREIGN_UID,
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  serveHostOwnership,
} from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { materializeRemoteArtifacts } from '../daemon-artifacts.ts';
import { sendRemoteScriptOpen } from '../session-script-destination.ts';

vi.mock('@agent-device/host-kit/file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/file')>();
  return { ...actual, publishFileSync: vi.fn(actual.publishFileSync) };
});

type Served = { body: string; broken?: boolean; endless?: boolean };
const servers: http.Server[] = [];

afterEach(async () => {
  vi.mocked(file.publishFileSync).mockClear();
  await Promise.all(servers.splice(0).map((server) => closeLoopbackServer(server)));
});

async function artifactServer(artifacts: Record<string, Served>): Promise<string> {
  const server = http.createServer((req, res) => {
    const artifact = artifacts[decodeURIComponent(req.url?.replace(/^\/+artifacts\//, '') ?? '')];
    if (!artifact) {
      res.writeHead(404).end();
      return;
    }
    if (artifact.endless) {
      res.writeHead(200);
      const write = () => {
        if (!res.destroyed) res.write(artifact.body, () => setImmediate(write));
      };
      write();
      return;
    }
    res.writeHead(200, { 'content-length': Buffer.byteLength(artifact.body) });
    if (!artifact.broken) {
      res.end(artifact.body);
      return;
    }
    res.flushHeaders();
    res.write(artifact.body.slice(0, 4));
    setImmediate(() => res.destroy());
  });
  servers.push(server);
  return `http://127.0.0.1:${await listenOnLoopback(server)}`;
}

function journey() {
  // The real path, so a destination names the same file the publication renames into place.
  const root = fs.realpathSync(mkdtempForTestSync('script-download-'));
  const stateDir = path.join(root, 'state');
  return { root, stateDir, destination: path.join(root, 'caller', 'journey.ad') };
}

function request(command: string, meta: DaemonWireRequest['meta'] = {}): DaemonWireRequest {
  return { token: 't', session: 'journey', command, positionals: [], meta };
}

function script(artifactId: string, revision: number, publicationId: string): DaemonArtifact {
  return {
    field: 'savedScript',
    artifactType: 'session-script',
    artifactId,
    scriptPublicationId: publicationId,
    scriptRevision: revision,
  };
}

function records(stateDir: string): string[] {
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((n) => n.endsWith('.json'))
    : [];
}

/** Answers a request the way the daemon does and materializes the answer like the client. */
function answer(
  baseUrl: string,
  stateDir: string,
  req: DaemonWireRequest,
  data: Record<string, unknown>,
): Promise<DaemonResponse> {
  const info = { baseUrl, token: 't' };
  return materializeRemoteArtifacts(
    info,
    req,
    { ok: true, data },
    createTestHostEnvironment(),
    stateDir,
  );
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

/** A remote `open --save-script`: the daemon arms the publication it is sent, with version 1. */
async function open(
  baseUrl: string,
  stateDir: string,
  destination: string,
  options: { force?: boolean; respond?: (id: string) => DaemonResponse } = {},
) {
  let sent: DaemonWireRequest | undefined;
  let recordsAtSend: string[] = [];
  const req = {
    ...request('open', { clientArtifactPaths: { savedScript: destination } }),
    flags: { saveScript: true, ...(options.force ? { force: true } : {}) },
  };
  const info = { baseUrl, token: 't', capabilities: ['script-artifacts'] };
  const response = await sendRemoteScriptOpen(info, req, stateDir, async (next) => {
    sent = next;
    recordsAtSend = records(stateDir);
    const id = next.meta?.scriptPublicationId as string;
    const reply = options.respond?.(id);
    if (reply) return reply;
    return answer(baseUrl, stateDir, next, {
      scriptPublicationId: id,
      artifacts: [script('v1', 1, id)],
    });
  });
  const id = sent?.meta?.scriptPublicationId as string;
  return { id, sent, recordsAtSend, response };
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

test('a version over the size cap keeps the previous one and leaves no staging', async () => {
  const { root, stateDir, destination } = journey();
  const baseUrl = await artifactServer({
    v1: { body: 'open Demo\n' },
    big: { body: 'x'.repeat(64 * 1024), endless: true },
  });
  const { id } = await open(baseUrl, stateDir, destination);

  await expect(
    answer(baseUrl, stateDir, request('click'), { artifacts: [script('big', 2, id)] }),
  ).resolves.toEqual(deliveryFailure('script_download_failed'));
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(fs.readdirSync(path.join(root, 'caller'))).toEqual(['journey.ad']);
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

test.each([
  { name: 'is the destination', matches: true, expected: 'v1\n' },
  { name: 'is another file', matches: false, expected: 'v4\n' },
])(
  'an interrupted version counts as published only when it $name',
  async ({ matches, expected }) => {
    const { stateDir, destination } = journey();
    const baseUrl = await artifactServer({ v1: { body: 'v1\n' }, v4: { body: 'v4\n' } });
    const { id } = await open(baseUrl, stateDir, destination);
    const [name] = records(stateDir);
    const recordFile = path.join(stateDir, 'remote-connections', 'session-scripts', name as string);
    const stat = fs.statSync(matches ? destination : recordFile, { bigint: true });
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    const staging = path.join(path.dirname(destination), '.agent-device-script-crashed');
    fs.mkdirSync(staging);
    const publishing = { revision: 5, file: `${stat.dev}:${stat.ino}`, staging };
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, publishing }));

    await answer(baseUrl, stateDir, request('click'), { artifacts: [script('v4', 4, id)] });

    expect(fs.readFileSync(destination, 'utf8')).toBe(expected);
    expect(fs.existsSync(staging)).toBe(false);
  },
);

test.each([
  { name: 'while it lists the staging directory', failingWrite: 1, kept: false },
  { name: 'before the record names the version', failingWrite: 2, kept: false },
  { name: 'after the link, while the record names it', failingWrite: 3, kept: true },
])(
  'a record write that fails $name keeps the staged file only while it is named',
  async ({ failingWrite, kept }) => {
    const { root, stateDir, destination } = journey();
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' }, v2: { body: 'v2\n' } });
    const actual = await vi.importActual<typeof import('@agent-device/host-kit/file')>(
      '@agent-device/host-kit/file',
    );
    let writes = 0;
    vi.mocked(file.publishFileSync).mockImplementation((options) => {
      // The record created before the open is write 0; the publish writes follow it: listing the
      // staging directory, naming the version, then recording its revision.
      if (options.destination.endsWith('.json') && writes++ === failingWrite) {
        throw new Error('record write failed');
      }
      actual.publishFileSync(options);
    });

    const { id, response } = await open(baseUrl, stateDir, destination);
    expect(response).toEqual(deliveryFailure('script_download_failed'));
    vi.mocked(file.publishFileSync).mockImplementation(actual.publishFileSync);
    const staging = () =>
      fs
        .readdirSync(path.join(root, 'caller'))
        .filter((n) => n.startsWith('.agent-device-script-'));
    expect(staging()).toHaveLength(kept ? 1 : 0);

    // The next version settles the interrupted one and reclaims its staging directory.
    await answer(baseUrl, stateDir, request('click'), { artifacts: [script('v2', 2, id)] });
    expect(fs.readFileSync(destination, 'utf8')).toBe('v2\n');
    expect(staging()).toEqual([]);
  },
);

test('creating a record removes records nobody touched for a week', async () => {
  const { stateDir, destination } = journey();
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  fs.mkdirSync(directory, { recursive: true });
  const stale = path.join(directory, 'stale.json');
  const fresh = path.join(directory, 'fresh.json');
  const staging = path.join(path.dirname(destination), '.agent-device-script-stale');
  fs.mkdirSync(staging, { recursive: true });
  const publishing = { revision: 1, file: '0:0', staging };
  const record = { destination, force: false, revision: 0, publishing, staging: [staging] };
  fs.writeFileSync(stale, JSON.stringify(record));
  fs.writeFileSync(fresh, '{}');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);

  await open('http://127.0.0.1:9', stateDir, destination, {
    respond: () => ({ ok: true, data: {} }),
  });

  expect(fs.existsSync(stale)).toBe(false);
  expect(fs.existsSync(staging)).toBe(false);
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

test.skipIf(process.platform === 'win32')(
  'a remote recording creates a missing parent in a sticky directory and publishes there',
  async () => {
    // `open --save-script /tmp/rec/journey.ad` with `rec` absent is the ordinary shape, and `/tmp` is
    // sticky. Judging the chain before the parent exists asks the question about `/tmp` and refuses a
    // recording the local writer accepts, so the parent is created first on both routes (#4565).
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-mkdir-'));
    const stateDir = path.join(root, 'state');
    const sticky = path.join(root, 'tmp');
    fs.mkdirSync(sticky);
    fs.chmodSync(sticky, 0o1777);
    const destination = path.join(sticky, 'recordings', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.not.objectContaining({ scriptDeliveryFailure: expect.anything() }),
      }),
    );
    expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses the ground a link target crosses on the way in',
  async () => {
    // `rec -> <root>/shared/relay/sub`, `shared` at 0777 and not sticky, `shared/relay -> <root>/chosen`.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-target-'));
    const stateDir = path.join(root, 'state');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    const chosen = path.join(root, 'chosen');
    fs.mkdirSync(chosen);
    fs.chmodSync(chosen, 0o700);
    fs.symlinkSync(chosen, path.join(shared, 'relay'));
    const sub = path.join(chosen, 'sub');
    fs.mkdirSync(sub);
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.symlinkSync(path.join(shared, 'relay', 'sub'), path.join(home, 'rec'));
    const destination = path.join(home, 'rec', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestor_untrusted' }),
        }),
      }),
    );
    expect(fs.readdirSync(sub)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a target spelled relative to the link that holds it',
  async () => {
    // `ln -s ../team/rec rec` is how a link is usually written. The target is resolved from the directory
    // that holds the link, so the walk leaves the home and crosses `shared` at 0777 on the way in.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-relative-'));
    const stateDir = path.join(root, 'state');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    const team = path.join(shared, 'team');
    fs.mkdirSync(team);
    const chosen = path.join(root, 'chosen');
    fs.mkdirSync(chosen);
    fs.chmodSync(chosen, 0o700);
    fs.symlinkSync(chosen, path.join(team, 'rec'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.symlinkSync(path.join('..', 'shared', 'team', 'rec'), path.join(home, 'rec'));
    const destination = path.join(home, 'rec', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestor_untrusted' }),
        }),
      }),
    );
    expect(fs.readdirSync(chosen)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording stages inside the directory the entry is created in',
  async () => {
    // `home/work -> priv/x`, `priv/y` private, `home/y` at 0777. The entry lands in `priv/y`, but the
    // spelled parent folds to `home`, so staging beside the spelled parent downloads the version into a
    // directory the ancestry walk never judged as the entry's, and moves it in by a rename that is no
    // longer within one directory.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-staging-'));
    const stateDir = path.join(root, 'state');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o700);
    const sharedY = path.join(home, 'y');
    fs.mkdirSync(sharedY);
    fs.chmodSync(sharedY, 0o777);
    const privX = path.join(root, 'priv', 'x');
    fs.mkdirSync(privX, { recursive: true });
    const privY = path.join(root, 'priv', 'y');
    fs.mkdirSync(privY);
    fs.chmodSync(privY, 0o700);
    fs.symlinkSync(privX, path.join(home, 'work'));
    const destination = `${home}/work/../y/journey.ad`;
    const created: string[] = [];
    const realMkdtempSync = fs.mkdtempSync;
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(((template: string, ...rest: unknown[]) => {
      created.push(path.dirname(template));
      return (realMkdtempSync as (...args: unknown[]) => unknown)(template, ...rest);
    }) as typeof fs.mkdtempSync);
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(expect.objectContaining({ ok: true }));
    expect(created).toEqual([privY]);
    expect(fs.readdirSync(sharedY)).toEqual([]);
    expect(fs.readFileSync(path.join(privY, 'journey.ad'), 'utf8')).toContain('open Demo');
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a link another local user owns on the way in',
  async () => {
    // `~/rec -> <root>/tmp/relay -> ~/chosen`, `relay` another user's file in a sticky shared directory.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-hopowner-'));
    const stateDir = path.join(root, 'state');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const chosen = path.join(root, 'chosen');
    fs.mkdirSync(chosen);
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(tmp);
    fs.chmodSync(tmp, 0o1777);
    const relay = path.join(tmp, 'relay');
    fs.symlinkSync(chosen, relay);
    fs.symlinkSync(relay, path.join(home, 'rec'));
    serveHostOwnership({ [relay]: FOREIGN_UID });
    const destination = path.join(home, 'rec', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestor_untrusted' }),
        }),
      }),
    );
    expect(fs.readdirSync(chosen)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses the directory a .. steps back into',
  async () => {
    // `home/work -> priv/x`, `priv/y` at 0777: the write lands in `priv/y`, not in the `home/y` the
    // normalized spelling names.
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-dotdot-'));
    const stateDir = path.join(root, 'state');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const priv = path.join(root, 'priv');
    const privX = path.join(priv, 'x');
    fs.mkdirSync(privX, { recursive: true });
    const privY = path.join(priv, 'y');
    fs.mkdirSync(privY);
    fs.chmodSync(privY, 0o777);
    fs.symlinkSync(privX, path.join(home, 'work'));
    const destination = `${home}/work/../y/journey.ad`;
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestor_untrusted' }),
        }),
      }),
    );
    expect(fs.readdirSync(privY)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a private link standing on shared ground two levels up',
  async () => {
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-traverse-'));
    const stateDir = path.join(root, 'state');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o777);
    const mine = path.join(shared, 'mine');
    fs.mkdirSync(mine);
    fs.chmodSync(mine, 0o700);
    const privateWork = path.join(root, 'private');
    fs.mkdirSync(privateWork);
    fs.symlinkSync(privateWork, path.join(mine, 'rec'));
    const destination = path.join(mine, 'rec', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({
            cause: 'script_ancestor_untrusted',
          }),
        }),
      }),
    );
    expect(fs.readdirSync(privateWork)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a chain that leaves a shared directory through a link',
  async () => {
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-relay-'));
    const stateDir = path.join(root, 'state');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const team = path.join(root, 'srv', 'team');
    fs.mkdirSync(team, { recursive: true });
    fs.chmodSync(team, 0o777);
    const chosen = path.join(root, 'chosen');
    fs.mkdirSync(chosen);
    fs.chmodSync(chosen, 0o700);
    fs.symlinkSync(chosen, path.join(team, 'relay'));
    fs.symlinkSync(path.join(team, 'relay'), path.join(home, 'rec'));
    const destination = path.join(home, 'rec', 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

    const { response } = await open(baseUrl, stateDir, destination);

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({
            cause: 'script_ancestor_untrusted',
          }),
        }),
      }),
    );
    expect(fs.readdirSync(chosen)).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32').each([
  {
    name: 'a symbolic link planted where the script should land',
    plant: (root: string) => {
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      const attacker = path.join(root, 'attacker');
      fs.mkdirSync(attacker);
      fs.symlinkSync(attacker, path.join(shared, 'work'));
      return {
        destination: path.join(shared, 'work', 'journey.ad'),
        untouched: attacker,
      };
    },
  },
  {
    name: 'a world-writable directory',
    plant: (root: string) => {
      const shared = path.join(root, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      return { destination: path.join(shared, 'journey.ad'), untouched: shared };
    },
  },
])('a remote recording refuses a destination under $name', async ({ plant }) => {
  const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-'));
  const stateDir = path.join(root, 'state');
  const { destination, untouched } = plant(root);
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });

  const { response } = await open(baseUrl, stateDir, destination);

  expect(response).toEqual(
    expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        scriptDeliveryFailure: expect.objectContaining({
          cause: 'script_ancestor_untrusted',
        }),
      }),
    }),
  );
  expect(fs.existsSync(destination)).toBe(false);
  expect(fs.readdirSync(untouched)).toEqual([]);
});

test.skipIf(process.platform === 'win32')(
  'a remote recording refuses a destination whose directory was swapped while the version downloaded',
  async () => {
    const root = fs.realpathSync(mkdtempForTestSync('script-ancestry-'));
    const stateDir = path.join(root, 'state');
    const work = path.join(root, 'work');
    fs.mkdirSync(work);
    const destination = path.join(work, 'journey.ad');
    const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });
    const realOpen = fs.promises.open.bind(fs.promises);
    // The replacement is a private directory, so only the parent's identity can catch it. The swap
    // happens once the staged file is open: after the parent's identity was captured.
    const spyOpen = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...rest) => {
      const handle = await realOpen(file as never, ...(rest as unknown as never[]));
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work);
      return handle;
    });

    let response: DaemonResponse;
    try {
      response = (await open(baseUrl, stateDir, destination)).response;
    } finally {
      spyOpen.mockRestore();
    }

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        data: expect.objectContaining({
          scriptDeliveryFailure: expect.objectContaining({ cause: 'script_ancestry_replaced' }),
        }),
      }),
    );
    expect(fs.readdirSync(work)).toEqual([]);
  },
);

test('retiring a record removes the staging a crashed download left behind', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const [name] = records(stateDir);
  const recordFile = path.join(stateDir, 'remote-connections', 'session-scripts', name as string);
  const crashed = path.join(path.dirname(destination), '.agent-device-script-crashed');
  fs.mkdirSync(crashed);
  fs.writeFileSync(path.join(crashed, 'script.ad'), 'partial');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, staging: [crashed] }));

  await answer(baseUrl, stateDir, request('close'), { scriptPublicationId: id });

  expect(fs.existsSync(crashed)).toBe(false);
  expect(records(stateDir)).toEqual([]);
});

test('a retirement that fails midway never leaves the record naming a removed anchor', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const [name] = records(stateDir);
  const recordFile = path.join(stateDir, 'remote-connections', 'session-scripts', name as string);
  const staging = path.join(path.dirname(destination), '.agent-device-script-pending');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'script.ad.anchor'), 'pending');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const publishing = { revision: 2, file: '1:2', staging };
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, publishing, staging: [staging] }));
  const realRm = fs.rmSync;
  const rm = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (String(target) === recordFile) throw new Error('record removal failed');
    realRm(target, options);
  });

  try {
    await answer(baseUrl, stateDir, request('close'), { scriptPublicationId: id });
  } finally {
    rm.mockRestore();
  }

  expect(fs.existsSync(staging)).toBe(false);
  expect(JSON.parse(fs.readFileSync(recordFile, 'utf8')).publishing).toBeUndefined();
});

test('a close whose staging cannot be removed still ends the record before a delayed version', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' }, v3: { body: 'forged\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const [name] = records(stateDir);
  const recordFile = path.join(stateDir, 'remote-connections', 'session-scripts', name as string);
  const stuck = path.join(path.dirname(destination), '.agent-device-script-stuck');
  fs.mkdirSync(stuck);
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, staging: [stuck] }));
  const realRm = fs.rmSync;
  const rm = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (String(target) === stuck) throw new Error('staging removal failed');
    realRm(target, options);
  });

  let closed: DaemonResponse;
  try {
    closed = await answer(baseUrl, stateDir, request('close'), { scriptPublicationId: id });
  } finally {
    rm.mockRestore();
  }
  const delayed = await answer(baseUrl, stateDir, request('snapshot'), {
    artifacts: [script('v3', 3, id)],
  });

  expect(closed).toEqual({ ok: true, data: { scriptPublicationId: id } });
  expect(delayed).toMatchObject({ ok: true });
  expect(delayed.ok && delayed.data?.savedScript).toBeFalsy();
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
  expect(fs.existsSync(stuck)).toBe(true);
  expect(JSON.parse(fs.readFileSync(recordFile, 'utf8'))).toMatchObject({ retired: true });
});

test('a close that cannot mark its record retired removes the record instead', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' }, v3: { body: 'forged\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const [name] = records(stateDir);
  const recordFile = path.join(stateDir, 'remote-connections', 'session-scripts', name as string);
  const staging = path.join(path.dirname(destination), '.agent-device-script-listed');
  fs.mkdirSync(staging);
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, staging: [staging] }));
  const publish = vi.mocked(file.publishFileSync);
  const realPublish = publish.getMockImplementation();
  publish.mockImplementation((options) => {
    if (String(options.contents).includes('"retired"')) throw new Error('record write failed');
    return realPublish?.(options);
  });

  let closed: DaemonResponse;
  try {
    closed = await answer(baseUrl, stateDir, request('close'), { scriptPublicationId: id });
  } finally {
    publish.mockImplementation(realPublish as typeof file.publishFileSync);
  }
  const delayed = await answer(baseUrl, stateDir, request('snapshot'), {
    artifacts: [script('v3', 3, id)],
  });

  expect(closed).toEqual({ ok: true, data: { scriptPublicationId: id } });
  expect(records(stateDir)).toEqual([]);
  expect(fs.existsSync(staging)).toBe(false);
  expect(delayed.ok && delayed.data?.savedScript).toBeFalsy();
  expect(fs.readFileSync(destination, 'utf8')).toBe('open Demo\n');
});

test('the next open removes a record a close left retired', async () => {
  const { stateDir, destination } = journey();
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  fs.mkdirSync(directory, { recursive: true });
  const stuck = path.join(path.dirname(destination), '.agent-device-script-stuck');
  fs.mkdirSync(stuck, { recursive: true });
  const retired = path.join(directory, 'retired.json');
  fs.writeFileSync(
    retired,
    JSON.stringify({ destination, force: false, revision: 1, staging: [stuck], retired: true }),
  );

  await open('http://127.0.0.1:9', stateDir, destination, {
    respond: (id) => ({ ok: true, data: { scriptPublicationId: id } }),
  });

  expect(fs.existsSync(retired)).toBe(false);
  expect(fs.existsSync(stuck)).toBe(false);
});

test('a record that can be neither retired nor removed keeps the anchor it names and loses other staging', async () => {
  const { stateDir, destination } = journey();
  const baseUrl = await artifactServer({ v1: { body: 'open Demo\n' } });
  const { id } = await open(baseUrl, stateDir, destination);
  const [name] = records(stateDir);
  const recordFile = path.join(stateDir, 'remote-connections', 'session-scripts', name as string);
  const staging = path.join(path.dirname(destination), '.agent-device-script-listed');
  fs.mkdirSync(staging);
  const anchored = path.join(path.dirname(destination), '.agent-device-script-anchored');
  fs.mkdirSync(anchored);
  fs.writeFileSync(path.join(anchored, 'script.ad.anchor'), 'pending');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const publishing = { revision: 2, file: '1:2', staging: anchored };
  fs.writeFileSync(
    recordFile,
    JSON.stringify({ ...record, publishing, staging: [staging, anchored] }),
  );
  const publish = vi.mocked(file.publishFileSync);
  const realPublish = publish.getMockImplementation();
  publish.mockImplementation((options) => {
    if (String(options.contents).includes('"retired"')) throw new Error('record write failed');
    return realPublish?.(options);
  });
  const realRm = fs.rmSync;
  const rm = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (String(target) === recordFile) throw new Error('record removal failed');
    realRm(target, options);
  });

  let closed: DaemonResponse;
  try {
    closed = await answer(baseUrl, stateDir, request('close'), { scriptPublicationId: id });
  } finally {
    rm.mockRestore();
    publish.mockImplementation(realPublish as typeof file.publishFileSync);
  }

  expect(closed).toEqual({ ok: true, data: { scriptPublicationId: id } });
  expect(fs.existsSync(staging)).toBe(false);
  expect(fs.existsSync(path.join(anchored, 'script.ad.anchor'))).toBe(true);
  expect(records(stateDir)).toHaveLength(1);
});

test('a stale record that cannot be swept never blocks a new open', async () => {
  const { stateDir, destination } = journey();
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  fs.mkdirSync(directory, { recursive: true });
  const stale = path.join(directory, 'stale.json');
  const stuck = path.join(path.dirname(destination), '.agent-device-script-stuck');
  fs.mkdirSync(stuck, { recursive: true });
  fs.writeFileSync(
    stale,
    JSON.stringify({ destination, force: false, revision: 0, staging: [stuck] }),
  );
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);
  const realRm = fs.rmSync;
  const rm = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (String(target) === stuck) throw new Error('staging removal failed');
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
